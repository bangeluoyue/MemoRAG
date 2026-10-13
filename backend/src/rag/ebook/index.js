import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { getConfig } from "../../config.js";
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
    localRetrievalCount: execution?.localRetrievalCount ?? 0,
    rerankRequestCount: execution?.rerankRequestCount ?? 0,
    rerankFallbackCount: execution?.rerankFallbackCount ?? 0,
    webSearchCount: execution?.webSearchCount ?? 0,
    finalContextDocumentCount,
  };
}

export function createEbookRag(options = {}) {
  const config = options.config ?? getConfig();
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

      const result = await graph.invoke(createInitialState(normalizedQuestion, {
        bookId: askOptions.bookId ?? config.milvus.bookId,
        k: askOptions.k
          ?? (rerankConfig.enabled ? rerankConfig.topN : config.rag.retrievalK),
        maxRetrievals,
      }), { recursionLimit });
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
            documentIds: retrieval.documentIds,
            rerank: retrieval.rerank ?? null,
          })),
          retrievalCount: result.retrievalCount ?? 0,
          webSearchCount: result.webSearchCount ?? 0,
          evaluation: result.evaluation,
          citationValidation: result.citationValidation ?? null,
          execution: buildExecutionTrace(
            result.execution,
            citationDocuments.length,
          ),
        },
      };
    },

    async close() {
      if (!options.milvusClient && typeof milvusClient.closeConnection === "function") {
        await milvusClient.closeConnection();
      }
    },
  };
}

export {
  calculateAgenticRagRecursionLimit,
  createAgenticRagGraph,
  createInitialState,
  createMilvusClient,
  DashScopeReranker,
  MilvusBookRetriever,
  RerankingBookRetriever,
};
