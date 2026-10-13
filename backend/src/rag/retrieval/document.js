const SCORE_KEYS = ["keyword", "vector", "fusion", "rerank"];

export function createRetrievalDocument({
  id,
  knowledgeBase,
  content,
  metadata = {},
  scores = {},
  provenance = [],
  ...scopeFields
}) {
  const logicalId = String(id ?? "").trim();
  if (!logicalId) throw new Error("检索文档缺少稳定逻辑 ID");

  return {
    id: logicalId,
    knowledgeBase: String(knowledgeBase ?? ""),
    content: String(content ?? ""),
    ...scopeFields,
    metadata: { ...metadata },
    scores: Object.fromEntries(SCORE_KEYS.map((key) => {
      const value = scores[key];
      return [key, value != null && value !== "" && Number.isFinite(Number(value))
        ? Number(value)
        : null];
    })),
    provenance: provenance.map((item) => ({ ...item })),
  };
}
