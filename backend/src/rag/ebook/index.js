import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { getConfig } from "../../config.js";
import { createLangSmithObservability } from "../../observability/langsmith.js";
import {
  calculateAgenticRagRecursionLimit,
  createAgenticRagGraph,
  createInitialState,
} from "./agent-graph.js";
import { createMilvusClient, MilvusBookRetriever } from "./milvus-retriever.js";
import { RerankingBookRetriever } from "./reranking-retriever.js";
import { DashScopeReranker } from "../shared/dashscope-reranker.js";
import { createBochaWebSearch } from "./web-search.js";

function buildExecutionTrace(execution, finalContextDocumentCount) {
  const llmCalls = { ...(execution?.llmCalls ?? {}) };
  return {
    totalDurationMs: Math.max(0, Date.now() - Number(execution?.startedAtMs ?? Date.now())),
    nodes: execution?.nodes ?? {},
    llmCallCount: Object.values(llmCalls)
      .reduce((total, count) => total + Number(count ?? 0), 0),
    llmCalls,
    llmDurationMs: execution?.llmDurationMs ?? {},
    retrievalStages: execution?.retrievalStages ?? {},
    localRetrievalCount: execution?.localRetrievalCount ?? 0,
    rerankRequestCount: execution?.rerankRequestCount ?? 0,
    rerankFallbackCount: execution?.rerankFallbackCount ?? 0,
    webSearchCount: execution?.webSearchCount ?? 0,
    finalContextDocumentCount,
  };
}

export function createEbookRag(options = {}) {
  const config = options.config ?? getConfig();
  const observability = options.observability ?? createLangSmithObservability(
    config.langsmith,
    { client: options.langsmithClient },
  );
  const model = options.model ?? new ChatOpenAI({
    model: config.model.chatModel,
    apiKey: config.model.apiKey,
    temperature: 0,
    configuration: config.model.baseUrl
      ? { baseURL: config.model.baseUrl }
      : undefined,
  });
  const embeddings = options.embeddings ?? new OpenAIEmbeddings({
    model: config.model.embeddingModel,
    apiKey: config.model.apiKey,
    dimensions: config.model.embeddingDimension,
    configuration: config.model.baseUrl
      ? { baseURL: config.model.baseUrl }
      : undefined,
  });
  const milvusClient = options.milvusClient ?? createMilvusClient(config.milvus);
  const baseRetriever = options.retriever ?? new MilvusBookRetriever({
    client: milvusClient,
    embeddings,
    collectionName: config.milvus.collectionName,
    embeddingDimension: config.model.embeddingDimension,
    nprobe: config.milvus.nprobe,
  });
  const rerankConfig = config.rerank ?? { enabled: false };
  const reranker = rerankConfig.enabled
    ? (options.reranker ?? new DashScopeReranker({
      apiKey: rerankConfig.apiKey,
      model: rerankConfig.model,
      baseUrl: rerankConfig.url,
      timeoutMs: rerankConfig.timeoutMs,
    }))
    : null;
  const retriever = rerankConfig.enabled
    ? new RerankingBookRetriever({
      retriever: baseRetriever,
      reranker,
      candidateK: rerankConfig.candidateK,
      failureMode: rerankConfig.failureMode,
      traceOperation: observability.traceOperation,
    })
    : baseRetriever;
  const webSearch = options.webSearch
    ?? (config.webSearch.enabled ? createBochaWebSearch(config.webSearch) : null);
  const graph = createAgenticRagGraph({
    model,
    retriever,
    bookName: config.rag.bookName,
    maxContextDocuments: config.rag.maxContextDocuments,
    maxSubQuestions: config.rag.maxSubQuestions,
    maxPlanRepairAttempts: config.rag.maxPlanRepairAttempts,
    maxSingleRetrievals: config.rag.maxSingleRetrievals,
    maxGapRecoveryAttempts: config.rag.maxGapRecoveryAttempts,
    webSearch,
    maxWebSearches: config.webSearch.maxSearches,
  });

  return {
    config,
    graph,

    async ask(question, askOptions = {}) {
      const normalizedQuestion = String(question ?? "").trim();
      if (!normalizedQuestion) throw new Error("问题不能为空");
      const maxRetrievals = askOptions.maxRetrievals ?? config.rag.maxRetrievals;
      const recursionLimit = calculateAgenticRagRecursionLimit({
        maxRetrievals,
        maxWebSearches: webSearch ? config.webSearch.maxSearches : 0,
      });

      const initialState = createInitialState(normalizedQuestion, {
        bookId: askOptions.bookId ?? config.milvus.bookId,
        k: askOptions.k
          ?? (rerankConfig.enabled ? rerankConfig.topN : config.rag.retrievalK),
        maxRetrievals,
      });
      const tracing = observability.createInvocation({
        scope: "ebook",
        name: "memorag-ebook-rag",
        metadata: {
          knowledge_base: "ebook",
        },
      });
      const result = await tracing.run(() => graph.invoke(initialState, {
        recursionLimit,
        runName: "ebook-agent-graph",
      }));
      const citationDocuments = result.citationDocuments ?? result.documents ?? [];

      return {
        answer: result.generation,
        route: {
          strategy: result.strategy,
          mode: result.routeMode,
          reason: result.routeReason,
        },
        sources: citationDocuments.map((document, index) => ({
          ...document,
          reference: `本地${index + 1}`,
        })),
        webSources: (result.webSources ?? []).map((source, index) => ({
          reference: `网页${index + 1}`,
          ...source,
        })),
        trace: {
          subQuestions: result.subQuestions ?? [],
          plan: result.planItems ?? [],
          planValidation: result.planValidation ?? null,
          rewriteHistory: result.rewriteHistory ?? [],
          retrievals: (result.retrievalHistory ?? []).map((retrieval) => ({
            subQuestionIndex: retrieval.subQuestionIndex,
            originalSubQuestion: retrieval.originalSubQuestion,
            query: retrieval.query,
            rewriteApplied: retrieval.rewriteApplied,
            fallbackReason: retrieval.fallbackReason ?? null,
            fallbackStrategy: retrieval.fallbackStrategy ?? null,
            targetPlanIndexes: retrieval.targetPlanIndexes ?? [],
            documentIds: retrieval.documentIds,
            rerank: retrieval.rerank ?? null,
            timing: retrieval.timing ?? null,
            status: retrieval.errorCategory ? "retrieval_error" : (
              (retrieval.targetPlanIndexes ?? [retrieval.subQuestionIndex])
                .map((planIndex) => result.coverage?.find((item) => (
                  item.planIndex === planIndex
                ))?.status)
                .filter(Boolean)[0]
              ?? (retrieval.documentIds.length
                ? "retrieved_not_supportive"
                : "no_hits_for_query")
            ),
            errorCategory: retrieval.errorCategory ?? null,
          })),
          retrievalCount: result.retrievalCount ?? 0,
          webSearchCount: result.webSearchCount ?? 0,
          evaluation: result.evaluation,
          coverage: result.coverage ?? [],
          gapRecoveryCount: result.gapRecoveryCount ?? 0,
          citationValidation: result.citationValidation ?? null,
          execution: buildExecutionTrace(
            result.execution,
            citationDocuments.length,
          ),
          langsmith: tracing.summary(),
        },
      };
    },

    async close() {
      try {
        if (!options.milvusClient && typeof milvusClient.closeConnection === "function") {
          await milvusClient.closeConnection();
        }
      } finally {
        await observability.close();
      }
    },
  };
}

export {
  calculateAgenticRagRecursionLimit,
  createAgenticRagGraph,
  createInitialState,
  createLangSmithObservability,
  createMilvusClient,
  DashScopeReranker,
  MilvusBookRetriever,
  RerankingBookRetriever,
};
