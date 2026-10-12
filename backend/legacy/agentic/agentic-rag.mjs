import "dotenv/config";
import {
    ChatOpenAI,
    OpenAIEmbeddings
} from "@langchain/openai";
import {
    Annotation,
    END,
    START,
    StateGraph
} from "@langchain/langgraph";
import {Milvus} from "@langchain/community/vectorstores/milvus";
import {z} from "zod";

const COLLECTION_NAME = "ebook_collection";
const MAX_WEB_SEARCHES = 2;

const model = new ChatOpenAI({
    model: process.env.MODEL_NAME,
    temperature: 0,
    configuration: {
        baseURL: process.env.OPENAI_BASE_URL
    },
    apiKey: process.env.OPENAI_API_KEY
});

const embeddings = new OpenAIEmbeddings({
    model: process.env.EMBEDDINGS_MODEL_NAME,
    dimensions: 1024,
    configuration: {
        baseURL: process.env.OPENAI_BASE_URL
    },
    apiKey: process.env.OPENAI_API_KEY
});

const GraphState = Annotation.Root({
    question: Annotation,
    k: Annotation,

    strategy: Annotation,
    routeReason: Annotation,

    subQuestions: Annotation,
    nextSubIdx: Annotation,
    currentQuery: Annotation,

    retrievalCount: Annotation,
    maxRetrievals: Annotation,

    documents: Annotation,
    localContext: Annotation,

    webContext: Annotation,
    webSearchCount: Annotation,

    evaluation: Annotation,
    generation: Annotation
});

let vectorStore;

// route 先区分是否需要知识库，让简单问题不必进入后续 RAG 流程。
const RouteSchema = z.object({
    strategy: z.enum(["simple", "complex"]),
    reason: z.string()
});

const DecomposeSchema = z.object({
    sub_questions: z.array(z.string()).min(1).max(8),
    reason: z.string()
});

// 这里把原 planNextStep 与 evaluateContext 的职责合并为一个三选一决策。
const EvaluateSchema = z.object({
    nextAction: z.enum(["retrieve", "web_search", "generate"]),
    missing: z.array(z.string()).max(6),
    reason: z.string(),
    web_query: z.string().optional()
});

async function retrieveRelevantContent(question, k = 5){
    try{
        const docsWithScores = await vectorStore.similaritySearchWithScore(question, k);
        return docsWithScores.map(([doc, score]) => ({
            score,
            content: doc.pageContent,
            id: doc.metadata?.id ?? "unknown",
            book_id: doc.metadata?.book_id ?? "未知",
            chapter_num: doc.metadata?.chapter_num ?? "未知",
            index: doc.metadata?.index ?? "未知"
        }));
    }catch(err){
        console.error("检索内容时出错：", err.message);
        return [];
    }
}

const routeQuestionNode = async (state) => {
    console.log("____ROUTE_QUESTION____");
    const router = model.withStructuredOutput(RouteSchema);
    const route = await router.invoke(`
        你是问答路由器，请判断用户问题是否需要外部检索。
        规则：
        - simple: 常识问答、简短定义、无需特定小说细节即可回答
        - complex: 需要《天龙八部》具体情节、人物关系、章节事实、原文细节或证据支持

        用户问题：${state.question}
    `);

    console.log(`路由策略：${route.strategy}（${route.reason}）`);
    return {
        strategy: route.strategy,
        routeReason: route.reason,
        subQuestions: [],
        nextSubIdx: 0,
        currentQuery: "",
        retrievalCount: 0,
        maxRetrievals: state.maxRetrievals ?? 8,
        documents: [],
        localContext: "",
        webContext: "",
        webSearchCount: 0,
        evaluation: "",
        generation: ""
    };
};

const directAnswerNode = async (state) => {
    console.log("____DIRECT_ANSWER____");
    process.stdout.write("\n[AI 回答（流式）]\n");
    let generation = "";
    const stream = await model.stream(`
        你是一个中文回答助手，请直接、简洁地回答问题。

        问题：${state.question}
    `);

    for await (const chunk of stream){
        const text = typeof chunk.content === "string" ? chunk.content : "";
        if(!text) continue;
        generation += text;
        process.stdout.write(text);
    }
    process.stdout.write("\n");
    return {generation};
};

const decomposeQuestionNode = async (state) => {
    console.log("____DECOMPOSE_QUESTION____");
    const decomposer = model.withStructuredOutput(DecomposeSchema);
    const out = await decomposer.invoke(`
        你是《天龙八部》多跳问答的子问题拆解器。
        用户原始问题：
        ${state.question}

        任务：将问题拆分成有序的子问题列表 sub_questions，用于依次向量检索。
        要求：
        1. 链式推理、多层关系、因果先后的问题，必须拆成多条；单跳问题允许只输出 1 条。
        2. 每条子问题必须是可独立检索的完整中文问句，禁止使用“他、她、此人、上文”等指代，可写全人物名与事件名。
        3. 顺序必须符合推理链：先查清前置实体或事实，再查后续结论。
        4. 不要把整句原题原样复制成唯一一条，除非确实无法拆分；不要拆成过碎的关键词列表。
        5. 输出 1～8 条。

        请输出 sub_questions 与简短 reason。
    `);

    const subQuestions = out.sub_questions.map((item) => item.trim()).filter(Boolean);
    if(subQuestions.length === 0){
        throw new Error("decomposeQuestion: subQuestions 为空");
    }

    console.log(`拆解为 ${subQuestions.length} 条子问题（${out.reason}）`);
    subQuestions.forEach((question, index) => {
        console.log(`[${index + 1}] ${question}`);
    });

    // 复杂问题先拆解，是为了让每条查询都能独立命中对应事实，并按顺序积累证据。
    return {
        subQuestions,
        nextSubIdx: 0,
        currentQuery: subQuestions[0]
    };
};

const mergeUnique = (existingDocs, newDocs) => {
    const map = new Map();
    for(const doc of [...existingDocs, ...newDocs]){
        const key = String(doc.id);
        const previous = map.get(key);
        if(!previous || Number(doc.score) > Number(previous.score)){
            map.set(key, doc);
        }
    }

    // 多轮检索容易反复命中同一片段；去重可避免重复内容被模型误认为是额外证据。
    return Array.from(map.values())
        .sort((a, b) => Number(b.score) - Number(a.score));
};

const buildLocalContext = (documents) => documents.map((item, index) => `
本地片段：${index + 1}
score：${Number(item.score).toFixed(4)}
章节：第${item.chapter_num}章
index：${item.index}
内容：${item.content}
    `.trim()).join("\n\n---------\n\n");

const retrieveNode = async (state) => {
    console.log("____RETRIEVE____");
    const subQuestions = state.subQuestions ?? [];
    const index = state.nextSubIdx ?? 0;
    const question = subQuestions[index]?.trim();

    if(!question){
        throw new Error(`retrieve: 子问题下标 ${index} 无有效文本（共 ${subQuestions.length} 条）`);
    }

    const retrievalCount = (state.retrievalCount ?? 0) + 1;
    console.log(`第 ${retrievalCount} 轮，检索子问题 ${index + 1}/${subQuestions.length}：${question}`);

    // 一次只检索一个子问题，便于观察每轮证据如何累积，也让下一步评估决定是否有必要继续。
    const newDocs = await retrieveRelevantContent(question, state.k);
    const documents = mergeUnique(state.documents ?? [], newDocs);
    const localContext = buildLocalContext(documents);

    if(newDocs.length === 0){
        console.log("本轮未命中文档");
    }else{
        console.log(`本轮命中 ${newDocs.length} 条，累计去重后 ${documents.length} 条`);
        newDocs.forEach((item, itemIndex) => {
            const preview = item.content.length > 120
                ? `${item.content.substring(0, 120)}...`
                : item.content;
            console.log(`[${itemIndex + 1}] score=${Number(item.score).toFixed(4)} chapter=${item.chapter_num} index=${item.index}`);
            console.log(preview);
        });
    }

    return {
        documents,
        localContext,
        retrievalCount,
        nextSubIdx: index + 1,
        currentQuery: question
    };
};

const evaluateNode = async (state) => {
    console.log(state.webSearchCount > 0
        ? "____EVALUATE_CONTEXT_WITH_WEB____"
        : "____EVALUATE_LOCAL_CONTEXT____");

    const subQuestions = state.subQuestions ?? [];
    const nextSubIdx = state.nextSubIdx ?? 0;
    const remaining = Math.max(0, subQuestions.length - nextSubIdx);
    const canRetrieve = remaining > 0 && state.retrievalCount < state.maxRetrievals;
    const canWebSearch = (state.webSearchCount ?? 0) < MAX_WEB_SEARCHES;
    const subQuestionList = subQuestions.map((question, index) => {
        const status = index < nextSubIdx ? "已检索" : "未检索";
        return `${index + 1}. ${question}（${status}）`;
    }).join("\n");

    const evaluator = model.withStructuredOutput(EvaluateSchema);
    const out = await evaluator.invoke(`
        你是多跳 RAG 的信息充分性评估器，同时负责规划下一步。
        每轮本地检索后都必须评估，因为已经召回的证据可能足够，不必机械地检索完所有子问题。

        用户原始问题：${state.question}

        子问题序列：
        ${subQuestionList || "(无)"}

        已完成本地检索轮数：${state.retrievalCount}
        剩余未检索子问题：${remaining}
        最大本地检索轮数：${state.maxRetrievals}
        当前是否还能本地检索：${canRetrieve}
        已联网搜索次数：${state.webSearchCount ?? 0}
        最大联网搜索次数：${MAX_WEB_SEARCHES}
        当前是否还能联网搜索：${canWebSearch}

        本地知识库上下文：
        ${state.localContext || "(空)"}

        联网搜索上下文：
        ${state.webContext || "(空)"}

        请只选择一个 nextAction：
        1. retrieve：信息不足，而且还有未检索子问题且未达到本地检索上限。下一轮会自动检索下一条子问题，不要自拟新的本地检索问题。
        2. web_search：本地知识仍不足，并且缺失信息适合从互联网补充，同时尚未达到联网次数上限。
        3. generate：信息已经足够，或现有检索条件下已经不能再继续获取信息。

        同时输出：
        - missing：仍缺少的信息，最多 6 条
        - reason：简短原因
        - web_query：选择 web_search 时给出一个完整的中文联网查询句，否则可以为空
    `);

    let nextAction = out.nextAction;

    // 代码层面的计数限制优先于模型决定，防止本地检索或联网搜索形成无限循环。
    if(nextAction === "retrieve" && !canRetrieve){
        nextAction = "generate";
    }
    if(nextAction === "web_search" && !canWebSearch){
        nextAction = "generate";
    }

    const evaluation = {
        ...out,
        nextAction
    };

    console.log(`[决策] ${nextAction}（模型建议=${out.nextAction}，${out.reason}）`);
    if(out.missing?.length){
        out.missing.forEach((item, index) => {
            console.log(`缺失 ${index + 1}：${item}`);
        });
    }

    return {
        evaluation: JSON.stringify(evaluation)
    };
};

async function bochaWebSearch(query, count){
    const apiKey = process.env.BOCHA_API_KEY;
    if(!apiKey){
        throw new Error("Bocha Web Search 的 API KEY 未配置或已失效");
    }

    const url = "https://api.bochaai.com/v1/web-search";
    const body = {
        query,
        freshness: "noLimit",
        summary: true,
        count: count ?? 10
    };

    let response;
    try{
        response = await fetch(url, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
        });
    }catch(err){
        throw new Error(`搜索 API 请求失败（网络错误）：${err.message}`);
    }

    if(!response.ok){
        const errorText = await response.text().catch(() => "");
        throw new Error(`搜索 API 请求失败，状态码：${response.status}，错误信息：${errorText}`);
    }

    let json;
    try{
        json = await response.json();
    }catch(err){
        throw new Error(`搜索结果解析失败：${err.message}`);
    }

    const webPages = json.data?.webPages?.value ?? [];
    if(!webPages.length){
        return "未找到相关结果";
    }

    return webPages.map((page, index) => `
引用：${index + 1}
标题：${page.name}
URL：${page.url}
摘要：${page.summary}
网站名称：${page.siteName}
网站图标：${page.siteIcon}
发布时间：${page.dateLastCrawled}
    `.trim()).join("\n\n");
}

const webSearchNode = async (state) => {
    console.log("____WEB_SEARCH____");
    const parsed = (() => {
        try{
            return JSON.parse(state.evaluation || "{}");
        }catch{
            return {};
        }
    })();

    const query = (parsed.web_query ?? "").trim() || state.question;
    const webSearchCount = (state.webSearchCount ?? 0) + 1;
    console.log(`第 ${webSearchCount} 次联网查询：${query}`);

    const newWebContext = await bochaWebSearch(query, 8);
    const webContext = [
        state.webContext,
        `第 ${webSearchCount} 次联网搜索\n查询：${query}\n${newWebContext}`
    ].filter(Boolean).join("\n\n=========\n\n");

    console.log(`本次联网结果长度：${newWebContext.length}`);
    return {
        webContext,
        webSearchCount
    };
};

const generateNode = async (state) => {
    console.log("____GENERATE____");
    const context = [
        state.localContext,
        state.webContext
    ].filter(Boolean).join("\n\n--- 联网补充 ---\n\n");

    process.stdout.write("\n[AI 回答（流式）]\n");
    let generation = "";

    // 子问题只服务于检索，最终必须回到用户最开始提出的完整问题。
    const stream = await model.stream(`
        你是一个严谨的中文问答助手。
        请优先依据给定上下文回答，不要编造。

        上下文（本地知识库 + 可选联网补充）：
        ${context || "(空)"}

        用户最开始的问题：${state.question}

        回答要求：
        1. 综合本地小说片段和联网搜索结果，回答用户最开始的完整问题，不要只回答某个子问题。
        2. 如果上下文足够，给出清晰、可核对的回答；需要时引用小说片段或联网结果中的 URL。
        3. 如果上下文仍不足以确定关键信息，明确说明无法从当前上下文确认，并指出缺失点。
        4. 不要编造，不要输出表情符号。

        回答：
    `);

    for await (const chunk of stream){
        const text = typeof chunk.content === "string" ? chunk.content : "";
        if(!text) continue;
        generation += text;
        process.stdout.write(text);
    }
    process.stdout.write("\n");

    return {generation};
};

const afterRoute = (state) => (
    state.strategy === "simple" ? "direct_answer" : "decompose_question"
);

const afterEvaluate = (state) => {
    try{
        return JSON.parse(state.evaluation || "{}").nextAction ?? "generate";
    }catch{
        return "generate";
    }
};

const graph = new StateGraph(GraphState)
    .addNode("routeQuestion", routeQuestionNode)
    .addNode("directAnswer", directAnswerNode)
    .addNode("decomposeQuestion", decomposeQuestionNode)
    .addNode("retrieve", retrieveNode)
    .addNode("evaluate", evaluateNode)
    .addNode("webSearch", webSearchNode)
    .addNode("generate", generateNode)
    .addEdge(START, "routeQuestion")
    .addConditionalEdges("routeQuestion", afterRoute, {
        direct_answer: "directAnswer",
        decompose_question: "decomposeQuestion"
    })
    .addEdge("directAnswer", END)
    .addEdge("decomposeQuestion", "retrieve")
    .addEdge("retrieve", "evaluate")
    .addConditionalEdges("evaluate", afterEvaluate, {
        retrieve: "retrieve",
        web_search: "webSearch",
        generate: "generate"
    })
    // 联网后不直接生成，回到 evaluate 再判断；webSearchCount 会限制最多联网两次。
    .addEdge("webSearch", "evaluate")
    .addEdge("generate", END)
    .compile();

async function main(){
    const question = `请回答《天龙八部》小说里“雁门关事件”主谋是谁，并说明其儿子的最终结局。
    另外请补充：在《天龙八部》2013 版电视剧中，这段“雁门关”主要出现在哪几集？
    请给出可核对的来源链接。`;
    const k = 8;
    const maxRetrievals = 8;

    console.log("连接到 Milvus......");
    vectorStore = await Milvus.fromExistingCollection(embeddings, {
        collectionName: COLLECTION_NAME,
        url: process.env.MILVUS_ADDRESS,
        textField: "content",
        primaryField: "id",
        vectorField: "vector",
        indexCreateOptions: {
            metric_type: "COSINE",
            index_type: "HNSW",
            params: {M: 16, efConstruction: 200},
            search_params: {ef: 64}
        }
    });

    try{
        await vectorStore.client.loadCollection({
            collection_name: COLLECTION_NAME
        });
        console.log(`集合 ${COLLECTION_NAME} 已加载`);
    }catch(error){
        if(!error.message.includes("already loaded")){
            throw error;
        }
        console.log(`集合 ${COLLECTION_NAME} 已处于加载状态`);
    }

    const result = await graph.invoke({
        question,
        k: Number.isFinite(k) ? k : 5,
        strategy: "",
        routeReason: "",
        subQuestions: [],
        nextSubIdx: 0,
        currentQuery: "",
        retrievalCount: 0,
        maxRetrievals,
        documents: [],
        localContext: "",
        webContext: "",
        webSearchCount: 0,
        evaluation: "",
        generation: ""
    });

    console.log("\n--- 最终状态 ---");
    console.log("问题：", result.question);
    console.log("策略：", result.strategy);
    console.log("本地检索轮数：", result.retrievalCount);
    console.log("联网搜索次数：", result.webSearchCount);
    console.log("累计去重文档数：", result.documents.length);
    console.log("回答长度：", result.generation.length);
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
