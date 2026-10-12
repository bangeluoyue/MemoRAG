import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { z } from "zod";

const RouteSchema = z.object({
  strategy: z.enum(["simple", "complex"]),
  reason: z.string(),
});

const DecomposeSchema = z.object({
  sub_questions: z.array(z.string()).min(1).max(8),
  reason: z.string(),
});

const RewriteSchema = z.object({
  needsRewrite: z.boolean(),
  rewrittenQuery: z.string(),
  resolvedEntities: z.array(z.string()).max(4),
  supportingDocumentIds: z.array(z.string()).max(6),
  hasConflictingEvidence: z.boolean(),
  reason: z.string(),
});

const EvaluateSchema = z.object({
  nextAction: z.enum(["retrieve", "web_search", "generate"]),
  missing: z.array(z.string()).max(6),
  reason: z.string(),
  web_query: z.string().optional(),
});

export const EbookRagState = Annotation.Root({
  question: Annotation(),
  bookId: Annotation(),
  k: Annotation(),
  strategy: Annotation(),
  routeReason: Annotation(),
  subQuestions: Annotation(),
  nextSubIdx: Annotation(),
  currentOriginalSubQuestion: Annotation(),
  currentQuery: Annotation(),
  rewriteHistory: Annotation(),
  retrievalHistory: Annotation(),
  retrievalCount: Annotation(),
  maxRetrievals: Annotation(),
  documents: Annotation(),
  citationDocuments: Annotation(),
  localContext: Annotation(),
  webContext: Annotation(),
  webSources: Annotation(),
  webSearchCount: Annotation(),
  evaluation: Annotation(),
  generation: Annotation(),
  citationValidation: Annotation(),
});

export function stringifyMessageContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .map((part) => typeof part === "string" ? part : String(part?.text ?? ""))
    .join("");
}

export function mergeUniqueDocuments(existingDocs = [], newDocs = [], limit = 24) {
  const hasRankFusion = [...existingDocs, ...newDocs]
    .some((document) => Number.isFinite(Number(document.rankFusionScore)));

  if (hasRankFusion) {
    const documentsById = new Map();
    let nextFirstSeen = existingDocs.reduce((maximum, document, index) => {
      const firstSeen = Number(document.rankFusionFirstSeen);
      return Math.max(maximum, Number.isFinite(firstSeen) ? firstSeen : index);
    }, -1) + 1;

    for (const [index, document] of [...existingDocs, ...newDocs].entries()) {
      const id = String(document.id);
      const previous = documentsById.get(id);
      const contribution = Number(document.rankFusionScore);
      const firstSeenValue = Number(document.rankFusionFirstSeen);
      const firstSeen = Number.isFinite(firstSeenValue)
        ? firstSeenValue
        : (index < existingDocs.length ? index : nextFirstSeen++);

      if (previous) {
        documentsById.set(id, {
          ...previous,
          rankFusionScore: Number(previous.rankFusionScore)
            + (Number.isFinite(contribution) ? contribution : 0),
        });
      } else {
        documentsById.set(id, {
          ...document,
          rankFusionScore: Number.isFinite(contribution) ? contribution : 0,
          rankFusionFirstSeen: firstSeen,
        });
      }
    }

    return [...documentsById.values()]
      .sort((left, right) => (
        Number(right.rankFusionScore) - Number(left.rankFusionScore)
        || Number(left.rankFusionFirstSeen) - Number(right.rankFusionFirstSeen)
        || String(left.id).localeCompare(String(right.id))
      ))
      .slice(0, limit);
  }

  const documentsById = new Map();

  for (const document of [...existingDocs, ...newDocs]) {
    const previous = documentsById.get(document.id);
    if (!previous || Number(document.score) > Number(previous.score)) {
      documentsById.set(document.id, document);
    }
  }

  return [...documentsById.values()]
    .sort((left, right) => Number(right.score) - Number(left.score))
    .slice(0, limit);
}

export function buildLocalContext(documents = []) {
  return documents.map((document, index) => [
    `[本地${index + 1}]`,
    `文档ID：${document.id}`,
    `书名：${document.bookName}`,
    `章节：${document.chapterNum}`,
    `片段序号：${document.chunkIndex}`,
    `相似度：${Number(document.score).toFixed(4)}`,
    `内容：${document.content}`,
  ].join("\n")).join("\n\n---------\n\n");
}

const LOCAL_CITATION_PATTERN = /\[本地([0-9]+)\]/g;

function unique(values) {
  return [...new Set(values)];
}

function loopBudget(value, minimum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return minimum;
  return Math.max(minimum, Math.ceil(number));
}

export function calculateAgenticRagRecursionLimit({
  maxRetrievals,
  maxWebSearches = 0,
}) {
  const retrievalBudget = loopBudget(maxRetrievals, 1);
  const webSearchBudget = loopBudget(maxWebSearches, 0);

  // complex 路径：route + decompose + 3 * retrieval + 2 * web
  // + generate + LangGraph 的最终 END superstep。
  return (3 * retrievalBudget) + (2 * webSearchBudget) + 4;
}

export function validateLocalCitations(answer, sourceCount) {
  const maximum = Math.max(0, Math.floor(Number(sourceCount) || 0));
  const references = [...String(answer ?? "").matchAll(LOCAL_CITATION_PATTERN)]
    .map((match) => ({
      label: match[0],
      digits: match[1],
      number: Number(match[1]),
    }));
  const isValidReference = (reference) => (
    reference.number >= 1
    && reference.number <= maximum
    && String(reference.number) === reference.digits
  );

  const validReferences = unique(
    references.filter(isValidReference).map((reference) => reference.label),
  );
  const invalidReferences = unique(
    references.filter((reference) => !isValidReference(reference))
      .map((reference) => reference.label),
  );

  return {
    references: unique(references.map((reference) => reference.label)),
    validReferences,
    invalidReferences,
    isValid: invalidReferences.length === 0,
  };
}

export function removeInvalidLocalCitations(answer, sourceCount) {
  const maximum = Math.max(0, Math.floor(Number(sourceCount) || 0));
  return String(answer ?? "")
    .replace(LOCAL_CITATION_PATTERN, (label, digits) => {
      const number = Number(digits);
      const isValid = number >= 1
        && number <= maximum
        && String(number) === digits;
      return isValid ? label : "";
    })
    .replace(/[ \t]+(?=[，。！？；：,.!?;:])/g, "")
    .trim();
}

function buildRewriteEvidence(retrievalHistory = []) {
  return retrievalHistory.flatMap((retrieval) => (
    (retrieval.evidence ?? []).map((evidence) => ({
      ...evidence,
      subQuestionIndex: retrieval.subQuestionIndex,
      originalSubQuestion: retrieval.originalSubQuestion,
      retrievalQuery: retrieval.query,
    }))
  ));
}

function formatRewriteEvidence(retrievalHistory = []) {
  if (!retrievalHistory.length) return "（无前序检索）";

  return retrievalHistory.map((retrieval) => {
    const evidence = (retrieval.evidence ?? []).map((item) => [
      `  [文档 ${item.documentId}]`,
      `  章节：${item.chapterNum}，片段：${item.chunkIndex}`,
      `  原文摘录：${item.excerpt}`,
    ].join("\n")).join("\n");

    return [
      `第 ${retrieval.subQuestionIndex + 1} 个已检索子问题：${retrieval.originalSubQuestion}`,
      `实际检索查询：${retrieval.query}`,
      evidence || "  （未检索到证据）",
    ].join("\n");
  }).join("\n\n---------\n\n");
}

function createRewriteRecord({
  subQuestionIndex,
  originalSubQuestion,
  rewrittenQuery = originalSubQuestion,
  rewriteApplied = false,
  status,
  reason,
  resolvedEntities = [],
  supportingDocumentIds = [],
}) {
  return {
    subQuestionIndex,
    originalSubQuestion,
    rewrittenQuery,
    rewriteApplied,
    status,
    reason,
    resolvedEntities,
    supportingDocumentIds,
  };
}

function validateRewrite(originalSubQuestion, result, priorEvidence) {
  if (!result || typeof result.needsRewrite !== "boolean") {
    return { valid: false, reason: "模型未返回有效的结构化改写结果" };
  }

  if (!result.needsRewrite) {
    return {
      valid: true,
      applied: false,
      query: originalSubQuestion,
      status: "kept_original",
      reason: result.reason || "当前子问题无需依赖前序证据改写",
    };
  }

  const rewrittenQuery = String(result.rewrittenQuery ?? "").trim();
  const resolvedEntities = (result.resolvedEntities ?? [])
    .map((entity) => String(entity).trim())
    .filter(Boolean);
  const supportingDocumentIds = (result.supportingDocumentIds ?? [])
    .map((id) => String(id).trim())
    .filter(Boolean);
  const evidenceById = new Map(
    priorEvidence.map((item) => [String(item.documentId), item]),
  );

  if (result.hasConflictingEvidence) {
    return { valid: false, reason: "前序证据存在冲突，拒绝选择单一实体" };
  }
  if (!rewrittenQuery || rewrittenQuery === originalSubQuestion) {
    return { valid: false, reason: "模型未提供有效且不同的改写查询" };
  }
  if (!resolvedEntities.length || !supportingDocumentIds.length) {
    return { valid: false, reason: "改写缺少已解析实体或支持文档" };
  }
  if (supportingDocumentIds.some((id) => !evidenceById.has(id))) {
    return { valid: false, reason: "改写引用了不属于前序检索的文档" };
  }

  const supportingText = supportingDocumentIds
    .map((id) => evidenceById.get(id)?.excerpt ?? "")
    .join("\n");
  const hasUngroundedEntity = resolvedEntities.some((entity) => (
    !rewrittenQuery.includes(entity) || !supportingText.includes(entity)
  ));
  if (hasUngroundedEntity) {
    return { valid: false, reason: "改写实体未同时出现在支持文档和改写查询中" };
  }

  return {
    valid: true,
    applied: true,
    query: rewrittenQuery,
    status: "rewritten",
    reason: result.reason,
    resolvedEntities,
    supportingDocumentIds,
  };
}

export function createInitialState(question, options) {
  return {
    question: String(question).trim(),
    bookId: String(options.bookId),
    k: options.k,
    strategy: "",
    routeReason: "",
    subQuestions: [],
    nextSubIdx: 0,
    currentOriginalSubQuestion: "",
    currentQuery: "",
    rewriteHistory: [],
    retrievalHistory: [],
    retrievalCount: 0,
    maxRetrievals: options.maxRetrievals,
    documents: [],
    citationDocuments: [],
    localContext: "",
    webContext: "",
    webSources: [],
    webSearchCount: 0,
    evaluation: null,
    generation: "",
    citationValidation: null,
  };
}

export function createAgenticRagGraph({
  model,
  retriever,
  bookName,
  maxContextDocuments = 24,
  webSearch = null,
  maxWebSearches = 2,
  maxCitationCorrectionAttempts = 1,
}) {
  const citationCorrectionLimit = Math.max(
    0,
    Math.floor(Number(maxCitationCorrectionAttempts) || 0),
  );

  const generateWithValidatedCitations = async ({
    prompt,
    question,
    context,
    citationDocuments,
  }) => {
    const localSourceCount = citationDocuments.length;
    const initialMessage = await model.invoke(prompt);
    const initialAnswer = stringifyMessageContent(initialMessage.content).trim();
    const initialValidation = validateLocalCitations(initialAnswer, localSourceCount);
    let answer = initialAnswer;
    let validation = initialValidation;
    let correctionAttempts = 0;
    let correctionFailed = false;

    while (!validation.isValid && correctionAttempts < citationCorrectionLimit) {
      correctionAttempts += 1;
      const allowedReferences = localSourceCount > 0
        ? `[本地1] 至 [本地${localSourceCount}]`
        : "没有可用本地来源，不得使用任何 [本地N]";

      try {
        const correctedMessage = await model.invoke(`
你是中文问答答案的引用纠正器。下面的回答包含不存在的本地引用编号，请使用同一份资料重新生成完整回答。

用户原始问题：${question}

可用资料：
${context || "（空）"}

待纠正回答：
${answer}

检测到的无效本地引用：${validation.invalidReferences.join("、")}
合法本地引用范围：${allowedReferences}

要求：
1. 只使用资料中真实存在的引用编号，不得虚构、补造或改变来源 ID。
2. 保留仍然有效且确有使用的引用；没有资料支持时明确说明资料不足。
3. 网页引用不属于本次编号校验范围，不要把本地引用改成网页引用来规避校验。
4. 只输出纠正后的完整回答，不要解释纠正过程。
        `);
        const correctedAnswer = stringifyMessageContent(correctedMessage.content).trim();
        if (!correctedAnswer) {
          correctionFailed = true;
          break;
        }
        answer = correctedAnswer;
        validation = validateLocalCitations(answer, localSourceCount);
      } catch {
        correctionFailed = true;
        break;
      }
    }

    const removedInvalidReferences = validation.isValid
      ? []
      : validation.invalidReferences;
    let status = initialValidation.isValid ? "valid" : "corrected";
    if (!validation.isValid) {
      answer = removeInvalidLocalCitations(answer, localSourceCount);
      validation = validateLocalCitations(answer, localSourceCount);
      status = "sanitized";
    }

    return {
      generation: answer,
      citationDocuments,
      localContext: buildLocalContext(citationDocuments),
      citationValidation: {
        status,
        localSourceCount,
        initialReferences: initialValidation.references,
        initialInvalidReferences: initialValidation.invalidReferences,
        correctionAttempts,
        correctionFailed,
        removedInvalidReferences,
        finalReferences: validation.references,
        finalInvalidReferences: validation.invalidReferences,
        contentSupportChecked: false,
      },
    };
  };

  const routeQuestionNode = async (state) => {
    const router = model.withStructuredOutput(RouteSchema);
    const route = await router.invoke(`
你是问答路由器，请判断用户问题是否需要检索《${bookName}》的具体内容。
- simple：寒暄、普通常识、无需书中具体内容即可回答。
- complex：需要书中情节、人物关系、章节事实、原文细节或证据支持。

用户问题：${state.question}
    `);

    return {
      strategy: route.strategy,
      routeReason: route.reason,
    };
  };

  const directAnswerNode = async (state) => {
    return generateWithValidatedCitations({
      prompt: `
你是一个中文回答助手。请直接、简洁地回答问题。

问题：${state.question}
      `,
      question: state.question,
      context: "",
      citationDocuments: [],
    });
  };

  const decomposeQuestionNode = async (state) => {
    const decomposer = model.withStructuredOutput(DecomposeSchema);
    const result = await decomposer.invoke(`
你是《${bookName}》多跳问答的子问题拆解器。
用户原始问题：${state.question}

请输出 1～8 条有序、可独立检索的中文子问题：
1. 使用最少必要拆分；若一次检索即可回答，必须只输出一条。
2. 只拆回答原问题必需的事实，不扩展用户未询问的背景、人数或旁支验证。
3. 多层关系、因果或先后问题才拆成多条。
4. 每条必须写全人物名或事件名，不使用“他、她、此人、上文”等指代。
5. 顺序应符合推理链，不要拆成零散关键词。
    `);

    const subQuestions = result.sub_questions
      .map((question) => question.trim())
      .filter(Boolean);

    if (!subQuestions.length) {
      throw new Error("问题拆分结果为空");
    }

    return {
      subQuestions,
      nextSubIdx: 0,
      currentOriginalSubQuestion: subQuestions[0],
      currentQuery: "",
    };
  };

  const rewriteSubQuestionNode = async (state) => {
    const index = state.nextSubIdx ?? 0;
    const originalSubQuestion = state.subQuestions?.[index]?.trim();
    if (!originalSubQuestion) {
      throw new Error(`不存在可改写的子问题（下标 ${index}）`);
    }

    const priorEvidence = buildRewriteEvidence(state.retrievalHistory);
    if (!priorEvidence.length) {
      const record = createRewriteRecord({
        subQuestionIndex: index,
        originalSubQuestion,
        status: "skipped_no_prior_evidence",
        reason: "没有前序检索证据，使用原始子问题",
      });
      return {
        currentOriginalSubQuestion: originalSubQuestion,
        currentQuery: originalSubQuestion,
        rewriteHistory: [...(state.rewriteHistory ?? []), record],
      };
    }

    try {
      const rewriter = model.withStructuredOutput(RewriteSchema);
      const result = await rewriter.invoke(`
你是《${bookName}》RAG 的检索查询改写器。你的任务不是回答问题，而是判断当前子问题是否依赖前序检索结果，并生成适合向量检索的自包含查询。

用户原始问题：${state.question}
当前待检索的原始子问题：${originalSubQuestion}

只能使用以下已经完成的前序检索及其原文证据：
${formatRewriteEvidence(state.retrievalHistory)}

规则：
1. 仅当当前子问题有指代、实体省略或明确语义依赖，并且前序原文足以唯一确认实体时，needsRewrite 才为 true。
2. 不依赖前序资料时保留原问题；rewrittenQuery 必须与原问题完全一致。
3. 证据不足或多个候选实体相互冲突时不得猜测；hasConflictingEvidence 应如实标记，并保留原问题。
4. 不得使用常识、模型记忆、后续子问题或前序证据之外的事实。
5. 改写时只补全检索所必需的实体，不要提前回答当前子问题。
6. resolvedEntities 只填写实际补入查询的实体，而且实体文字必须直接出现在支持文档原文中。
7. supportingDocumentIds 只能填写上面给出的文档 ID；reason 仅用于调试，不属于事实证据。
      `);
      const decision = validateRewrite(originalSubQuestion, result, priorEvidence);

      if (!decision.valid) {
        const record = createRewriteRecord({
          subQuestionIndex: index,
          originalSubQuestion,
          status: "fallback_invalid_rewrite",
          reason: decision.reason,
        });
        return {
          currentOriginalSubQuestion: originalSubQuestion,
          currentQuery: originalSubQuestion,
          rewriteHistory: [...(state.rewriteHistory ?? []), record],
        };
      }

      const record = createRewriteRecord({
        subQuestionIndex: index,
        originalSubQuestion,
        rewrittenQuery: decision.query,
        rewriteApplied: decision.applied,
        status: decision.status,
        reason: decision.reason,
        resolvedEntities: decision.resolvedEntities,
        supportingDocumentIds: decision.supportingDocumentIds,
      });
      return {
        currentOriginalSubQuestion: originalSubQuestion,
        currentQuery: decision.query,
        rewriteHistory: [...(state.rewriteHistory ?? []), record],
      };
    } catch {
      const record = createRewriteRecord({
        subQuestionIndex: index,
        originalSubQuestion,
        status: "fallback_model_error",
        reason: "改写模型调用失败，已回退到原始子问题",
      });
      return {
        currentOriginalSubQuestion: originalSubQuestion,
        currentQuery: originalSubQuestion,
        rewriteHistory: [...(state.rewriteHistory ?? []), record],
      };
    }
  };

  const retrieveNode = async (state) => {
    const index = state.nextSubIdx ?? 0;
    const originalSubQuestion = state.subQuestions?.[index]?.trim();
    const query = state.currentQuery?.trim() || originalSubQuestion;
    if (!originalSubQuestion || !query) {
      throw new Error(`不存在可检索的子问题（下标 ${index}）`);
    }

    const retrievalResult = typeof retriever.searchWithTrace === "function"
      ? await retriever.searchWithTrace(query, {
        k: state.k,
        bookId: state.bookId,
      })
      : {
        documents: await retriever.search(query, {
          k: state.k,
          bookId: state.bookId,
        }),
        rerank: null,
      };
    const newDocuments = retrievalResult.documents;
    const documents = mergeUniqueDocuments(
      state.documents,
      newDocuments,
      maxContextDocuments,
    );
    const latestRewrite = state.rewriteHistory?.at(-1);
    const retrievalRecord = {
      subQuestionIndex: index,
      originalSubQuestion,
      query,
      rewriteApplied: Boolean(latestRewrite?.rewriteApplied),
      documentIds: newDocuments.map((document) => document.id),
      rerank: retrievalResult.rerank,
      evidence: newDocuments.slice(0, 4).map((document) => ({
        documentId: document.id,
        chapterNum: document.chapterNum,
        chunkIndex: document.chunkIndex,
        score: document.score,
        excerpt: document.content.slice(0, 800),
      })),
    };

    return {
      documents,
      localContext: buildLocalContext(documents),
      retrievalHistory: [...(state.retrievalHistory ?? []), retrievalRecord],
      retrievalCount: (state.retrievalCount ?? 0) + 1,
      nextSubIdx: index + 1,
      currentOriginalSubQuestion: originalSubQuestion,
      currentQuery: query,
    };
  };

  const evaluateNode = async (state) => {
    const subQuestions = state.subQuestions ?? [];
    const nextSubIdx = state.nextSubIdx ?? 0;
    const remaining = Math.max(0, subQuestions.length - nextSubIdx);
    const canRetrieve = remaining > 0
      && state.retrievalCount < state.maxRetrievals;
    const canWebSearch = Boolean(webSearch)
      && (state.webSearchCount ?? 0) < maxWebSearches;
    const completedByIndex = new Map(
      (state.retrievalHistory ?? []).map((retrieval) => [
        retrieval.subQuestionIndex,
        retrieval,
      ]),
    );
    const questionPlan = subQuestions.map((question, index) => {
      const completed = completedByIndex.get(index);
      if (!completed) return `${index + 1}. ${question}（未检索）`;
      return `${index + 1}. ${question}（已检索，实际查询：${completed.query}）`;
    }).join("\n");

    const evaluator = model.withStructuredOutput(EvaluateSchema);
    const suggested = await evaluator.invoke(`
你是多跳 RAG 的信息充分性评估器，并负责决定下一步。

原始问题：${state.question}
子问题：
${questionPlan || "（无）"}

已完成本地检索：${state.retrievalCount} 次
剩余子问题：${remaining}
还能本地检索：${canRetrieve}
还能联网搜索：${canWebSearch}

本地资料：
${state.localContext || "（空）"}

联网补充：
${state.webContext || "（空）"}

只能选择一个 nextAction：
- retrieve：资料不足，并且还有未检索子问题。
- web_search：本地资料不足、缺失内容适合联网补充且允许联网。
- generate：资料已经足够，或已无法继续检索。

同时给出 missing、reason；仅在 web_search 时提供完整的 web_query。
    `);

    let nextAction = suggested.nextAction;
    if (nextAction === "retrieve" && !canRetrieve) nextAction = "generate";
    if (nextAction === "web_search" && !canWebSearch) nextAction = "generate";

    return {
      evaluation: { ...suggested, nextAction },
    };
  };

  const webSearchNode = async (state) => {
    const query = state.evaluation?.web_query?.trim() || state.question;
    const result = await webSearch(query, 8);
    const searchNumber = (state.webSearchCount ?? 0) + 1;

    return {
      webContext: [
        state.webContext,
        `第 ${searchNumber} 次联网查询：${query}\n${result.text}`,
      ].filter(Boolean).join("\n\n=========\n\n"),
      webSources: [...(state.webSources ?? []), ...(result.sources ?? [])],
      webSearchCount: searchNumber,
    };
  };

  const generateNode = async (state) => {
    const citationDocuments = (state.documents ?? []).map((document) => ({
      ...document,
    }));
    const localContext = buildLocalContext(citationDocuments);
    const context = [localContext, state.webContext]
      .filter(Boolean)
      .join("\n\n--- 联网补充 ---\n\n");
    const allowedLocalReferences = citationDocuments.length > 0
      ? `[本地1] 至 [本地${citationDocuments.length}]`
      : "无本地引用";

    return generateWithValidatedCitations({
      prompt: `
你是一个严谨的中文阅读问答助手。请优先依据给定资料回答，不要编造。

资料：
${context || "（空）"}

用户最开始的问题：${state.question}

要求：
1. 回答完整问题，不要只回答某个子问题。
2. 使用资料时以 [本地1]、[网页1] 这种标记注明依据。
3. 可用本地引用严格限定为：${allowedLocalReferences}。
4. 若资料不足，明确说明无法确认以及缺少什么。
5. 不要虚构引用或 URL。
      `,
      question: state.question,
      context,
      citationDocuments,
    });
  };

  return new StateGraph(EbookRagState)
    .addNode("routeQuestion", routeQuestionNode)
    .addNode("directAnswer", directAnswerNode)
    .addNode("decomposeQuestion", decomposeQuestionNode)
    .addNode("rewriteSubQuestion", rewriteSubQuestionNode)
    .addNode("retrieve", retrieveNode)
    .addNode("evaluate", evaluateNode)
    .addNode("webSearch", webSearchNode)
    .addNode("generate", generateNode)
    .addEdge(START, "routeQuestion")
    .addConditionalEdges("routeQuestion", (state) => state.strategy, {
      simple: "directAnswer",
      complex: "decomposeQuestion",
    })
    .addEdge("directAnswer", END)
    .addEdge("decomposeQuestion", "rewriteSubQuestion")
    .addEdge("rewriteSubQuestion", "retrieve")
    .addEdge("retrieve", "evaluate")
    .addConditionalEdges("evaluate", (state) => state.evaluation?.nextAction ?? "generate", {
      retrieve: "rewriteSubQuestion",
      web_search: "webSearch",
      generate: "generate",
    })
    .addEdge("webSearch", "evaluate")
    .addEdge("generate", END)
    .compile();
}
