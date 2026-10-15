import { CoreDecisionSchema } from "../schemas.js";
import { buildCompactLocalContext } from "../services/document-merge.js";
import { updateExecution } from "../services/execution.js";
import {
  AgentInvocationTimeoutError,
  ModelInvocationTimeoutError,
  invokeModelWithTimeout,
} from "../../shared/timeouts.js";

function safeFallbackAction({ canRetrieve, canWebSearch, documentCount }) {
  if (canRetrieve) return "retrieve";
  if (documentCount === 0 && canWebSearch) return "web_search";
  return "generate";
}

function errorCategory(error) {
  if (error instanceof ModelInvocationTimeoutError) return "decision_timeout";
  return "decision_model_error";
}

export function createCoreDecisionNode({
  model,
  webSearch,
  maxWebSearches,
  modelTimeoutMs,
  decisionTimeoutMs,
}) {
  const modelLimit = Number.isFinite(Number(modelTimeoutMs))
    && Number(modelTimeoutMs) > 0
    ? Number(modelTimeoutMs)
    : Number.POSITIVE_INFINITY;
  const decisionLimit = Number.isFinite(Number(decisionTimeoutMs))
    && Number(decisionTimeoutMs) > 0
    ? Number(decisionTimeoutMs)
    : 15000;
  const timeoutMs = Math.min(modelLimit, decisionLimit);

  return async function coreDecisionNode(state, runnableConfig) {
    const startedAt = Date.now();
    const nextSubIdx = state.nextSubIdx ?? 0;
    const canRetrieve = nextSubIdx < (state.subQuestions?.length ?? 0)
      && (state.retrievalCount ?? 0) < state.maxRetrievals;
    const canWebSearch = Boolean(webSearch)
      && (state.webSearchCount ?? 0) < maxWebSearches;
    const context = buildCompactLocalContext(state.documents, {
      maxDocuments: 4,
      maxContentCharacters: 350,
    });
    let decision;

    try {
      const decider = model.withStructuredOutput(CoreDecisionSchema);
      const suggested = await invokeModelWithTimeout(decider, `
你是《${state.bookName || "电子书"}》RAG 的轻量流程决策器。只根据当前检索摘要判断下一步，不回答用户问题，也不得补充摘要中没有的事实。

原始问题：${state.question}
已完成本地检索：${state.retrievalCount} 次
还有计划内子问题可检索：${canRetrieve}
允许联网补充：${canWebSearch}

当前本地检索摘要：
${context || "（空）"}

请选择一个 nextAction：
- retrieve：当前资料不足，且还有计划内子问题与本地检索预算。
- web_search：本地资料不足、已经不应继续本地检索，且允许联网；同时给出不含虚构事实的 web_query。
- generate：现有资料已可回答，或预算已用尽，只能基于现有资料保守作答。

不得自行创建新的本地查询，不得把尚未确认的人物或事件写入 web_query。
reason 只说明资料是否足够、还缺什么或为何选择下一步，不要复述、补全或推导人物关系和情节事实。
      `, {
        stage: "decision",
        timeoutMs,
        signal: runnableConfig?.signal,
      });
      let nextAction = suggested.nextAction;
      let fallbackReason = null;
      if (nextAction === "retrieve" && !canRetrieve) {
        nextAction = canWebSearch && state.documents.length === 0
          ? "web_search"
          : "generate";
        fallbackReason = "local_retrieval_budget_exhausted";
      }
      if (nextAction === "web_search" && !canWebSearch) {
        nextAction = canRetrieve ? "retrieve" : "generate";
        fallbackReason = "web_search_unavailable_or_exhausted";
      }
      decision = {
        ...suggested,
        nextAction,
        fallbackReason,
        status: fallbackReason ? "bounded_override" : "model_decision",
      };
    } catch (error) {
      if (error instanceof AgentInvocationTimeoutError) throw error;
      const category = errorCategory(error);
      decision = {
        nextAction: safeFallbackAction({
          canRetrieve,
          canWebSearch,
          documentCount: state.documents.length,
        }),
        reason: "轻量决策调用不可用，已按剩余预算和现有证据安全回退",
        web_query: canWebSearch && state.documents.length === 0
          ? state.question
          : undefined,
        status: "safe_fallback",
        fallbackReason: category,
      };
    }

    const durationMs = Date.now() - startedAt;
    return {
      evaluation: {
        ...decision,
        canRetrieve,
        canWebSearch,
        decisionTimeoutMs: timeoutMs,
      },
      currentOriginalSubQuestion: state.subQuestions?.[nextSubIdx] ?? "",
      currentQuery: state.subQuestions?.[nextSubIdx] ?? "",
      currentTargetPlanIndexes: canRetrieve ? [nextSubIdx] : [],
      execution: updateExecution(state.execution, {
        node: "decision",
        durationMs,
        llmCalls: { decision: 1 },
        llmDurationMs: { decision: durationMs },
      }),
    };
  };
}
