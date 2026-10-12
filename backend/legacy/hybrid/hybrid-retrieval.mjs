// hybrid？ ssr 水合 nextjs
import "dotenv/config";
import { Client } from "@elastic/elasticsearch";
import { Document } from "@langchain/core/documents";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { Milvus } from "@langchain/community/vectorstores/milvus";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { DashScopeRerank } from "./dashscope-rerank.mjs"; 
import { augmentQuery, retrievalQueryString } from "./query-augment.mjs";
import { config } from "zod";

const INDEX = "life_notes";
const esClient = new Client({node: "http://localhost:9200"});
const embeddings = new OpenAIEmbeddings({
    model: process.env.EMBEDDINGS_MODEL_NAME,
    apiKey: process.env.OPENAI_API_KEY,
    configuration:{
        baseURL: process.env.OPENAI_BASE_URL
    }
});
const milvus = await Milvus.fromExistingCollection(embeddings,{
    url: "localhost:19530",
    collectionName: INDEX,
    textField: "doc_text",
    vectorField: "embedding"
});
const reranker = new DashScopeRerank({
    apiKey: process.env.OPENAI_API_KEY,
    model:process.env.RERANK_MODEL,
    topN: 3,
    baseUrl: process.env.RERANK_URL
});
const chatModel = new ChatOpenAI({
    model: process.env.MODEL_NAME ?? "qwen-turbo",
    apiKey: process.env.OPENAI_API_KEY,
    temperature: 0.2,
    configuration:{
        baseURL: process.env.OPENAI_BASE_URL
    }
})


const HybridRetrievalState = Annotation.Root({
    query: Annotation(),
    queryAugmentation: Annotation(),
    esHits: Annotation(),
    milvusHits: Annotation(),
    merged: Annotation(),
    topDocuments: Annotation(),
    answer: Annotation()
});

// 接受ES查询结果，拼接字符串
function docFromEsHit(hit){
    const s = hit._source ?? {};
    const text = [s.note_title ?? s.title, s.note_body ?? s.content]
    .filter(Boolean)
    .join("\n");
    return new Document({
        pageContent: text,
        metadata: {id: hit. _id, source: "es", ...s}
    })
}

// id关联 MySQL,Milvus,ES
// 合并的函数
function merge(esDocs, milvusDocs){
    const combinded = [...(esDocs ?? []),...(milvusDocs ?? [])]
    .filter(d => d?.pageContent);
    return dedupeDocsById(combinded);
}

function dedupeDocsById(docs){
    const seen = new Set();
    const output = [];
    for(const d of docs ?? []){
        if(!d?.pageContent) continue;
        const id = d.metadata.id != null ? String(d.metadata.id).trim() : "";
        if(!id) continue;
        if(seen.has(id)) continue;
        seen.add(id);
        output.push(d);
    }
    return output;
}

function printDocs(label,docs){
    console.log(`\n===${label}(${docs?.length??0}条)===]`);
    for(let i = 0; i < (docs ?? []).length; i++){
        const d = docs[i];
        const preview = (d.pageContent ?? "").slice(0,200).replace(/\n/g," ");
        console.log(`[${i}] ${preview}${d.pageContent ?.length > 200 ? "..." : ""} `);
        console.log(`metadata :`, d.metadata ?? {});
    }
}

function printQueryRewrite(original, augumentation){
    const qs = augumentation.queries ?? [];
    const forRetrieval = retrievalQueryString(original, augumentation);
    console.log(`\n----查询扩展(LLM生成${qs.length}条)`);
}

function stringifyMessagecontent(content){ chatModel
    if(typeof content === "string") return content;
    if(!Array.isArray(content)) return String(content ?? "");
    return content.map(c => typeof c === "string" ? c:typeof c?.text === "string" ? c.text :"").join("");
}

function formatDocsAsContext(docs){
    return (docs ?? []).map((d, i) => {
        const meta = d.metadata ?? {};
        const src = meta.source ?? ""; //来源
        const id = meta.id != null ? String(meta.id) : "";
        const head = id ? `[${i+1}] id = ${id} ${src ? `source=${src}` :""}`: `[${i+1}]`;
        return `${head}\n${d.pageContent ?? ""}`;
    }).join("\n\n----\n\n");
}

const ANSWER_PROMPT = ChatPromptTemplate.fromMessages([
    [
    "system",
    `你是阅读用户[生活笔记]知识库并作回答的助手。
        规则：
        - 只根据下方[检索片段]推断答案，片段里没有的信息不要编造。
        - 若片段里不足以回答问题，明确说明[笔记里没提到]，并可给出一句保守建议。
        - 回答借鉴有条理，可使用简短列表，口吻自然中文。
    `
    ],
    [
        "human",
        `用户问题: {query}
        检索片段: {context}
        `
    ]
]);

const NO_CONTEXT_PROMPT = ChatPromptTemplate.fromMessages([
    [
        "system",
        `你是阅读用户[生活笔记]知识库并作回答的助手。当前没有检索到任何片段。
        请用一两句话说明无法从笔记中回答并礼貌询问是否换个说法或补充关键词。
        `
    ],
    [
        "human",
        `用户问题： {query}`
    ]
])

export function compileHybridretrievalGraph(esClient, milvus, reranker, chatModel){
    const ES_K = 15;
    const MILVUS_K = 15;
    return new StateGraph(HybridRetrievalState)
        .addNode("query_augment", async (state) => ({
            queryAugmentation: await augmentQuery(chatModel, state.query ?? "")
        }))
        .addNode("es_recall",async(state) => {
            const qs = retrievalQueryString(state.query, state.queryAugmentation);
            const n = Math.max(1, qs.length);
            const kEach = Math.max(2, Math.ceil(ES_K / n));
            const batches = await Promise.all(
                qs.map(q => esClient.search({
                    index: INDEX,
                    size: kEach,
                    query: {
                        multi_match:{
                            query: q,
                            // ^2代表这个字段匹配得分*2
                            fields: ["note_title^2","note_body","title","content"],
                            type: "best_fields",
                            analyzer: "ik_smart"
                        }
                    }
                }))
            );
            console.log(batches," ------------ ");
            // hits -> Document -> 扁平化 -> 去重 
            const flat = batches.flatMap((res) => 
                (res.hits?.hits?? []).map(docFromEsHit)
            )
            return {
                esHits: dedupeDocsById(flat)
            }
        })
        .addNode("milvus_recall", async (state) => {
            const qs = retrievalQueryString(state.query, state.queryAugmentation);
            const n = Math.max(1, qs.length);
            const kEach = Math.max(2, Math.ceil(MILVUS_K / n));
            const batches = await Promise.all(
                qs.map((q) => milvus.similaritySearch(q,kEach))
            );
            const flat = batches.flat();
            return {milvusHits: dedupeDocsById(flat)}
        })
        .addNode("merge", async(state) => ({
            merged: merge(state.esHits, state.milvusHits)
        }))
        .addNode("rerank", async (state) => {
            const merge = state.merged ?? [];
            if(!merge.length) return {topDocuments : []};
            const topDocuments = await reranker.compressDocuments(merge, state.query);
            return { topDocuments}
        })
        .addNode("generate_answer", async(state) => {
            const query = state.query ?? "";
            const docs = state.topDocuments ?? [];
            if(!docs.length){
                const chain = NO_CONTEXT_PROMPT.pipe(chatModel);
                const msg = await chain.invoke({query});
                return{
                    answer: stringifyMessagecontent(msg.content).trim()
                }
            }
            const chain = ANSWER_PROMPT.pipe(chatModel);
            const msg = await chain.invoke({
                query,
                context: formatDocsAsContext(docs)
            });
            return {
                // 多模态的需要处理
                answer: stringifyMessagecontent(msg.content).trim()
            }
        })
        .addEdge(START,"query_augment")
        .addEdge("query_augment", "es_recall")
        .addEdge("query_augment","milvus_recall")
        .addEdge(["es_recall","milvus_recall"], "merge")
        .addEdge("merge", 'rerank')
        .addEdge("rerank", "generate_answer")
        .addEdge("generate_answer", END)
        .compile();
}

const graph = compileHybridretrievalGraph(esClient, milvus, reranker, chatModel);
// const drawable = await graph.getGraphAsync();
// console.log(drawable.drawMermaid());

const query = "最近都在学习什么东西啊";
const state = await graph.invoke({query})
printQueryRewrite(state.query, state.queryAugmentation);
printDocs("ElasticSearch检索",state.esHits);
printDocs("Milvus检索",state.milvusHits);
printDocs("重排后保留",state.topDocuments ?? []);
console.log("大模型生成回答");
console.log(state.answer);