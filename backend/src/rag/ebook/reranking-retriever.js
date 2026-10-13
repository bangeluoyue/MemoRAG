import { RerankError } from "../shared/dashscope-reranker.js";

function documentId(document) {
  return String(document?.id ?? "");
}

function safeFailureCategory(error) {
  return error instanceof RerankError ? error.code : "RERANK_UNKNOWN_ERROR";
}

export class RerankingBookRetriever {
  constructor({
    retriever,
    reranker,
    candidateK = 20,
    failureMode = "fallback",
    traceOperation = null,
  }) {
    this.retriever = retriever;
    this.reranker = reranker;
    this.candidateK = candidateK;
    this.failureMode = failureMode;
    this.traceOperation = traceOperation;
  }

  async search(query, options) {
    const result = await this.searchWithTrace(query, options);
    return result.documents;
  }

  async searchWithTrace(query, { k, bookId }) {
    const startedAt = Date.now();
    const requestedTopN = Math.max(1, Math.floor(Number(k) || 1));
    const candidateK = Math.max(this.candidateK, requestedTopN);
    const baseResult = typeof this.retriever.searchWithTrace === "function"
      ? await this.retriever.searchWithTrace(query, { k: candidateK, bookId })
      : {
        documents: await this.retriever.search(query, {
          k: candidateK,
          bookId,
        }),
        retrieval: {},
      };
    const candidates = baseResult.documents;
    const sameBookCandidates = candidates.filter((document) => (
      String(document.bookId) === String(bookId)
    ));
    const baseTrace = {
      enabled: true,
      candidateK,
      requestedTopN,
      candidateCount: candidates.length,
      filteredOutCount: candidates.length - sameBookCandidates.length,
      originalDocumentIds: sameBookCandidates.map(documentId),
    };

    if (!sameBookCandidates.length) {
      return {
        documents: [],
        retrieval: {
          ...(baseResult.retrieval ?? {}),
          rerankDurationMs: 0,
          totalDurationMs: Date.now() - startedAt,
        },
        rerank: {
          ...baseTrace,
          status: "skipped_empty",
          returnedCount: 0,
          documentIds: [],
          rankChanges: [],
        },
      };
    }

    const rerankStartedAt = Date.now();
    try {
      const rerank = () => this.reranker.rerank(query, sameBookCandidates, {
        topN: requestedTopN,
      });
      const rankings = this.traceOperation
        ? await this.traceOperation("rerank", rerank, {
          query,
          document_ids: sameBookCandidates.map(documentId),
          candidate_count: sameBookCandidates.length,
          requested_top_n: requestedTopN,
        })
        : await rerank();
      const mappedDocuments = rankings.map(({ index, score, rank }) => ({
        ...sameBookCandidates[index],
        originalRank: index + 1,
        rerankScore: score,
        rerankRank: rank,
        rerankStatus: "success",
        rankFusionScore: 1 / (60 + rank),
      }));
      const documents = mappedDocuments.filter((document) => (
        String(document.bookId) === String(bookId)
      ));

      return {
        documents,
        retrieval: {
          ...(baseResult.retrieval ?? {}),
          rerankDurationMs: Date.now() - rerankStartedAt,
          totalDurationMs: Date.now() - startedAt,
        },
        rerank: {
          ...baseTrace,
          status: "success",
          postFilteredOutCount: mappedDocuments.length - documents.length,
          returnedCount: documents.length,
          documentIds: documents.map(documentId),
          rankChanges: documents.map((document) => ({
            documentId: documentId(document),
            originalRank: document.originalRank,
            rerankRank: document.rerankRank,
          })),
        },
      };
    } catch (error) {
      if (this.failureMode === "error") throw error;

      const documents = sameBookCandidates.slice(0, requestedTopN)
        .map((document, index) => ({
          ...document,
          originalRank: index + 1,
          rerankStatus: "fallback",
          rankFusionScore: 1 / (60 + index + 1),
        }));
      return {
        documents,
        retrieval: {
          ...(baseResult.retrieval ?? {}),
          rerankDurationMs: Date.now() - rerankStartedAt,
          totalDurationMs: Date.now() - startedAt,
        },
        rerank: {
          ...baseTrace,
          status: "fallback",
          failureCategory: safeFailureCategory(error),
          returnedCount: documents.length,
          documentIds: documents.map(documentId),
          rankChanges: documents.map((document) => ({
            documentId: documentId(document),
            originalRank: document.originalRank,
            rerankRank: null,
          })),
        },
      };
    }
  }
}
