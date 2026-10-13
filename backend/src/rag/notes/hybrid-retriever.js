import { RerankError } from "../shared/dashscope-reranker.js";
import {
  KNOWLEDGE_BASES,
  positiveResultLimit,
  reciprocalRankFusion,
  validateRetrievalScope,
} from "../retrieval/index.js";

function safeFailureCategory(source, error) {
  if (error instanceof RerankError) return error.code;
  const name = String(error?.name ?? "ERROR").toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .slice(0, 60);
  return `${source.toUpperCase()}_${name || "ERROR"}`;
}

function backendDiagnostic(result) {
  return {
    status: "success",
    returnedCount: result.documents.length,
    missingLogicalIdCount: result.diagnostics?.missingLogicalIdCount ?? 0,
    scopeFilteredCount: result.diagnostics?.scopeFilteredCount ?? 0,
  };
}

export class HybridNotesRetriever {
  constructor({
    elasticsearchRetriever,
    milvusRetriever,
    reranker = null,
    keywordK = 20,
    vectorK = 20,
    rerankFailureMode = "fallback",
    observability = null,
    closeResources = null,
  }) {
    this.elasticsearchRetriever = elasticsearchRetriever;
    this.milvusRetriever = milvusRetriever;
    this.reranker = reranker;
    this.keywordK = keywordK;
    this.vectorK = vectorK;
    this.rerankFailureMode = rerankFailureMode;
    this.observability = observability;
    this.closeResources = closeResources;
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
    const rawQuery = String(query ?? "");
    const tracing = this.observability?.createInvocation({
      scope: "notes",
      name: "memorag-notes-hybrid-retrieval",
      metadata: { knowledge_base: resolvedScope.knowledgeBase },
    });
    const run = () => this.#retrieve(rawQuery, {
      k: positiveResultLimit(k, 8),
      scope: resolvedScope,
    });
    const result = tracing ? await tracing.run(run) : await run();
    return {
      ...result,
      trace: {
        ...result.trace,
        langsmith: tracing?.summary() ?? null,
      },
    };
  }

  async close() {
    if (this.closeResources) await this.closeResources();
  }

  async #trace(name, operation, metadata) {
    if (!this.observability?.traceOperation) return operation();
    return this.observability.traceOperation(
      name,
      operation,
      metadata,
      { scope: "notes" },
    );
  }

  async #retrieve(query, { k, scope }) {
    const startedAt = Date.now();
    if (!query.trim()) {
      return {
        documents: [],
        trace: {
          status: "empty_query",
          query,
          backends: {},
          totalDurationMs: Date.now() - startedAt,
        },
      };
    }

    const keywordK = Math.max(positiveResultLimit(this.keywordK, 20), k);
    const vectorK = Math.max(positiveResultLimit(this.vectorK, 20), k);
    const tasks = [
      this.#trace(
        "notes-elasticsearch-retrieve",
        () => this.elasticsearchRetriever.searchWithTrace(query, {
          k: keywordK,
          scope,
        }),
        { query, knowledge_base: scope.knowledgeBase, requested_top_n: keywordK },
      ),
      this.#trace(
        "notes-milvus-retrieve",
        () => this.milvusRetriever.searchWithTrace(query, {
          k: vectorK,
          scope,
        }),
        { query, knowledge_base: scope.knowledgeBase, requested_top_n: vectorK },
      ),
    ];
    const [keywordResult, vectorResult] = await Promise.allSettled(tasks);
    const backends = {};
    const rankedSources = [];

    if (keywordResult.status === "fulfilled") {
      backends.elasticsearch = backendDiagnostic(keywordResult.value);
      rankedSources.push({
        source: "elasticsearch",
        documents: keywordResult.value.documents,
      });
    } else {
      backends.elasticsearch = {
        status: "error",
        errorCategory: safeFailureCategory("elasticsearch", keywordResult.reason),
      };
    }
    if (vectorResult.status === "fulfilled") {
      backends.milvus = backendDiagnostic(vectorResult.value);
      rankedSources.push({
        source: "milvus",
        documents: vectorResult.value.documents,
      });
    } else {
      backends.milvus = {
        status: "error",
        errorCategory: safeFailureCategory("milvus", vectorResult.reason),
      };
    }

    const fusion = reciprocalRankFusion(rankedSources, { scope });
    const backendErrorCount = Object.values(backends)
      .filter((backend) => backend.status === "error").length;
    let documents = fusion.documents;
    let rerank = {
      enabled: Boolean(this.reranker),
      status: this.reranker ? "skipped_empty" : "disabled",
      candidateCount: documents.length,
      returnedCount: 0,
    };

    if (this.reranker && documents.length) {
      try {
        const rankings = await this.#trace(
          "notes-rerank",
          () => this.reranker.rerank(query, documents, { topN: k }),
          {
            query,
            knowledge_base: scope.knowledgeBase,
            document_ids: documents.map((document) => document.id),
            candidate_count: documents.length,
            requested_top_n: k,
          },
        );
        documents = rankings.map(({ index, score, rank }) => ({
          ...documents[index],
          scores: { ...documents[index].scores, rerank: score },
          rerankScore: score,
          rerankRank: rank,
        }));
        rerank = {
          enabled: true,
          status: "success",
          candidateCount: fusion.documents.length,
          returnedCount: documents.length,
        };
      } catch (error) {
        if (this.rerankFailureMode === "error") throw error;
        documents = documents.slice(0, k);
        rerank = {
          enabled: true,
          status: "fallback",
          failureCategory: safeFailureCategory("rerank", error),
          candidateCount: fusion.documents.length,
          returnedCount: documents.length,
        };
      }
    } else {
      documents = documents.slice(0, k);
      rerank.returnedCount = documents.length;
    }

    const status = backendErrorCount === 2
      ? "failed"
      : backendErrorCount === 1
        ? "partial"
        : documents.length ? "success" : "empty";
    return {
      documents,
      trace: {
        status,
        query,
        backends,
        fusion: {
          candidateCount: fusion.documents.length,
          missingLogicalIdCount: fusion.diagnostics.missingLogicalIdCount,
          scopeFilteredCount: fusion.diagnostics.scopeFilteredCount,
        },
        rerank,
        totalDurationMs: Date.now() - startedAt,
      },
    };
  }
}
