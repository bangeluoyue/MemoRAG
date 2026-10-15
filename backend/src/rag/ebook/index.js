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
import { EbookRetriever } from "./ebook-retriever.js";
import { DashScopeReranker } from "../shared/dashscope-reranker.js";
import { buildAgentResponse } from "../shared/agent-response.js";
import { createBochaWebSearch } from "./web-search.js";
import {
  DEFAULT_AGENT_TIMEOUT_MS,
  DEFAULT_LLM_TIMEOUT_MS,
  invokeAgentWithTimeout,
} from "../shared/timeouts.js";

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
    timeout: config.model.requestTimeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
    maxRetries: config.model.maxRetries ?? 0,
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
  const rankedRetriever = rerankConfig.enabled
    ? new RerankingBookRetriever({
      retriever: baseRetriever,
      reranker,
      candidateK: rerankConfig.candidateK,
      failureMode: rerankConfig.failureMode,
      traceOperation: observability.traceOperation,
    })
    : baseRetriever;
  const retriever = new EbookRetriever({ retriever: rankedRetriever });
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
    modelTimeoutMs: config.model.requestTimeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
    diagnosticLogger: options.diagnosticLogger,
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
        scope: {
          knowledgeBase: "ebook",
          bookId: String(askOptions.bookId ?? config.milvus.bookId),
        },
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
      const result = await tracing.run(() => invokeAgentWithTimeout(
        graph,
        initialState,
        {
          recursionLimit,
          runName: "ebook-agent-graph",
        },
        {
          timeoutMs: config.rag.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
        },
      ));
      return buildAgentResponse(result, tracing);
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
  EbookRetriever,
  MilvusBookRetriever,
  RerankingBookRetriever,
};
