function unique(values) {
  return [...new Set(values)];
}

export function buildRewriteEvidence(
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

export function formatRewriteEvidence(evidence = []) {
  if (!evidence.length) return "（声明的依赖项没有检索证据）";
  return evidence.map((item) => [
    `[证据${item.evidenceIndex}]（来自计划第 ${item.subQuestionIndex + 1} 项）`,
    `实际检索查询：${item.retrievalQuery}`,
    `文档ID：${item.documentId}`,
    `章节：${item.chapterNum}，片段：${item.chunkIndex}`,
    `原文摘录：${String(item.excerpt ?? "").slice(0, 500)}`,
  ].join("\n")).join("\n\n---------\n\n");
}

export function buildEvaluationEvidence(retrievalHistory = [], maxEvidence = 6) {
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

export function formatEvaluationEvidence(evidence = []) {
  if (!evidence.length) return "（空）";
  return evidence.map((item) => [
    `[证据${item.evidenceIndex}]`,
    `来自实际检索：${item.retrievalQuery}`,
    `文档ID：${item.documentId}`,
    `章节：${item.chapterNum}，片段：${item.chunkIndex}`,
    `内容：${item.excerpt}`,
  ].join("\n")).join("\n\n---------\n\n");
}

export function normalizeCoverage({
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

export function createRewriteRecord({
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

export function validateRewrite(originalSubQuestion, result, priorEvidence) {
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

export function hasDependencyPlaceholder(question) {
  return DEPENDENCY_PLACEHOLDER_PATTERN.test(String(question ?? ""));
}
