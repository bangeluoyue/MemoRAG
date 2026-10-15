import { ChatOpenAI } from "@langchain/openai";
import { getConfig } from "../../config.js";
import { createLangSmithObservability } from "../../observability/langsmith.js";
import { createCitationGenerator } from "../ebook/services/citations.js";
import {
  createExecutionState,
  updateExecution,
} from "../ebook/services/execution.js";
import { KNOWLEDGE_BASES, validateRetrievalScope } from "../retrieval/index.js";
import { buildAgentResponse } from "../shared/agent-response.js";
import {
  DEFAULT_AGENT_TIMEOUT_MS,
  DEFAULT_LLM_TIMEOUT_MS,
  invokeRagWithTimeout,
} from "../shared/timeouts.js";
import { AgentNotesRetriever } from "./agent-retriever.js";
import { createNotesRetriever } from "./index.js";

function mapNoteSource(document) {
  return {
    ...document,
    noteId: document.id,
    title: String(document.metadata?.title ?? ""),
  };
}

function emptyCitationValidation() {
  return {
    status: "valid",
    localSourceCount: 0,
    initialReferences: [],
    initialInvalidReferences: [],
    correctionAttempts: 0,
    correctionFailed: false,
    removedInvalidReferences: [],
    finalReferences: [],
    finalInvalidReferences: [],
    contentSupportChecked: false,
  };
}

function strategyDescription(rerank) {
  if (rerank?.status === "success") {
    return "生活笔记 ES + Milvus 并行召回，RRF 融合后执行 Rerank";
  }
  if (rerank?.status === "fallback") {
    return "生活笔记 ES + Milvus 并行召回并使用 RRF；Rerank 失败，已回退到 RRF 排序";
  }
  if (rerank?.status === "skipped_empty") {
    return "生活笔记 ES + Milvus 并行召回并使用 RRF；当前无候选，Rerank 未执行";
  }
  return "生活笔记 ES + Milvus 并行召回并使用 RRF；Rerank 未启用";
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
  const generateWithValidatedCitations = createCitationGenerator({
    model,
    citationCorrectionLimit: 0,
    modelTimeoutMs: config.model.requestTimeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
  });

  return {
    config,

    async ask(question, askOptions = {}) {
      const normalizedQuestion = String(question ?? "").trim();
      if (!normalizedQuestion) throw new Error("问题不能为空");
      const scope = validateRetrievalScope({
        knowledgeBase: KNOWLEDGE_BASES.LIFE_NOTES,
        userId: askOptions.userId,
      }, KNOWLEDGE_BASES.LIFE_NOTES);
      const k = askOptions.k ?? (
        config.notes.rerankEnabled
          ? config.rerank.topN
          : config.rag.retrievalK
      );
      const tracing = observability.createInvocation({
        scope: "notes",
        name: "memorag-notes-hybrid-rag",
        metadata: { knowledge_base: KNOWLEDGE_BASES.LIFE_NOTES },
      });

      const result = await tracing.run(() => invokeRagWithTimeout(
        async (signal) => {
          let execution = createExecutionState();
          const retrievalStartedAt = Date.now();
          const retrievalResult = await retriever.searchWithTrace(
            normalizedQuestion,
            { k, scope },
          );
          const retrievalDurationMs = Date.now() - retrievalStartedAt;
          const documents = retrievalResult.documents ?? [];
          const retrievalTiming = {
            ...(retrievalResult.retrieval ?? {}),
            totalDurationMs: retrievalResult.retrieval?.totalDurationMs
              ?? retrievalDurationMs,
          };
          const rerank = retrievalResult.rerank ?? null;
          const rerankRequested = ["success", "fallback"].includes(rerank?.status);
          execution = updateExecution(execution, {
            node: "retrieve",
            durationMs: retrievalDurationMs,
            retrievalTiming,
            localRetrievals: 1,
            rerankRequests: rerankRequested ? 1 : 0,
            rerankFallbacks: rerank?.status === "fallback" ? 1 : 0,
          });

          let generation = "抱歉，当前没有检索到与问题相关的生活笔记，无法根据现有笔记确认。";
          let citationDocuments = [];
          let citationValidation = emptyCitationValidation();
          if (documents.length) {
            const generationStartedAt = Date.now();
            const context = documents.map((document, index) => [
              `[本地${index + 1}]`,
              `笔记ID：${document.id}`,
              `标题：${document.metadata?.title ?? ""}`,
              `内容：${document.content}`,
            ].join("\n")).join("\n\n---------\n\n");
            const generated = await generateWithValidatedCitations({
              prompt: `
你是一个严谨的生活笔记问答助手。只能根据本次检索到的用户笔记回答，不得使用模型记忆补充笔记中没有的事实。

检索到的笔记：
${context}

用户问题：${normalizedQuestion}

要求：
1. 只陈述上述笔记直接支持的事实；资料不足时明确说明无法根据现有笔记确认。
2. 使用笔记时标注 [本地N]，合法范围仅为 [本地1] 至 [本地${documents.length}]。
3. 不得虚构人物、时间、事件、note_id 或引用编号。
4. 如果笔记互相冲突，应指出冲突并保守作答。
              `,
              question: normalizedQuestion,
              context,
              citationDocuments: documents,
              signal,
            });
            generation = generated.generation;
            citationDocuments = generated.citationDocuments;
            citationValidation = generated.citationValidation;
            execution = updateExecution(execution, {
              node: "generate",
              durationMs: Date.now() - generationStartedAt,
              llmCalls: { generate: generated.generationLlmCalls },
              llmDurationMs: { generate: generated.generationDurationMs },
            });
          }

          return {
            question: normalizedQuestion,
            strategy: "hybrid",
            routeMode: "single_retrieval",
            routeReason: strategyDescription(rerank),
            planItems: [],
            planValidation: { status: "not_required" },
            subQuestions: [normalizedQuestion],
            rewriteHistory: [],
            retrievalHistory: [{
              subQuestionIndex: 0,
              targetPlanIndexes: [0],
              originalSubQuestion: normalizedQuestion,
              query: normalizedQuestion,
              rewriteApplied: false,
              fallbackReason: null,
              fallbackStrategy: null,
              documentIds: documents.map((document) => document.id),
              retrievedDocuments: documents,
              rerank,
              timing: retrievalTiming,
              errorCategory: null,
            }],
            retrievalCount: 1,
            documents,
            citationDocuments,
            localContext: "",
            webContext: "",
            webSources: [],
            webSearchCount: 0,
            evaluation: null,
            coverage: [],
            evaluationEvidence: [],
            gapRecoveryCount: 0,
            generation,
            citationValidation,
            execution,
          };
        },
        { timeoutMs: config.rag.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS },
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
