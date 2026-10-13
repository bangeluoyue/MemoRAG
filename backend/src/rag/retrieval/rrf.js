import { matchesRetrievalScope } from "./contract.js";

export const DEFAULT_RRF_CONSTANT = 60;

function finiteScore(value) {
  if (value == null || value === "") return null;
  const score = Number(value);
  return Number.isFinite(score) ? score : null;
}

function sourceScore(document, source) {
  if (source === "elasticsearch") return finiteScore(document?.scores?.keyword);
  if (source === "milvus") return finiteScore(document?.scores?.vector);
  return null;
}

export function reciprocalRankFusion(
  rankedSources,
  { scope, rankConstant = DEFAULT_RRF_CONSTANT } = {},
) {
  const byId = new Map();
  let firstSeen = 0;
  const diagnostics = {
    missingLogicalIdCount: 0,
    scopeFilteredCount: 0,
  };

  for (const { source, documents = [] } of rankedSources) {
    documents.forEach((document, index) => {
      const id = String(document?.id ?? "").trim();
      if (!id) {
        diagnostics.missingLogicalIdCount += 1;
        return;
      }
      if (scope && !matchesRetrievalScope(document, scope)) {
        diagnostics.scopeFilteredCount += 1;
        return;
      }

      const rank = index + 1;
      const contribution = 1 / (rankConstant + rank);
      const existing = byId.get(id);
      const provenance = {
        source,
        rank,
        score: sourceScore(document, source),
      };

      if (!existing) {
        byId.set(id, {
          ...document,
          metadata: { ...(document.metadata ?? {}) },
          scores: {
            keyword: finiteScore(document?.scores?.keyword),
            vector: finiteScore(document?.scores?.vector),
            fusion: contribution,
            rerank: finiteScore(document?.scores?.rerank),
          },
          provenance: [provenance],
          fusionScore: contribution,
          _firstSeen: firstSeen,
        });
        firstSeen += 1;
        return;
      }

      existing.content ||= String(document.content ?? "");
      existing.metadata = { ...existing.metadata, ...(document.metadata ?? {}) };
      for (const scoreName of ["keyword", "vector", "rerank"]) {
        const score = finiteScore(document?.scores?.[scoreName]);
        if (score != null) existing.scores[scoreName] = score;
      }
      existing.fusionScore += contribution;
      existing.scores.fusion = existing.fusionScore;
      existing.provenance.push(provenance);
    });
  }

  const documents = [...byId.values()]
    .sort((left, right) => (
      right.fusionScore - left.fusionScore
      || left._firstSeen - right._firstSeen
    ))
    .map(({ _firstSeen, ...document }) => document);

  return { documents, diagnostics };
}
