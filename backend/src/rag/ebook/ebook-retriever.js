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

function normalizeEbookDocument(document) {
  const vectorScore = finiteScore(document?.scores?.vector ?? document?.score);
  const fusionScore = finiteScore(
    document?.scores?.fusion ?? document?.rankFusionScore,
  );
  const rerankScore = finiteScore(
    document?.scores?.rerank ?? document?.rerankScore,
  );
  return {
    ...document,
    id: String(document?.id ?? ""),
    knowledgeBase: KNOWLEDGE_BASES.EBOOK,
    bookId: String(document?.bookId ?? ""),
    content: String(document?.content ?? ""),
    metadata: {
      ...(document?.metadata ?? {}),
      bookName: document?.bookName,
      chapterNum: document?.chapterNum,
      chunkIndex: document?.chunkIndex,
    },
    scores: {
      keyword: null,
      vector: vectorScore,
      fusion: fusionScore,
      rerank: rerankScore,
    },
    provenance: Array.isArray(document?.provenance)
      ? document.provenance.map((item) => ({ ...item }))
      : [{ source: "milvus", score: vectorScore }],
  };
}

function resolveScope(options = {}) {
  const legacyBookId = String(options.bookId ?? "").trim();
  const scope = options.scope ?? {
    knowledgeBase: KNOWLEDGE_BASES.EBOOK,
    bookId: legacyBookId,
  };
  const resolved = validateRetrievalScope(scope, KNOWLEDGE_BASES.EBOOK);
  if (legacyBookId && legacyBookId !== resolved.bookId) {
    throw new Error("bookId 与 scope.bookId 不一致");
  }
  return resolved;
}

export class EbookRetriever {
  constructor({ retriever }) {
    if (!retriever || (
      typeof retriever.search !== "function"
      && typeof retriever.searchWithTrace !== "function"
    )) {
      throw new Error("EbookRetriever 缺少可用的底层 retriever");
    }
    this.retriever = retriever;
  }

  async search(query, options = {}) {
    const result = await this.searchWithTrace(query, options);
    return result.documents;
  }

  async searchWithTrace(query, options = {}) {
    const scope = resolveScope(options);
    const k = positiveResultLimit(options.k, 5);
    const baseResult = typeof this.retriever.searchWithTrace === "function"
      ? await this.retriever.searchWithTrace(query, { k, bookId: scope.bookId })
      : {
        documents: await this.retriever.search(query, {
          k,
          bookId: scope.bookId,
        }),
        retrieval: {},
        rerank: null,
      };
    const candidates = (baseResult.documents ?? []).map(normalizeEbookDocument);
    const documents = candidates.filter((document) => (
      document.id && matchesRetrievalScope(document, scope)
    ));

    return {
      ...baseResult,
      documents,
      retrieval: {
        ...(baseResult.retrieval ?? {}),
        adapterFilteredOutCount: candidates.length - documents.length,
      },
    };
  }
}
