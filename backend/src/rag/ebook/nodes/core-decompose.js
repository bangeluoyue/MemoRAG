import { DecomposeSchema } from "../schemas.js";
import { hasDependencyPlaceholder } from "../services/evidence.js";
import { updateExecution } from "../services/execution.js";
import {
  normalizePlanQuestion,
  planItemForOriginalQuestion,
  validateQuestionPlan,
} from "../services/planning.js";
import {
  AgentInvocationTimeoutError,
  invokeModelWithTimeout,
} from "../../shared/timeouts.js";

function originalQuestionPlan(question, purpose) {
  return [planItemForOriginalQuestion(question, purpose)];
}

const ORIGINAL_DEPENDENCY_REFERENCE_PATTERN = /(?:这个人|那个人|此人|该人物|这个事件|该事件|前者|后者|他|她|其)/u;

function makeSafePlan(question, items) {
  const seen = new Set();
  const failureReasons = [];
  const planItems = [];
  const originalContainsDependency = ORIGINAL_DEPENDENCY_REFERENCE_PATTERN
    .test(question);

  for (const [index, item] of items.entries()) {
    let candidate = item;
    if (item.dependsOn.length
      || hasDependencyPlaceholder(item.question)
      || (originalContainsDependency && index > 0)) {
      candidate = planItemForOriginalQuestion(
        question,
        "依赖实体尚未由证据确认，改用不包含内部占位符的原始完整问题",
        { kind: "dependency_safe_fallback" },
      );
      failureReasons.push("依赖型子问题已安全回退到原始完整问题");
    }

    const normalized = normalizePlanQuestion(candidate.question);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    planItems.push(candidate);
  }

  return {
    planItems: planItems.length
      ? planItems
      : originalQuestionPlan(question, "拆题没有产生安全查询，回退到原始问题"),
    failureReasons,
  };
}

export function createCoreDecomposeQuestionNode({
  model,
  bookName,
  subQuestionLimit,
  modelTimeoutMs,
}) {
  return async function coreDecomposeQuestionNode(state, runnableConfig) {
    const startedAt = Date.now();
    let planItems;
    let status = "valid";
    let failureReasons = [];
    let reason = "";

    try {
      const decomposer = model.withStructuredOutput(DecomposeSchema);
      const result = await invokeModelWithTimeout(decomposer, `
你是《${bookName}》多跳问答的检索计划器。请把真正复杂的问题拆成最多 ${subQuestionLimit} 个必要、可检索的子问题。

用户原始问题：${state.question}

规则：
1. 通常只需要 2～3 项，不得增加背景盘点或用户没有询问的旁支。
2. question 必须是完整疑问句；purpose 简要说明它回答原问题的哪一部分。
3. 只能使用用户原问题中已经明确出现的实体，不得凭模型记忆补入人物、事件或结论。
4. 如果后续问题依赖尚未确认的实体，应保留“第 N 项确认的人物/事件”并用 dependsOn 标明；系统会安全处理，禁止自行猜实体。
5. introducedAssumptions 必须列出新增但未经确认的前提；正常计划应为空。
6. 不得重复，不得超过 ${subQuestionLimit} 项。
      `, {
        stage: "decompose",
        timeoutMs: modelTimeoutMs,
        signal: runnableConfig?.signal,
      });
      reason = result.reason;
      const validation = validateQuestionPlan(
        result.sub_questions,
        subQuestionLimit,
      );
      if (!validation.valid) {
        status = "fallback_single";
        failureReasons = validation.errors;
        planItems = originalQuestionPlan(
          state.question,
          "拆题结果未通过安全校验，回退到原始问题",
        );
      } else {
        const safePlan = makeSafePlan(state.question, validation.items);
        planItems = safePlan.planItems;
        failureReasons = safePlan.failureReasons;
        if (failureReasons.length) status = "dependency_safe_fallback";
      }
    } catch (error) {
      if (error instanceof AgentInvocationTimeoutError) throw error;
      status = "fallback_single";
      failureReasons = ["拆题模型调用失败或超时，回退到原始问题"];
      planItems = originalQuestionPlan(
        state.question,
        "拆题调用不可用，安全回退到原始问题",
      );
    }

    const subQuestions = planItems.map((item) => item.question);
    const durationMs = Date.now() - startedAt;
    return {
      planItems,
      planValidation: {
        status,
        repairAttempts: 0,
        failureReasons,
        reason,
      },
      subQuestions,
      nextSubIdx: 0,
      currentOriginalSubQuestion: subQuestions[0],
      currentQuery: subQuestions[0],
      currentTargetPlanIndexes: [0],
      skipCurrentRetrieval: false,
      execution: updateExecution(state.execution, {
        node: "decomposeQuestion",
        durationMs,
        llmCalls: { decompose: 1 },
        llmDurationMs: { decompose: durationMs },
      }),
    };
  };
}
