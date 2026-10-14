import { DecomposeSchema } from "../schemas.js";
import { updateExecution } from "../services/execution.js";
import {
  planItemForOriginalQuestion,
  validateQuestionPlan,
} from "../services/planning.js";
import {
  AgentInvocationTimeoutError,
  ModelInvocationTimeoutError,
  invokeModelWithTimeout,
} from "../../shared/timeouts.js";

export function createDecomposeQuestionNode({
  model,
  bookName,
  knowledgeBase = "ebook",
  subQuestionLimit,
  planRepairLimit,
  modelTimeoutMs,
}) {
  const sourceLabel = knowledgeBase === "life_notes"
    ? "用户生活笔记"
    : `《${bookName}》`;
  return async function decomposeQuestionNode(state, runnableConfig) {
    const startedAt = Date.now();
    const decomposer = model.withStructuredOutput(DecomposeSchema);
    const failureReasons = [];
    let repairAttempts = 0;
    let llmCalls = 0;
    let acceptedPlan = null;
    let resultReason = "";

    while (!acceptedPlan && repairAttempts <= planRepairLimit) {
      const repairInstructions = repairAttempts > 0
        ? `\n上一次计划未通过结构校验：${failureReasons.at(-1)?.join("；")}\n请只修复这些问题，不扩展任务范围。`
        : "";

      try {
        llmCalls += 1;
        const result = await invokeModelWithTimeout(decomposer, `
你是${sourceLabel}多跳问答的子问题拆解器。
用户原始问题：${state.question}

请输出有序的结构化检索计划，默认最多 ${subQuestionLimit} 项：
1. 通常只需 2 项；只有不可合并且回答原问题必需的事实才增加，禁止背景盘点、旁支验证和用户未问内容。
2. question 是可检索的疑问句；purpose 必须说明它填补原问题的哪一项必要信息。
3. dependsOn 使用从 1 开始的前序计划编号，只能依赖更早的项；不依赖时返回空数组。
4. 未知实体应写成“第 N 项确认的人物/事件”等依赖表达，不得猜成具体名称。
5. introducedAssumptions 必须列出计划新引入但用户没有提供、证据也尚未确认的事实前提；正常计划应为空数组。
6. 不得输出重复问题，不得超过 ${subQuestionLimit} 项。
${repairInstructions}
        `, {
          stage: "decompose",
          timeoutMs: modelTimeoutMs,
          signal: runnableConfig?.signal,
        });
        resultReason = result.reason;
        const validation = validateQuestionPlan(
          result.sub_questions,
          subQuestionLimit,
        );
        if (validation.valid) {
          acceptedPlan = validation.items;
          break;
        }
        failureReasons.push(validation.errors);
      } catch (error) {
        if (error instanceof AgentInvocationTimeoutError) throw error;
        if (error instanceof ModelInvocationTimeoutError) {
          failureReasons.push(["拆题模型调用超时，已停止计划修复并安全回退"]);
          break;
        }
        failureReasons.push(["拆题模型未返回可校验的结构化计划"]);
      }

      if (repairAttempts >= planRepairLimit) break;
      repairAttempts += 1;
    }

    const planItems = acceptedPlan ?? [planItemForOriginalQuestion(
      state.question,
      "拆题计划校验或有限修复失败，安全回退到原始问题单次检索",
    )];
    const status = acceptedPlan
      ? (repairAttempts > 0 ? "repaired" : "valid")
      : "fallback_single";
    const subQuestions = planItems.map((item) => item.question);

    return {
      planItems,
      planValidation: {
        status,
        repairAttempts,
        failureReasons: failureReasons.flat(),
        reason: resultReason,
      },
      subQuestions,
      nextSubIdx: 0,
      currentOriginalSubQuestion: subQuestions[0],
      currentQuery: "",
      currentTargetPlanIndexes: [0],
      skipCurrentRetrieval: false,
      execution: updateExecution(state.execution, {
        node: "decomposeQuestion",
        durationMs: Date.now() - startedAt,
        llmCalls: { decompose: llmCalls },
        llmDurationMs: { decompose: Date.now() - startedAt },
      }),
    };
  };
}
