import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { z } from "zod";

const RouteSchema = z.object({
  mode: z.enum(["direct", "single_retrieval", "multi_hop"]),
  reason: z.string(),
});

const PlanItemSchema = z.object({
  question: z.string(),
  purpose: z.string(),
  dependsOn: z.array(z.number().int()).max(8),
  introducedAssumptions: z.array(z.string()).max(8),
});

const DecomposeSchema = z.object({
  sub_questions: z.array(PlanItemSchema).min(1).max(8),
  reason: z.string(),
});

const RewriteSchema = z.object({
  needsRewrite: z.boolean(),
  rewrittenQuery: z.string(),
  resolvedEntities: z.array(z.string()).max(4),
  supportingEvidenceIndexes: z.array(z.number().int()).max(6),
  hasConflictingEvidence: z.boolean(),
  reason: z.string(),
});

const CoverageSchema = z.object({
  planIndex: z.number().int().min(1).max(8),
  hasRelevantEvidence: z.boolean(),
  isSufficient: z.boolean(),
  hasConflictingEvidence: z.boolean(),
  supportedByWeb: z.boolean().optional(),
  supportingEvidenceIndexes: z.array(z.number().int()).max(6),
  missing: z.string(),
  reason: z.string(),
});

const EvaluateSchema = z.object({
  isSufficient: z.boolean(),
  coverage: z.array(CoverageSchema).max(8),
  nextAction: z.enum(["retrieve", "web_search", "generate"]),
  missing: z.array(z.string()).max(6),
  nextPlanItemAddressesGap: z.boolean(),
  reason: z.string(),
  web_query: z.string().optional(),
});

export const EbookRagState = Annotation.Root({
  question: Annotation(),
  bookId: Annotation(),
  k: Annotation(),
  strategy: Annotation(),
  routeMode: Annotation(),
  routeReason: Annotation(),
  planItems: Annotation(),
  planValidation: Annotation(),
  subQuestions: Annotation(),
  nextSubIdx: Annotation(),
  currentOriginalSubQuestion: Annotation(),
  currentQuery: Annotation(),
  currentTargetPlanIndexes: Annotation(),
  skipCurrentRetrieval: Annotation(),
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
  coverage: Annotation(),
  evaluationEvidence: Annotation(),
  answerEvidenceDocuments: Annotation(),
  gapRecoveryCount: Annotation(),
  maxGapRecoveryAttempts: Annotation(),
  generation: Annotation(),
  citationValidation: Annotation(),
  execution: Annotation(),
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

export function buildCompactLocalContext(
  documents = [],
  { maxDocuments = 6, maxContentCharacters = 600 } = {},
) {
  return documents.slice(0, maxDocuments).map((document, index) => [
    `[本地${index + 1}]`,
    `文档ID：${document.id}`,
    `章节：${document.chapterNum}，片段：${document.chunkIndex}`,
    `内容：${String(document.content ?? "").slice(0, maxContentCharacters)}`,
  ].join("\n")).join("\n\n---------\n\n");
}

const LOCAL_CITATION_PATTERN = /\[本地([0-9]+)\]/g;

function unique(values) {
  return [...new Set(values)];
}

const LLM_CALL_CATEGORIES = [
  "route",
  "decompose",
  "rewrite",
  "evaluate",
  "generate",
  "citationCorrection",
];

function createExecutionState() {
  return {
    startedAtMs: Date.now(),
    nodes: {},
    llmCalls: Object.fromEntries(
      LLM_CALL_CATEGORIES.map((category) => [category, 0]),
    ),
    llmDurationMs: Object.fromEntries(
      LLM_CALL_CATEGORIES.map((category) => [category, 0]),
    ),
    localRetrievalCount: 0,
    retrievalStages: {
      embeddingDurationMs: 0,
      vectorSearchDurationMs: 0,
      rerankDurationMs: 0,
      totalDurationMs: 0,
    },
    rerankRequestCount: 0,
    rerankFallbackCount: 0,
    webSearchCount: 0,
  };
}

function updateExecution(execution, {
  node,
  durationMs = 0,
  llmCalls = {},
  llmDurationMs = {},
  retrievalTiming = {},
  localRetrievals = 0,
  rerankRequests = 0,
  rerankFallbacks = 0,
  webSearches = 0,
} = {}) {
  const current = execution ?? createExecutionState();
  const nodes = { ...current.nodes };
  if (node) {
    const previous = nodes[node] ?? { count: 0, durationMs: 0 };
    nodes[node] = {
      count: previous.count + 1,
      durationMs: previous.durationMs + Math.max(0, Math.round(durationMs)),
    };
  }

  const nextLlmCalls = { ...current.llmCalls };
  const nextLlmDurationMs = { ...current.llmDurationMs };
  for (const category of LLM_CALL_CATEGORIES) {
    nextLlmCalls[category] = Number(nextLlmCalls[category] ?? 0)
      + Number(llmCalls[category] ?? 0);
    nextLlmDurationMs[category] = Number(nextLlmDurationMs[category] ?? 0)
      + Math.max(0, Math.round(Number(llmDurationMs[category] ?? 0) || 0));
  }

  const retrievalStages = { ...(current.retrievalStages ?? {}) };
  for (const category of [
    "embeddingDurationMs",
    "vectorSearchDurationMs",
    "rerankDurationMs",
    "totalDurationMs",
  ]) {
    retrievalStages[category] = Number(retrievalStages[category] ?? 0)
      + Math.max(0, Math.round(Number(retrievalTiming[category] ?? 0) || 0));
  }

  return {
    ...current,
    nodes,
    llmCalls: nextLlmCalls,
    llmDurationMs: nextLlmDurationMs,
    retrievalStages,
    localRetrievalCount: current.localRetrievalCount + localRetrievals,
    rerankRequestCount: current.rerankRequestCount + rerankRequests,
    rerankFallbackCount: current.rerankFallbackCount + rerankFallbacks,
    webSearchCount: current.webSearchCount + webSearches,
  };
}

function normalizePlanQuestion(question) {
  return String(question ?? "")
    .trim()
    .replace(/[\s，。！？；：,.!?;:]+/g, "")
    .toLocaleLowerCase("zh-CN");
}

export function validateQuestionPlan(rawItems, maxSubQuestions = 4) {
  const errors = [];
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { valid: false, errors: ["计划为空"], items: [] };
  }
  if (rawItems.length > maxSubQuestions) {
    errors.push(`计划包含 ${rawItems.length} 项，超过上限 ${maxSubQuestions}`);
  }

  const seenQuestions = new Set();
  const items = rawItems.map((rawItem, index) => {
    const question = String(rawItem?.question ?? "").trim();
    const purpose = String(rawItem?.purpose ?? "").trim();
    const dependsOn = Array.isArray(rawItem?.dependsOn)
      ? rawItem.dependsOn.map(Number)
      : [];
    const introducedAssumptions = Array.isArray(rawItem?.introducedAssumptions)
      ? rawItem.introducedAssumptions.map((item) => String(item).trim()).filter(Boolean)
      : [];
    const normalizedQuestion = normalizePlanQuestion(question);

    if (!question) errors.push(`第 ${index + 1} 项缺少问题`);
    if (!purpose) errors.push(`第 ${index + 1} 项缺少必要性说明`);
    if (normalizedQuestion && seenQuestions.has(normalizedQuestion)) {
      errors.push(`第 ${index + 1} 项与前序问题重复`);
    }
    if (normalizedQuestion) seenQuestions.add(normalizedQuestion);
    if (introducedAssumptions.length) {
      errors.push(`第 ${index + 1} 项包含未经证实的新增前提`);
    }
    if (dependsOn.some((dependency) => (
      !Number.isInteger(dependency) || dependency < 1 || dependency >= index + 1
    ))) {
      errors.push(`第 ${index + 1} 项包含无效或未来依赖`);
    }

    return {
      question,
      purpose,
      dependsOn: unique(dependsOn),
      introducedAssumptions,
      required: true,
      kind: "planned",
      targetPlanIndexes: [],
    };
  });

  return { valid: errors.length === 0, errors: unique(errors), items };
}

function planItemForOriginalQuestion(question, purpose, options = {}) {
  return {
    question,
    purpose,
    dependsOn: [],
    introducedAssumptions: [],
    required: options.required !== false,
    kind: options.kind ?? "planned",
    targetPlanIndexes: options.targetPlanIndexes ?? [],
  };
}

function buildSupplementalQuery(question, missing = []) {
  const gaps = unique(
    missing
      .map((item) => String(item ?? "").replace(/[\r\n]+/g, " ").trim())
      .filter(Boolean),
  )
    .slice(0, 3)
    .map((item) => item.slice(0, 80));
  if (!gaps.length) return "";
  return `${question} 补充检索重点：${gaps.join("；")}`;
}

function compactWebContext(context, maxCharacters = 3000) {
  return String(context ?? "").slice(0, maxCharacters);
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

function buildRewriteEvidence(
  retrievalHistory = [],
  dependencyIndexes = [],
  coverage = [],
) {
  const allowedIndexes = new Set(
    dependencyIndexes.map((dependency) => Number(dependency) - 1),
  );
  const allowedDocumentIds = new Set(
    coverage
      .filter((item) => allowedIndexes.has(item.planIndex) && item.isSufficient)
      .flatMap((item) => item.supportingDocumentIds ?? [])
      .map(String),
  );
  return retrievalHistory
    .flatMap((retrieval) => (
      (retrieval.evidence ?? [])
        .filter((evidence) => (
          allowedIndexes.has(retrieval.subQuestionIndex)
          || allowedDocumentIds.has(String(evidence.documentId))
        ))
        .map((evidence) => ({
          ...evidence,
          subQuestionIndex: retrieval.subQuestionIndex,
          originalSubQuestion: retrieval.originalSubQuestion,
          retrievalQuery: retrieval.query,
        }))
    ))
    .filter((item, index, items) => (
      items.findIndex((candidate) => (
        String(candidate.documentId) === String(item.documentId)
      )) === index
    ))
    .slice(0, 4)
    .map((item, index) => ({ ...item, evidenceIndex: index + 1 }));
}

function formatRewriteEvidence(evidence = []) {
  if (!evidence.length) return "（声明的依赖项没有检索证据）";
  return evidence.map((item) => [
    `[证据${item.evidenceIndex}]（来自计划第 ${item.subQuestionIndex + 1} 项）`,
    `实际检索查询：${item.retrievalQuery}`,
    `文档ID：${item.documentId}`,
    `章节：${item.chapterNum}，片段：${item.chunkIndex}`,
    `原文摘录：${String(item.excerpt ?? "").slice(0, 500)}`,
  ].join("\n")).join("\n\n---------\n\n");
}

function buildEvaluationEvidence(retrievalHistory = [], maxEvidence = 6) {
  const records = retrievalHistory.filter((record) => (
    Array.isArray(record.retrievedDocuments) && record.retrievedDocuments.length
  ));
  const result = [];
  const byDocumentId = new Map();
  const maximumRank = Math.max(
    0,
    ...records.map((record) => record.retrievedDocuments.length),
  );

  for (let rank = 0; rank < maximumRank && result.length < maxEvidence; rank += 1) {
    for (const record of records) {
      const document = record.retrievedDocuments[rank];
      if (!document) continue;
      const documentId = String(document.id);
      const targets = record.targetPlanIndexes?.length
        ? record.targetPlanIndexes
        : [record.subQuestionIndex];
      const existing = byDocumentId.get(documentId);
      if (existing) {
        existing.targetPlanIndexes = unique([
          ...existing.targetPlanIndexes,
          ...targets,
        ]);
        continue;
      }
      const entry = {
        evidenceIndex: result.length + 1,
        documentId,
        chapterNum: document.chapterNum,
        chunkIndex: document.chunkIndex,
        score: document.score,
        excerpt: String(document.content ?? "").slice(0, 600),
        retrievalQuery: record.query,
        targetPlanIndexes: unique(targets),
        document,
      };
      result.push(entry);
      byDocumentId.set(documentId, entry);
      if (result.length >= maxEvidence) break;
    }
  }
  return result;
}

function formatEvaluationEvidence(evidence = []) {
  if (!evidence.length) return "（空）";
  return evidence.map((item) => [
    `[证据${item.evidenceIndex}]`,
    `来自实际检索：${item.retrievalQuery}`,
    `文档ID：${item.documentId}`,
    `章节：${item.chapterNum}，片段：${item.chunkIndex}`,
    `内容：${item.excerpt}`,
  ].join("\n")).join("\n\n---------\n\n");
}

function normalizeCoverage({
  planItems = [],
  modelCoverage = [],
  evidence = [],
  retrievalHistory = [],
  hasWebContext = false,
}) {
  const modelByIndex = new Map(
    modelCoverage.map((item) => [Number(item?.planIndex) - 1, item]),
  );
  const evidenceByIndex = new Map(
    evidence.map((item) => [item.evidenceIndex, item]),
  );

  return planItems.map((planItem, planIndex) => {
    const modelItem = modelByIndex.get(planIndex) ?? {};
    const attempts = retrievalHistory.filter((record) => (
      (record.targetPlanIndexes?.length
        ? record.targetPlanIndexes
        : [record.subQuestionIndex]
      ).includes(planIndex)
    ));
    const attemptedIndexes = unique(
      (modelItem.supportingEvidenceIndexes ?? []).map(Number),
    );
    const validIndexes = attemptedIndexes.filter((index) => (
      Number.isInteger(index) && evidenceByIndex.has(index)
    ));
    const allIndexesValid = attemptedIndexes.length > 0
      && validIndexes.length === attemptedIndexes.length;
    const supportingEvidence = validIndexes.map((index) => evidenceByIndex.get(index));
    const hasConflictingEvidence = Boolean(modelItem.hasConflictingEvidence);
    const supportedByWeb = Boolean(modelItem.supportedByWeb && hasWebContext);
    const hasRelevantEvidence = Boolean(
      modelItem.hasRelevantEvidence
      && (allIndexesValid || supportedByWeb)
      && !hasConflictingEvidence,
    );
    const isSufficient = Boolean(
      modelItem.isSufficient
      && hasRelevantEvidence
      && !hasConflictingEvidence,
    );
    const retrieved = attempts.length > 0;
    const hitCount = attempts.reduce(
      (count, attempt) => count + (attempt.documentIds?.length ?? 0),
      0,
    );
    const hasRetrievalError = attempts.some((attempt) => attempt.errorCategory);
    let status = "not_retrieved";
    if (hasConflictingEvidence) status = "conflicting";
    else if (isSufficient) status = "supported";
    else if (hasRelevantEvidence) status = "relevant_but_insufficient";
    else if (hasRetrievalError && hitCount === 0) status = "retrieval_error";
    else if (retrieved && hitCount === 0) status = "no_hits_for_query";
    else if (retrieved) status = "retrieved_not_supportive";

    return {
      planIndex,
      question: planItem.question,
      required: planItem.required !== false,
      retrieved,
      retrievalAttempts: attempts.length,
      hitCount,
      hasRelevantEvidence,
      isSufficient,
      hasConflictingEvidence,
      supportedByWeb,
      status,
      attemptedEvidenceIndexes: attemptedIndexes,
      supportingEvidenceIndexes: validIndexes,
      supportingDocumentIds: unique(
        supportingEvidence.map((item) => item.documentId),
      ),
      missing: String(modelItem.missing ?? "").trim(),
      reason: String(modelItem.reason ?? "模型未返回该计划项的覆盖判断").trim(),
    };
  });
}

const QUESTION_INTENT_GROUPS = [
  { source: ["为什么", "为何"], target: ["为什么", "为何", "原因"] },
  { source: ["谁"], target: ["谁"] },
  { source: ["如何", "怎么", "怎样"], target: ["如何", "怎么", "怎样"] },
  { source: ["是否", "能否", "有没有"], target: ["是否", "能否", "有没有"] },
  { source: ["哪里", "何处", "在哪"], target: ["哪里", "何处", "在哪"] },
  { source: ["多少"], target: ["多少", "几"] },
];

function preservesQuestionIntent(originalQuestion, rewrittenQuestion) {
  return QUESTION_INTENT_GROUPS.every(({ source, target }) => (
    !source.some((marker) => originalQuestion.includes(marker))
    || target.some((marker) => rewrittenQuestion.includes(marker))
  ));
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
  attemptedEvidenceIndexes = [],
  allowedEvidenceIndexes = [],
  fallbackReason = null,
  fallbackStrategy = null,
  placeholderDetected = false,
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
    attemptedEvidenceIndexes,
    allowedEvidenceIndexes,
    fallbackReason,
    fallbackStrategy,
    placeholderDetected,
  };
}

function validateRewrite(originalSubQuestion, result, priorEvidence) {
  const allowedEvidenceIndexes = priorEvidence.map((item) => item.evidenceIndex);
  if (!result || typeof result.needsRewrite !== "boolean") {
    return {
      valid: false,
      reason: "模型未返回有效的结构化改写结果",
      failureCode: "invalid_structured_result",
      attemptedEvidenceIndexes: [],
      allowedEvidenceIndexes,
      supportingDocumentIds: [],
    };
  }

  if (!result.needsRewrite) {
    return {
      valid: true,
      applied: false,
      query: originalSubQuestion,
      status: "kept_original",
      reason: result.reason || "当前子问题无需依赖前序证据改写",
      attemptedEvidenceIndexes: [],
      allowedEvidenceIndexes,
      supportingDocumentIds: [],
    };
  }

  const rewrittenQuery = String(result.rewrittenQuery ?? "").trim();
  const resolvedEntities = (result.resolvedEntities ?? [])
    .map((entity) => String(entity).trim())
    .filter(Boolean);
  const attemptedEvidenceIndexes = unique(
    (result.supportingEvidenceIndexes ?? []).map(Number),
  );
  const evidenceByIndex = new Map(
    priorEvidence.map((item) => [item.evidenceIndex, item]),
  );
  const indexesValid = attemptedEvidenceIndexes.length > 0
    && attemptedEvidenceIndexes.every((index) => (
      Number.isInteger(index) && evidenceByIndex.has(index)
    ));
  const supportingEvidence = indexesValid
    ? attemptedEvidenceIndexes.map((index) => evidenceByIndex.get(index))
    : [];
  const supportingDocumentIds = supportingEvidence.map((item) => item.documentId);
  const invalid = (reason, failureCode) => ({
    valid: false,
    reason,
    failureCode,
    attemptedEvidenceIndexes,
    allowedEvidenceIndexes,
    supportingDocumentIds,
  });

  if (result.hasConflictingEvidence) {
    return invalid("前序证据存在冲突，拒绝选择单一实体", "conflicting_evidence");
  }
  if (!rewrittenQuery || rewrittenQuery === originalSubQuestion) {
    return invalid("模型未提供有效且不同的改写查询", "unchanged_or_empty_query");
  }
  if (!preservesQuestionIntent(originalSubQuestion, rewrittenQuery)) {
    return invalid("改写没有保留原子问题的疑问意图", "question_intent_changed");
  }
  if (!resolvedEntities.length || !attemptedEvidenceIndexes.length) {
    return invalid("改写缺少已解析实体或支持证据", "missing_grounding");
  }
  if (!indexesValid) {
    return invalid("改写引用了不属于本次前序证据快照的序号", "invalid_evidence_index");
  }

  const supportingText = supportingEvidence
    .map((item) => item.excerpt ?? "")
    .join("\n");
  const hasUngroundedEntity = resolvedEntities.some((entity) => (
    !rewrittenQuery.includes(entity) || !supportingText.includes(entity)
  ));
  if (hasUngroundedEntity) {
    return invalid(
      "改写实体未同时出现在支持证据和改写查询中",
      "ungrounded_entity",
    );
  }

  return {
    valid: true,
    applied: true,
    query: rewrittenQuery,
    status: "rewritten",
    reason: result.reason,
    resolvedEntities,
    supportingDocumentIds,
    attemptedEvidenceIndexes,
    allowedEvidenceIndexes,
  };
}

const DEPENDENCY_PLACEHOLDER_PATTERN = /(?:第\s*\d+\s*项|前一项|上一项|前序|该人物|该事件|此人|其人|他|她)/u;

function hasDependencyPlaceholder(question) {
  return DEPENDENCY_PLACEHOLDER_PATTERN.test(String(question ?? ""));
}

export function createInitialState(question, options) {
  return {
    question: String(question).trim(),
    bookId: String(options.bookId),
    k: options.k,
    strategy: "",
    routeMode: "",
    routeReason: "",
    planItems: [],
    planValidation: null,
    subQuestions: [],
    nextSubIdx: 0,
    currentOriginalSubQuestion: "",
    currentQuery: "",
    currentTargetPlanIndexes: [],
    skipCurrentRetrieval: false,
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
    coverage: [],
    evaluationEvidence: [],
    answerEvidenceDocuments: [],
    gapRecoveryCount: 0,
    maxGapRecoveryAttempts: options.maxGapRecoveryAttempts ?? 1,
    generation: "",
    citationValidation: null,
    execution: createExecutionState(),
  };
}

export function createAgenticRagGraph({
  model,
  retriever,
  bookName,
  maxContextDocuments = 12,
  maxSubQuestions = 4,
  maxPlanRepairAttempts = 1,
  maxSingleRetrievals = 2,
  maxGapRecoveryAttempts = 1,
  webSearch = null,
  maxWebSearches = 2,
  maxCitationCorrectionAttempts = 1,
}) {
  const citationCorrectionLimit = Math.max(
    0,
    Math.floor(Number(maxCitationCorrectionAttempts) || 0),
  );
  const subQuestionLimit = Math.min(
    8,
    Math.max(1, Math.floor(Number(maxSubQuestions) || 4)),
  );
  const planRepairLimit = Math.min(
    2,
    Math.max(0, Math.floor(Number(maxPlanRepairAttempts) || 0)),
  );
  const singleRetrievalLimit = Math.min(
    3,
    Math.max(1, Math.floor(Number(maxSingleRetrievals) || 2)),
  );
  const gapRecoveryLimit = Math.min(
    1,
    Math.max(0, Math.floor(Number(maxGapRecoveryAttempts) || 0)),
  );

  const generateWithValidatedCitations = async ({
    prompt,
    question,
    context,
    citationDocuments,
  }) => {
    const localSourceCount = citationDocuments.length;
    const initialStartedAt = Date.now();
    const initialMessage = await model.invoke(prompt);
    const generationDurationMs = Date.now() - initialStartedAt;
    const initialAnswer = stringifyMessageContent(initialMessage.content).trim();
    const initialValidation = validateLocalCitations(initialAnswer, localSourceCount);
    let answer = initialAnswer;
    let validation = initialValidation;
    let correctionAttempts = 0;
    let correctionFailed = false;
    let citationCorrectionDurationMs = 0;

    while (!validation.isValid && correctionAttempts < citationCorrectionLimit) {
      correctionAttempts += 1;
      const allowedReferences = localSourceCount > 0
        ? `[本地1] 至 [本地${localSourceCount}]`
        : "没有可用本地来源，不得使用任何 [本地N]";

      const correctionStartedAt = Date.now();
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
        citationCorrectionDurationMs += Date.now() - correctionStartedAt;
        const correctedAnswer = stringifyMessageContent(correctedMessage.content).trim();
        if (!correctedAnswer) {
          correctionFailed = true;
          break;
        }
        answer = correctedAnswer;
        validation = validateLocalCitations(answer, localSourceCount);
      } catch {
        citationCorrectionDurationMs += Date.now() - correctionStartedAt;
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
      generationLlmCalls: 1,
      citationCorrectionLlmCalls: correctionAttempts,
      generationDurationMs,
      citationCorrectionDurationMs,
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
    const startedAt = Date.now();
    const router = model.withStructuredOutput(RouteSchema);
    const route = await router.invoke(`
你是问答路由器。请区分“是否需要书中证据”和“是否真的需要多跳拆解”，只能选择一种 mode：
- direct：寒暄、普通常识、无需《${bookName}》具体内容即可回答。
- single_retrieval：需要书中情节、人物、动机、地点、原文等证据，但一个完整检索问题通常即可回答。单一事件的“为什么”默认属于此类。
- multi_hop：答案确实依赖两个及以上先后事实、关系链、跨人物比较或必须先确认中间实体再继续检索。

不得仅因为问题需要查书就选择 multi_hop；“阿朱为什么要假扮段正淳？”这类单一人物、单一事件、单一动机问题应选择 single_retrieval。

用户问题：${state.question}
    `);
    const strategy = route.mode === "direct" ? "simple" : "complex";

    return {
      strategy,
      routeMode: route.mode,
      routeReason: route.reason,
      execution: updateExecution(state.execution, {
        node: "routeQuestion",
        durationMs: Date.now() - startedAt,
        llmCalls: { route: 1 },
        llmDurationMs: { route: Date.now() - startedAt },
      }),
    };
  };

  const directAnswerNode = async (state) => {
    const startedAt = Date.now();
    const {
      generationLlmCalls,
      citationCorrectionLlmCalls,
      generationDurationMs,
      citationCorrectionDurationMs,
      ...generated
    } = await generateWithValidatedCitations({
      prompt: `
你是一个中文回答助手。请直接、简洁地回答问题。

问题：${state.question}
      `,
      question: state.question,
      context: "",
      citationDocuments: [],
    });
    return {
      ...generated,
      execution: updateExecution(state.execution, {
        node: "directAnswer",
        durationMs: Date.now() - startedAt,
        llmCalls: {
          generate: generationLlmCalls,
          citationCorrection: citationCorrectionLlmCalls,
        },
        llmDurationMs: {
          generate: generationDurationMs,
          citationCorrection: citationCorrectionDurationMs,
        },
      }),
    };
  };

  const prepareSingleRetrievalNode = async (state) => {
    const startedAt = Date.now();
    const item = planItemForOriginalQuestion(
      state.question,
      "直接检索原始问题，避免对单一问题进行拆解",
    );
    return {
      planItems: [item],
      planValidation: {
        status: "not_required",
        repairAttempts: 0,
        failureReasons: [],
      },
      subQuestions: [state.question],
      nextSubIdx: 0,
      currentOriginalSubQuestion: state.question,
      currentQuery: state.question,
      currentTargetPlanIndexes: [0],
      skipCurrentRetrieval: false,
      execution: updateExecution(state.execution, {
        node: "prepareSingleRetrieval",
        durationMs: Date.now() - startedAt,
      }),
    };
  };

  const decomposeQuestionNode = async (state) => {
    const startedAt = Date.now();
    const decomposer = model.withStructuredOutput(DecomposeSchema);
    const failureReasons = [];
    let repairAttempts = 0;
    let llmCalls = 0;
    let acceptedPlan = null;
    let resultReason = "";

    while (!acceptedPlan && repairAttempts <= planRepairLimit) {
      const repairInstructions = repairAttempts > 0
        ? `\n上一次计划未通过结构校验：${failureReasons.at(-1)?.join("；")}\n请只修复这些问题，不扩展任务范围。`
        : "";

      try {
        llmCalls += 1;
        const result = await decomposer.invoke(`
你是《${bookName}》多跳问答的子问题拆解器。
用户原始问题：${state.question}

请输出有序的结构化检索计划，默认最多 ${subQuestionLimit} 项：
1. 通常只需 2 项；只有不可合并且回答原问题必需的事实才增加，禁止背景盘点、旁支验证和用户未问内容。
2. question 是可检索的疑问句；purpose 必须说明它填补原问题的哪一项必要信息。
3. dependsOn 使用从 1 开始的前序计划编号，只能依赖更早的项；不依赖时返回空数组。
4. 未知实体应写成“第 N 项确认的人物/事件”等依赖表达，不得猜成具体名称。
5. introducedAssumptions 必须列出计划新引入但用户没有提供、证据也尚未确认的事实前提；正常计划应为空数组。
6. 不得输出重复问题，不得超过 ${subQuestionLimit} 项。
${repairInstructions}
        `);
        resultReason = result.reason;
        const validation = validateQuestionPlan(
          result.sub_questions,
          subQuestionLimit,
        );
        if (validation.valid) {
          acceptedPlan = validation.items;
          break;
        }
        failureReasons.push(validation.errors);
      } catch {
        failureReasons.push(["拆题模型未返回可校验的结构化计划"]);
      }

      if (repairAttempts >= planRepairLimit) break;
      repairAttempts += 1;
    }

    const planItems = acceptedPlan ?? [planItemForOriginalQuestion(
      state.question,
      "拆题计划校验或有限修复失败，安全回退到原始问题单次检索",
    )];
    const status = acceptedPlan
      ? (repairAttempts > 0 ? "repaired" : "valid")
      : "fallback_single";
    const subQuestions = planItems.map((item) => item.question);

    return {
      planItems,
      planValidation: {
        status,
        repairAttempts,
        failureReasons: failureReasons.flat(),
        reason: resultReason,
      },
      subQuestions,
      nextSubIdx: 0,
      currentOriginalSubQuestion: subQuestions[0],
      currentQuery: "",
      currentTargetPlanIndexes: [0],
      skipCurrentRetrieval: false,
      execution: updateExecution(state.execution, {
        node: "decomposeQuestion",
        durationMs: Date.now() - startedAt,
        llmCalls: { decompose: llmCalls },
        llmDurationMs: { decompose: Date.now() - startedAt },
      }),
    };
  };

  const rewriteSubQuestionNode = async (state) => {
    const startedAt = Date.now();
    const index = state.nextSubIdx ?? 0;
    const originalSubQuestion = state.subQuestions?.[index]?.trim();
    if (!originalSubQuestion) {
      throw new Error(`不存在可改写的子问题（下标 ${index}）`);
    }

    const planItem = state.planItems?.[index];
    const dependencies = planItem?.dependsOn ?? [];
    const targetPlanIndexes = planItem?.targetPlanIndexes?.length
      ? planItem.targetPlanIndexes
      : [index];
    if (!dependencies.length) {
      const record = createRewriteRecord({
        subQuestionIndex: index,
        originalSubQuestion,
        status: "skipped_independent",
        reason: "计划项不依赖前序结果，直接使用原始子问题",
      });
      return {
        currentOriginalSubQuestion: originalSubQuestion,
        currentQuery: originalSubQuestion,
        currentTargetPlanIndexes: targetPlanIndexes,
        skipCurrentRetrieval: false,
        rewriteHistory: [...(state.rewriteHistory ?? []), record],
        execution: updateExecution(state.execution, {
          node: "rewriteSubQuestion",
          durationMs: Date.now() - startedAt,
        }),
      };
    }

    const dependencyCoverage = dependencies.map((dependency) => (
      state.coverage?.find((item) => item.planIndex === dependency - 1)
    ));
    const unsupportedDependencies = dependencyCoverage.filter((item) => (
      !item?.isSufficient
    ));
    const priorEvidence = buildRewriteEvidence(
      state.retrievalHistory,
      dependencies,
      state.coverage,
    );
    const placeholderDetected = hasDependencyPlaceholder(originalSubQuestion);

    const useSafeFallback = ({ status, reason, failureCode, diagnostics = {} }) => {
      const safeQuery = state.question.trim();
      const previousQueries = new Set(
        (state.retrievalHistory ?? []).map((retrieval) => (
          normalizePlanQuestion(retrieval.query)
        )),
      );
      const duplicate = previousQueries.has(normalizePlanQuestion(safeQuery));
      const record = createRewriteRecord({
        subQuestionIndex: index,
        originalSubQuestion,
        rewrittenQuery: safeQuery,
        status,
        reason,
        fallbackReason: failureCode,
        fallbackStrategy: "dependency_fallback_original_question",
        placeholderDetected,
        attemptedEvidenceIndexes: diagnostics.attemptedEvidenceIndexes,
        allowedEvidenceIndexes: diagnostics.allowedEvidenceIndexes
          ?? priorEvidence.map((item) => item.evidenceIndex),
        supportingDocumentIds: diagnostics.supportingDocumentIds,
      });
      return {
        currentOriginalSubQuestion: originalSubQuestion,
        currentQuery: duplicate ? "" : safeQuery,
        currentTargetPlanIndexes: targetPlanIndexes,
        skipCurrentRetrieval: duplicate,
        nextSubIdx: duplicate ? index + 1 : index,
        rewriteHistory: [...(state.rewriteHistory ?? []), record],
      };
    };

    if (unsupportedDependencies.length || !priorEvidence.length) {
      const fallback = useSafeFallback({
        status: "dependency_fallback_original_question",
        failureCode: unsupportedDependencies.length
          ? "dependency_not_supported"
          : "missing_dependency_evidence",
        reason: "依赖项尚无充分证据，改用不含内部占位符的原始完整问题",
      });
      return {
        ...fallback,
        execution: updateExecution(state.execution, {
          node: "rewriteSubQuestion",
          durationMs: Date.now() - startedAt,
        }),
      };
    }

    try {
      const rewriter = model.withStructuredOutput(RewriteSchema);
      const result = await rewriter.invoke(`
你是《${bookName}》RAG 的检索查询改写器。你的任务不是回答问题，而是判断当前子问题是否依赖前序检索结果，并生成适合向量检索的自包含查询。

用户原始问题：${state.question}
当前待检索的原始子问题：${originalSubQuestion}

只能使用以下已经完成的前序检索及其原文证据：
${formatRewriteEvidence(priorEvidence)}

规则：
1. 仅当当前子问题有指代、实体省略或明确语义依赖，并且前序原文足以唯一确认实体时，needsRewrite 才为 true。
2. 不依赖前序资料时保留原问题；rewrittenQuery 必须与原问题完全一致。
3. 证据不足或多个候选实体相互冲突时不得猜测；hasConflictingEvidence 应如实标记，并保留原问题。
4. 不得使用常识、模型记忆、后续子问题或前序证据之外的事实。
5. 改写时只补全检索所必需的实体，不要提前回答当前子问题。
6. resolvedEntities 只填写实际补入查询的实体，而且实体文字必须直接出现在支持文档原文中。
7. supportingEvidenceIndexes 只能填写上面给出的 [证据N] 编号，不得填写文档 ID；reason 仅用于调试，不属于事实证据。
8. 必须保留原问题“谁、为什么、为何、如何、是否、哪里、多少”等疑问意图，不得把疑问改写为未经证实的事实断言。
      `);
      const decision = validateRewrite(originalSubQuestion, result, priorEvidence);

      if (!decision.valid || !decision.applied) {
        const fallback = useSafeFallback({
          status: "fallback_invalid_rewrite",
          reason: decision.reason,
          failureCode: decision.failureCode ?? "rewrite_not_applied",
          diagnostics: decision,
        });
        return {
          ...fallback,
          execution: updateExecution(state.execution, {
            node: "rewriteSubQuestion",
            durationMs: Date.now() - startedAt,
            llmCalls: { rewrite: 1 },
            llmDurationMs: { rewrite: Date.now() - startedAt },
          }),
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
        attemptedEvidenceIndexes: decision.attemptedEvidenceIndexes,
        allowedEvidenceIndexes: decision.allowedEvidenceIndexes,
        placeholderDetected,
      });
      return {
        currentOriginalSubQuestion: originalSubQuestion,
        currentQuery: decision.query,
        currentTargetPlanIndexes: targetPlanIndexes,
        skipCurrentRetrieval: false,
        rewriteHistory: [...(state.rewriteHistory ?? []), record],
        execution: updateExecution(state.execution, {
          node: "rewriteSubQuestion",
          durationMs: Date.now() - startedAt,
          llmCalls: { rewrite: 1 },
          llmDurationMs: { rewrite: Date.now() - startedAt },
        }),
      };
    } catch {
      const fallback = useSafeFallback({
        status: "fallback_model_error",
        reason: "改写模型调用失败，已回退到原始完整问题",
        failureCode: "rewrite_model_error",
      });
      return {
        ...fallback,
        execution: updateExecution(state.execution, {
          node: "rewriteSubQuestion",
          durationMs: Date.now() - startedAt,
          llmCalls: { rewrite: 1 },
          llmDurationMs: { rewrite: Date.now() - startedAt },
        }),
      };
    }
  };

  const retrieveNode = async (state) => {
    const startedAt = Date.now();
    const index = state.nextSubIdx ?? 0;
    const originalSubQuestion = state.subQuestions?.[index]?.trim();
    const query = state.currentQuery?.trim() || originalSubQuestion;
    if (!originalSubQuestion || !query) {
      throw new Error(`不存在可检索的子问题（下标 ${index}）`);
    }

    let retrievalResult;
    let errorCategory = null;
    try {
      retrievalResult = typeof retriever.searchWithTrace === "function"
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
    } catch (error) {
      errorCategory = String(error?.name || "retrieval_error");
      retrievalResult = { documents: [], rerank: null, retrieval: {} };
    }
    const newDocuments = retrievalResult.documents ?? [];
    const rankedNewDocuments = mergeUniqueDocuments(
      [],
      newDocuments,
      maxContextDocuments,
    );
    const documents = mergeUniqueDocuments(
      state.documents,
      newDocuments,
      maxContextDocuments,
    );
    const latestRewrite = [...(state.rewriteHistory ?? [])]
      .reverse()
      .find((rewrite) => rewrite.subQuestionIndex === index);
    const targetPlanIndexes = state.currentTargetPlanIndexes?.length
      ? state.currentTargetPlanIndexes
      : [index];
    const measuredDurationMs = Date.now() - startedAt;
    const retrievalTiming = {
      ...(retrievalResult.retrieval ?? {}),
      totalDurationMs: retrievalResult.retrieval?.totalDurationMs
        ?? measuredDurationMs,
    };
    const retrievalRecord = {
      subQuestionIndex: index,
      targetPlanIndexes,
      originalSubQuestion,
      query,
      rewriteApplied: Boolean(latestRewrite?.rewriteApplied),
      fallbackReason: latestRewrite?.fallbackReason ?? null,
      fallbackStrategy: latestRewrite?.fallbackStrategy ?? null,
      documentIds: rankedNewDocuments.map((document) => document.id),
      retrievedDocuments: rankedNewDocuments,
      rerank: retrievalResult.rerank,
      timing: retrievalTiming,
      errorCategory,
      evidence: rankedNewDocuments.slice(0, 4).map((document) => ({
        documentId: document.id,
        chapterNum: document.chapterNum,
        chunkIndex: document.chunkIndex,
        score: document.score,
        excerpt: String(document.content ?? "").slice(0, 500),
      })),
    };
    const rerankStatus = retrievalResult.rerank?.status;
    const rerankRequested = ["success", "fallback"].includes(rerankStatus);

    return {
      documents,
      localContext: buildLocalContext(documents),
      retrievalHistory: [...(state.retrievalHistory ?? []), retrievalRecord],
      retrievalCount: (state.retrievalCount ?? 0) + 1,
      nextSubIdx: index + 1,
      currentOriginalSubQuestion: originalSubQuestion,
      currentQuery: query,
      currentTargetPlanIndexes: [],
      skipCurrentRetrieval: false,
      execution: updateExecution(state.execution, {
        node: "retrieve",
        durationMs: measuredDurationMs,
        retrievalTiming,
        localRetrievals: 1,
        rerankRequests: rerankRequested ? 1 : 0,
        rerankFallbacks: rerankStatus === "fallback" ? 1 : 0,
      }),
    };
  };

  const evaluateNode = async (state) => {
    const startedAt = Date.now();
    const subQuestions = state.subQuestions ?? [];
    const planItems = state.planItems ?? [];
    const requiredPlanItems = planItems.filter((item) => item.required !== false);
    const nextSubIdx = state.nextSubIdx ?? 0;
    const isSingleExecution = state.routeMode === "single_retrieval"
      || state.planValidation?.status === "fallback_single";
    const singleRetrievalBudget = Math.min(
      state.maxRetrievals,
      singleRetrievalLimit,
    );
    const localRetrievalLimit = isSingleExecution
      ? singleRetrievalBudget
      : state.maxRetrievals;
    const hasLocalBudget = state.retrievalCount < localRetrievalLimit;
    const canWebSearch = Boolean(webSearch)
      && (state.webSearchCount ?? 0) < maxWebSearches;
    const completedByIndex = new Map(
      (state.retrievalHistory ?? []).map((retrieval) => [
        retrieval.subQuestionIndex,
        retrieval,
      ]),
    );
    const questionPlan = requiredPlanItems.map((planItem, index) => {
      const completed = completedByIndex.get(index);
      const details = `；目的：${planItem.purpose}；依赖：${planItem.dependsOn.join("、") || "无"}`;
      if (!completed) return `${index + 1}. ${planItem.question}${details}（该计划项未直接检索）`;
      return `${index + 1}. ${planItem.question}${details}（已检索，实际查询：${completed.query}）`;
    }).join("\n");
    const evaluationEvidence = buildEvaluationEvidence(state.retrievalHistory, 6);

    const evaluator = model.withStructuredOutput(EvaluateSchema);
    const suggested = await evaluator.invoke(`
你是 RAG 的逐项证据覆盖评估器。你只能判断当前证据快照是否相关、是否足以支持答案，不得把“检索过”或“引用编号合法”当作“证据充分”。

原始问题：${state.question}
当前路由模式：${state.routeMode}
必须回答的计划项：
${questionPlan || "（无）"}

已完成本地检索：${state.retrievalCount} 次
还能本地检索：${hasLocalBudget}
还能联网搜索：${canWebSearch}

本地证据快照（跨检索轮次平衡选取，最多 6 条）：
${formatEvaluationEvidence(evaluationEvidence)}

联网补充（紧凑视图）：
${compactWebContext(state.webContext) || "（空）"}

规则：
1. coverage 必须为每个必须回答的计划项各返回一项，planIndex 从 1 开始。
2. hasRelevantEvidence 表示至少一条证据与该项直接相关；isSufficient 表示证据已足以支持该项答案。二者必须分别判断。
3. supportingEvidenceIndexes 只能填写上面存在的 [证据N]。即使编号合法，若内容不相关也必须将 hasRelevantEvidence 设为 false。
4. 资料冲突时 hasConflictingEvidence=true 且 isSufficient=false，不得擅自选择一方。
5. 只有联网补充中存在直接证据时才可设置 supportedByWeb=true；此时无需伪造本地证据编号。
6. 只有所有必要计划项都有直接、充分且无冲突的证据，整体 isSufficient 才能为 true；否则 missing 只列仍缺少的必要信息。
7. 尚未直接执行某计划项，不代表它一定缺证据；已有证据若确实覆盖它，可以标记充分。
8. nextAction 只是建议，系统仍会执行硬预算和逐项覆盖校验。联网内容不使用本地证据编号。

仅在 web_search 时提供完整的 web_query。
    `);

    const coverage = normalizeCoverage({
      planItems: requiredPlanItems,
      modelCoverage: suggested.coverage ?? [],
      evidence: evaluationEvidence,
      retrievalHistory: state.retrievalHistory,
      hasWebContext: Boolean(state.webContext),
    });
    const allRequiredSupported = coverage.length > 0
      && coverage.every((item) => item.isSufficient);
    const unresolvedCoverage = coverage.filter((item) => !item.isSufficient);
    const missing = unique([
      ...unresolvedCoverage.map((item) => item.missing || item.question),
      ...(suggested.missing ?? []),
    ].map((item) => String(item).trim()).filter(Boolean));
    const isSufficient = allRequiredSupported;
    let nextAction = "generate";
    let retrievalMode = null;
    let nextPlanItems = planItems;
    let nextSubQuestions = subQuestions;
    let currentOriginalSubQuestion = state.currentOriginalSubQuestion;
    let currentQuery = state.currentQuery;
    let currentTargetPlanIndexes = [];
    let nextPlanIndex = nextSubIdx;
    let gapRecoveryCount = state.gapRecoveryCount ?? 0;
    let fallbackReason = null;

    const nextMissingPlanIndex = coverage.find((item) => (
      item.planIndex >= nextSubIdx && !item.isSufficient
    ))?.planIndex;
    const hasConflict = unresolvedCoverage.some((item) => (
      item.hasConflictingEvidence
    ));

    if (!isSufficient && !hasConflict
      && Number.isInteger(nextMissingPlanIndex) && hasLocalBudget) {
      nextAction = "retrieve";
      retrievalMode = "multi_hop";
      nextPlanIndex = nextMissingPlanIndex;
      currentOriginalSubQuestion = subQuestions[nextMissingPlanIndex];
      currentQuery = "";
      currentTargetPlanIndexes = [nextMissingPlanIndex];
    } else if (!isSufficient && !hasConflict && hasLocalBudget
      && gapRecoveryCount < gapRecoveryLimit) {
      const recoveryQuery = buildSupplementalQuery(state.question, missing);
      const previousQueries = new Set(
        (state.retrievalHistory ?? []).map((retrieval) => (
          normalizePlanQuestion(retrieval.query)
        )),
      );
      gapRecoveryCount += 1;
      if (recoveryQuery
        && !previousQueries.has(normalizePlanQuestion(recoveryQuery))) {
        const targetPlanIndexes = unresolvedCoverage.map((item) => item.planIndex);
        const recoveryItem = planItemForOriginalQuestion(
          recoveryQuery,
          `定向补充仍未覆盖的信息：${missing.join("；")}`,
          { required: false, kind: "gap_recovery", targetPlanIndexes },
        );
        nextPlanIndex = nextSubQuestions.length;
        nextPlanItems = [...nextPlanItems, recoveryItem];
        nextSubQuestions = [...nextSubQuestions, recoveryQuery];
        currentOriginalSubQuestion = recoveryQuery;
        currentQuery = recoveryQuery;
        currentTargetPlanIndexes = targetPlanIndexes;
        nextAction = "retrieve";
        retrievalMode = isSingleExecution
          ? "single_gap_recovery"
          : "multi_gap_recovery";
        fallbackReason = "coverage_gap_recovery";
      } else {
        fallbackReason = "gap_recovery_query_duplicate_or_empty";
      }
    }

    if (!isSufficient && nextAction === "generate"
      && suggested.nextAction === "web_search" && canWebSearch) {
      nextAction = "web_search";
    }

    return {
      planItems: nextPlanItems,
      subQuestions: nextSubQuestions,
      nextSubIdx: nextPlanIndex,
      currentOriginalSubQuestion,
      currentQuery,
      currentTargetPlanIndexes,
      skipCurrentRetrieval: false,
      coverage,
      evaluationEvidence,
      gapRecoveryCount,
      evaluation: {
        ...suggested,
        isSufficient,
        modelIsSufficient: Boolean(suggested.isSufficient),
        coverage,
        missing,
        nextAction,
        retrievalMode,
        fallbackReason,
        unresolvedPlanIndexes: unresolvedCoverage.map((item) => item.planIndex),
        contentSupportChecked: false,
      },
      execution: updateExecution(state.execution, {
        node: "evaluate",
        durationMs: Date.now() - startedAt,
        llmCalls: { evaluate: 1 },
        llmDurationMs: { evaluate: Date.now() - startedAt },
      }),
    };
  };

  const webSearchNode = async (state) => {
    const startedAt = Date.now();
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
      execution: updateExecution(state.execution, {
        node: "webSearch",
        durationMs: Date.now() - startedAt,
        webSearches: 1,
      }),
    };
  };

  const generateNode = async (state) => {
    const startedAt = Date.now();
    const supportedDocumentIds = new Set(
      (state.coverage ?? [])
        .filter((item) => item.isSufficient)
        .flatMap((item) => item.supportingDocumentIds ?? [])
        .map(String),
    );
    const citationDocuments = (state.evaluationEvidence ?? [])
      .filter((item) => supportedDocumentIds.has(String(item.documentId)))
      .map((item) => ({ ...item.document }));
    const localContext = buildLocalContext(citationDocuments);
    const context = [localContext, state.webContext]
      .filter(Boolean)
      .join("\n\n--- 联网补充 ---\n\n");
    const allowedLocalReferences = citationDocuments.length > 0
      ? `[本地1] 至 [本地${citationDocuments.length}]`
      : "无本地引用";
    const coverageSummary = (state.coverage ?? []).map((item) => [
      `- 计划第 ${item.planIndex + 1} 项：${item.question}`,
      `  已检索：${item.retrieved ? "是" : "否"}`,
      `  存在相关证据：${item.hasRelevantEvidence ? "是" : "否"}`,
      `  足以支持答案：${item.isSufficient ? "是" : "否"}`,
      `  状态：${item.status}`,
      item.isSufficient ? "" : `  未确认内容：${item.missing || "证据不足"}`,
    ].filter(Boolean).join("\n")).join("\n");
    const unresolvedQuestions = (state.coverage ?? [])
      .filter((item) => !item.isSufficient)
      .map((item) => item.missing || item.question);

    const {
      generationLlmCalls,
      citationCorrectionLlmCalls,
      generationDurationMs,
      citationCorrectionDurationMs,
      ...generated
    } = await generateWithValidatedCitations({
      prompt: `
你是一个严谨的中文阅读问答助手。请优先依据给定资料回答，不要编造。

资料：
${context || "（空）"}

用户最开始的问题：${state.question}

逐项证据覆盖状态：
${coverageSummary || "（无需本地证据）"}

要求：
1. 回答完整问题，不要只回答某个子问题。
2. 只陈述“足以支持答案”的计划项中由资料直接支持的事实关系；使用资料时以 [本地1]、[网页1] 这种标记注明依据。
3. 可用本地引用严格限定为：${allowedLocalReferences}。
4. 以下内容仍未获得充分证据：${unresolvedQuestions.join("；") || "无"}。对这些部分必须明确说明尚无法确认，不得用常识、模型记忆或错误前提补齐。
5. 不要虚构引用或 URL。
6. coverage 只是当前证据覆盖判断，并非完整事实蕴含证明；若资料存在冲突或措辞不能直接支持结论，应保守作答。
      `,
      question: state.question,
      context,
      citationDocuments,
    });
    return {
      ...generated,
      answerEvidenceDocuments: citationDocuments,
      execution: updateExecution(state.execution, {
        node: "generate",
        durationMs: Date.now() - startedAt,
        llmCalls: {
          generate: generationLlmCalls,
          citationCorrection: citationCorrectionLlmCalls,
        },
        llmDurationMs: {
          generate: generationDurationMs,
          citationCorrection: citationCorrectionDurationMs,
        },
      }),
    };
  };

  return new StateGraph(EbookRagState)
    .addNode("routeQuestion", routeQuestionNode)
    .addNode("directAnswer", directAnswerNode)
    .addNode("prepareSingleRetrieval", prepareSingleRetrievalNode)
    .addNode("decomposeQuestion", decomposeQuestionNode)
    .addNode("rewriteSubQuestion", rewriteSubQuestionNode)
    .addNode("retrieve", retrieveNode)
    .addNode("evaluate", evaluateNode)
    .addNode("webSearch", webSearchNode)
    .addNode("generate", generateNode)
    .addEdge(START, "routeQuestion")
    .addConditionalEdges("routeQuestion", (state) => state.routeMode, {
      direct: "directAnswer",
      single_retrieval: "prepareSingleRetrieval",
      multi_hop: "decomposeQuestion",
    })
    .addEdge("directAnswer", END)
    .addEdge("prepareSingleRetrieval", "retrieve")
    .addEdge("decomposeQuestion", "rewriteSubQuestion")
    .addConditionalEdges("rewriteSubQuestion", (state) => (
      state.skipCurrentRetrieval ? "skip" : "retrieve"
    ), {
      skip: "evaluate",
      retrieve: "retrieve",
    })
    .addEdge("retrieve", "evaluate")
    .addConditionalEdges("evaluate", (state) => {
      if (state.evaluation?.nextAction !== "retrieve") {
        return state.evaluation?.nextAction ?? "generate";
      }
      return state.evaluation.retrievalMode === "multi_hop"
        ? "retrieve_multi"
        : "retrieve_direct";
    }, {
      retrieve_direct: "retrieve",
      retrieve_multi: "rewriteSubQuestion",
      web_search: "webSearch",
      generate: "generate",
    })
    .addEdge("webSearch", "evaluate")
    .addEdge("generate", END)
    .compile();
}
