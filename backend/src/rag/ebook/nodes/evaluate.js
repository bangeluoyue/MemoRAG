import { EvaluateSchema } from "../schemas.js";
import {
  buildEvaluationEvidence,
  formatEvaluationEvidence,
  normalizeCoverage,
} from "../services/evidence.js";
import { updateExecution } from "../services/execution.js";
import {
  buildSupplementalQuery,
  compactWebContext,
  normalizePlanQuestion,
  planItemForOriginalQuestion,
} from "../services/planning.js";
import { invokeModelWithTimeout } from "../../shared/timeouts.js";

function unique(values) {
  return [...new Set(values)];
}

export function createEvaluateNode({
  model,
  singleRetrievalLimit,
  gapRecoveryLimit,
  webSearch,
  maxWebSearches,
  modelTimeoutMs,
}) {
  return async function evaluateNode(state, runnableConfig) {
    const startedAt = Date.now();
    const subQuestions = state.subQuestions ?? [];
    const planItems = state.planItems ?? [];
    const requiredPlanItems = planItems.filter((item) => item.required !== false);
    const nextSubIdx = state.nextSubIdx ?? 0;
    const isSingleExecution = state.routeMode === "single_retrieval"
      || state.planValidation?.status === "fallback_single";
    const singleRetrievalBudget = Math.min(
      state.maxRetrievals,
      singleRetrievalLimit,
    );
    const localRetrievalLimit = isSingleExecution
      ? singleRetrievalBudget
      : state.maxRetrievals;
    const hasLocalBudget = state.retrievalCount < localRetrievalLimit;
    const canWebSearch = Boolean(webSearch)
      && (state.webSearchCount ?? 0) < maxWebSearches;
    const completedByIndex = new Map(
      (state.retrievalHistory ?? []).map((retrieval) => [
        retrieval.subQuestionIndex,
        retrieval,
      ]),
    );
    const questionPlan = requiredPlanItems.map((planItem, index) => {
      const completed = completedByIndex.get(index);
      const details = `；目的：${planItem.purpose}；依赖：${planItem.dependsOn.join("、") || "无"}`;
      if (!completed) return `${index + 1}. ${planItem.question}${details}（该计划项未直接检索）`;
      return `${index + 1}. ${planItem.question}${details}（已检索，实际查询：${completed.query}）`;
    }).join("\n");
    const evaluationEvidence = buildEvaluationEvidence(state.retrievalHistory, 6);

    const evaluator = model.withStructuredOutput(EvaluateSchema);
    const suggested = await invokeModelWithTimeout(evaluator, `
你是 RAG 的逐项证据覆盖评估器。你只能判断当前证据快照是否相关、是否足以支持答案，不得把“检索过”或“引用编号合法”当作“证据充分”。

原始问题：${state.question}
当前路由模式：${state.routeMode}
必须回答的计划项：
${questionPlan || "（无）"}

已完成本地检索：${state.retrievalCount} 次
还能本地检索：${hasLocalBudget}
还能联网搜索：${canWebSearch}

本地证据快照（跨检索轮次平衡选取，最多 6 条）：
${formatEvaluationEvidence(evaluationEvidence)}

联网补充（紧凑视图）：
${compactWebContext(state.webContext) || "（空）"}

规则：
1. coverage 必须为每个必须回答的计划项各返回一项，planIndex 从 1 开始。
2. hasRelevantEvidence 表示至少一条证据与该项直接相关；isSufficient 表示证据已足以支持该项答案。二者必须分别判断。
3. supportingEvidenceIndexes 只能填写上面存在的 [证据N]。即使编号合法，若内容不相关也必须将 hasRelevantEvidence 设为 false。
4. 资料冲突时 hasConflictingEvidence=true 且 isSufficient=false，不得擅自选择一方。
5. 只有联网补充中存在直接证据时才可设置 supportedByWeb=true；此时无需伪造本地证据编号。
6. 只有所有必要计划项都有直接、充分且无冲突的证据，整体 isSufficient 才能为 true；否则 missing 只列仍缺少的必要信息。
7. 尚未直接执行某计划项，不代表它一定缺证据；已有证据若确实覆盖它，可以标记充分。
8. nextAction 只是建议，系统仍会执行硬预算和逐项覆盖校验。联网内容不使用本地证据编号。

仅在 web_search 时提供完整的 web_query。
    `, {
      stage: "evaluate",
      timeoutMs: modelTimeoutMs,
      signal: runnableConfig?.signal,
    });

    const coverage = normalizeCoverage({
      planItems: requiredPlanItems,
      modelCoverage: suggested.coverage ?? [],
      evidence: evaluationEvidence,
      retrievalHistory: state.retrievalHistory,
      hasWebContext: Boolean(state.webContext),
    });
    const allRequiredSupported = coverage.length > 0
      && coverage.every((item) => item.isSufficient);
    const unresolvedCoverage = coverage.filter((item) => !item.isSufficient);
    const missing = unique([
      ...unresolvedCoverage.map((item) => item.missing || item.question),
      ...(suggested.missing ?? []),
    ].map((item) => String(item).trim()).filter(Boolean));
    const isSufficient = allRequiredSupported;
    let nextAction = "generate";
    let retrievalMode = null;
    let nextPlanItems = planItems;
    let nextSubQuestions = subQuestions;
    let currentOriginalSubQuestion = state.currentOriginalSubQuestion;
    let currentQuery = state.currentQuery;
    let currentTargetPlanIndexes = [];
    let nextPlanIndex = nextSubIdx;
    let gapRecoveryCount = state.gapRecoveryCount ?? 0;
    let fallbackReason = null;

    const nextMissingPlanIndex = coverage.find((item) => (
      item.planIndex >= nextSubIdx && !item.isSufficient
    ))?.planIndex;
    const hasConflict = unresolvedCoverage.some((item) => (
      item.hasConflictingEvidence
    ));

    if (!isSufficient && !hasConflict
      && Number.isInteger(nextMissingPlanIndex) && hasLocalBudget) {
      nextAction = "retrieve";
      retrievalMode = "multi_hop";
      nextPlanIndex = nextMissingPlanIndex;
      currentOriginalSubQuestion = subQuestions[nextMissingPlanIndex];
      currentQuery = "";
      currentTargetPlanIndexes = [nextMissingPlanIndex];
    } else if (!isSufficient && !hasConflict && hasLocalBudget
      && gapRecoveryCount < gapRecoveryLimit) {
      const recoveryQuery = buildSupplementalQuery(state.question, missing);
      const previousQueries = new Set(
        (state.retrievalHistory ?? []).map((retrieval) => (
          normalizePlanQuestion(retrieval.query)
        )),
      );
      gapRecoveryCount += 1;
      if (recoveryQuery
        && !previousQueries.has(normalizePlanQuestion(recoveryQuery))) {
        const targetPlanIndexes = unresolvedCoverage.map((item) => item.planIndex);
        const recoveryItem = planItemForOriginalQuestion(
          recoveryQuery,
          `定向补充仍未覆盖的信息：${missing.join("；")}`,
          { required: false, kind: "gap_recovery", targetPlanIndexes },
        );
        nextPlanIndex = nextSubQuestions.length;
        nextPlanItems = [...nextPlanItems, recoveryItem];
        nextSubQuestions = [...nextSubQuestions, recoveryQuery];
        currentOriginalSubQuestion = recoveryQuery;
        currentQuery = recoveryQuery;
        currentTargetPlanIndexes = targetPlanIndexes;
        nextAction = "retrieve";
        retrievalMode = isSingleExecution
          ? "single_gap_recovery"
          : "multi_gap_recovery";
        fallbackReason = "coverage_gap_recovery";
      } else {
        fallbackReason = "gap_recovery_query_duplicate_or_empty";
      }
    }

    if (!isSufficient && nextAction === "generate"
      && suggested.nextAction === "web_search" && canWebSearch) {
      nextAction = "web_search";
    }

    return {
      planItems: nextPlanItems,
      subQuestions: nextSubQuestions,
      nextSubIdx: nextPlanIndex,
      currentOriginalSubQuestion,
      currentQuery,
      currentTargetPlanIndexes,
      skipCurrentRetrieval: false,
      coverage,
      evaluationEvidence,
      gapRecoveryCount,
      evaluation: {
        ...suggested,
        isSufficient,
        modelIsSufficient: Boolean(suggested.isSufficient),
        coverage,
        missing,
        nextAction,
        retrievalMode,
        fallbackReason,
        unresolvedPlanIndexes: unresolvedCoverage.map((item) => item.planIndex),
        contentSupportChecked: false,
      },
      execution: updateExecution(state.execution, {
        node: "evaluate",
        durationMs: Date.now() - startedAt,
        llmCalls: { evaluate: 1 },
        llmDurationMs: { evaluate: Date.now() - startedAt },
      }),
    };
  };
}
