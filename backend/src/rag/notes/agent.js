import { ChatOpenAI } from "@langchain/openai";
import { getConfig } from "../../config.js";
import { createLangSmithObservability } from "../../observability/langsmith.js";
import {
  calculateAgenticRagRecursionLimit,
  createAgenticRagGraph,
  createInitialState,
} from "../ebook/agent-graph.js";
import { createBochaWebSearch } from "../ebook/web-search.js";
import { KNOWLEDGE_BASES, validateRetrievalScope } from "../retrieval/index.js";
import { buildAgentResponse } from "../shared/agent-response.js";
import { AgentNotesRetriever } from "./agent-retriever.js";
import { createNotesRetriever } from "./index.js";
import {
  DEFAULT_AGENT_TIMEOUT_MS,
  DEFAULT_LLM_TIMEOUT_MS,
  invokeAgentWithTimeout,
} from "../shared/timeouts.js";

function mapNoteSource(document) {
  return {
    ...document,
    noteId: document.id,
    title: String(document.metadata?.title ?? ""),
  };
}

export function createNotesRag(options = {}) {
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
  const ownsRetriever = !options.retriever;
  const baseRetriever = options.retriever ?? createNotesRetriever({
    config,
    observability,
    embeddings: options.embeddings,
    elasticsearchClient: options.elasticsearchClient,
    milvusClient: options.milvusClient,
    elasticsearchRetriever: options.elasticsearchRetriever,
    milvusRetriever: options.milvusRetriever,
    reranker: options.reranker,
  });
  const retriever = new AgentNotesRetriever({ retriever: baseRetriever });
  const webSearch = options.webSearch
    ?? (config.webSearch.enabled ? createBochaWebSearch(config.webSearch) : null);
  const graph = createAgenticRagGraph({
    model,
    retriever,
    bookName: "生活笔记",
    knowledgeBase: KNOWLEDGE_BASES.LIFE_NOTES,
    maxContextDocuments: config.rag.maxContextDocuments,
    maxSubQuestions: config.rag.maxSubQuestions,
    maxPlanRepairAttempts: config.rag.maxPlanRepairAttempts,
    maxSingleRetrievals: config.rag.maxSingleRetrievals,
    maxGapRecoveryAttempts: config.rag.maxGapRecoveryAttempts,
    webSearch,
    maxWebSearches: config.webSearch.maxSearches,
    modelTimeoutMs: config.model.requestTimeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
  });

  return {
    config,
    graph,

    async ask(question, askOptions = {}) {
      const normalizedQuestion = String(question ?? "").trim();
      if (!normalizedQuestion) throw new Error("问题不能为空");
      const scope = validateRetrievalScope({
        knowledgeBase: KNOWLEDGE_BASES.LIFE_NOTES,
        userId: askOptions.userId,
      }, KNOWLEDGE_BASES.LIFE_NOTES);
      const maxRetrievals = askOptions.maxRetrievals ?? config.rag.maxRetrievals;
      const recursionLimit = calculateAgenticRagRecursionLimit({
        maxRetrievals,
        maxWebSearches: webSearch ? config.webSearch.maxSearches : 0,
      });
      const initialState = createInitialState(normalizedQuestion, {
        scope,
        k: askOptions.k ?? (
          config.notes.rerankEnabled
            ? config.rerank.topN
            : config.rag.retrievalK
        ),
        maxRetrievals,
      });
      const tracing = observability.createInvocation({
        scope: "notes",
        name: "memorag-notes-rag",
        metadata: { knowledge_base: KNOWLEDGE_BASES.LIFE_NOTES },
      });
      const result = await tracing.run(() => invokeAgentWithTimeout(
        graph,
        initialState,
        {
          recursionLimit,
          runName: "notes-agent-graph",
        },
        {
          timeoutMs: config.rag.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
        },
      ));
      return buildAgentResponse(result, tracing, { mapSource: mapNoteSource });
    },

    async close() {
      try {
        if (ownsRetriever && typeof baseRetriever.close === "function") {
          await baseRetriever.close();
        }
      } finally {
        if (!options.observability) await observability.close();
      }
    },
  };
}

export { AgentNotesRetriever } from "./agent-retriever.js";
