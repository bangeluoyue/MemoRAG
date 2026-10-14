import {
  KNOWLEDGE_BASES,
  matchesRetrievalScope,
  positiveResultLimit,
  validateRetrievalScope,
} from "../retrieval/index.js";

function finiteScore(value) {
  if (value == null || value === "") return null;
  const score = Number(value);
  return Number.isFinite(score) ? score : null;
}

function normalizeAgentDocument(document) {
  const score = finiteScore(document?.scores?.rerank)
    ?? finiteScore(document?.scores?.fusion)
    ?? finiteScore(document?.scores?.vector)
    ?? finiteScore(document?.scores?.keyword)
    ?? 0;
  return {
    ...document,
    id: String(document?.id ?? ""),
    knowledgeBase: String(document?.knowledgeBase ?? ""),
    userId: String(document?.userId ?? ""),
    content: String(document?.content ?? ""),
    metadata: { ...(document?.metadata ?? {}) },
    score,
  };
}

export class AgentNotesRetriever {
  constructor({ retriever }) {
    if (!retriever || (
      typeof retriever.search !== "function"
      && typeof retriever.searchWithTrace !== "function"
    )) {
      throw new Error("AgentNotesRetriever 缺少可用的生活笔记 retriever");
    }
    this.retriever = retriever;
  }

  async search(query, options = {}) {
    const result = await this.searchWithTrace(query, options);
    return result.documents;
  }

  async searchWithTrace(query, { k = 8, scope } = {}) {
    const resolvedScope = validateRetrievalScope(
      scope,
      KNOWLEDGE_BASES.LIFE_NOTES,
    );
    const limit = positiveResultLimit(k, 8);
    const result = typeof this.retriever.searchWithTrace === "function"
      ? await this.retriever.searchWithTrace(query, {
        k: limit,
        scope: resolvedScope,
      })
      : {
        documents: await this.retriever.search(query, {
          k: limit,
          scope: resolvedScope,
        }),
        trace: null,
      };
    const candidates = (result.documents ?? []).map(normalizeAgentDocument);
    const documents = candidates.filter((document) => (
      document.id && matchesRetrievalScope(document, resolvedScope)
    ));
    const trace = result.trace ?? {};

    return {
      documents,
      rerank: trace.rerank ?? null,
      retrieval: {
        ...trace,
        adapterFilteredOutCount: candidates.length - documents.length,
      },
    };
  }
}
