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
  return documents.map((document, index) => {
    if (document.knowledgeBase === "life_notes") {
      return [
        `[本地${index + 1}]`,
        `笔记ID：${document.id}`,
        `标题：${document.metadata?.title ?? ""}`,
        `相关度：${Number(document.score ?? 0).toFixed(4)}`,
        `内容：${document.content}`,
      ].join("\n");
    }
    return [
      `[本地${index + 1}]`,
      `文档ID：${document.id}`,
      `书名：${document.bookName}`,
      `章节：${document.chapterNum}`,
      `片段序号：${document.chunkIndex}`,
      `相似度：${Number(document.score).toFixed(4)}`,
      `内容：${document.content}`,
    ].join("\n");
  }).join("\n\n---------\n\n");
}

export function buildCompactLocalContext(
  documents = [],
  { maxDocuments = 6, maxContentCharacters = 600 } = {},
) {
  return documents.slice(0, maxDocuments).map((document, index) => {
    if (document.knowledgeBase === "life_notes") {
      return [
        `[本地${index + 1}]`,
        `笔记ID：${document.id}`,
        `标题：${document.metadata?.title ?? ""}`,
        `内容：${String(document.content ?? "").slice(0, maxContentCharacters)}`,
      ].join("\n");
    }
    return [
      `[本地${index + 1}]`,
      `文档ID：${document.id}`,
      `章节：${document.chapterNum}，片段：${document.chunkIndex}`,
      `内容：${String(document.content ?? "").slice(0, maxContentCharacters)}`,
    ].join("\n");
  }).join("\n\n---------\n\n");
}
