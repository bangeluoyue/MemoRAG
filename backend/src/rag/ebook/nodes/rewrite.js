import { RewriteSchema } from "../schemas.js";
import {
  buildRewriteEvidence,
  createRewriteRecord,
  formatRewriteEvidence,
  hasDependencyPlaceholder,
  validateRewrite,
} from "../services/evidence.js";
import { updateExecution } from "../services/execution.js";
import { normalizePlanQuestion } from "../services/planning.js";
import {
  AgentInvocationTimeoutError,
  ModelInvocationTimeoutError,
  invokeModelWithTimeout,
} from "../../shared/timeouts.js";

export function createRewriteSubQuestionNode({
  model,
  bookName,
  knowledgeBase = "ebook",
  modelTimeoutMs,
}) {
  const sourceLabel = knowledgeBase === "life_notes"
    ? "用户生活笔记 RAG"
    : `《${bookName}》RAG`;
  const retrievalLabel = knowledgeBase === "life_notes" ? "检索" : "向量检索";
  return async function rewriteSubQuestionNode(state, runnableConfig) {
    const startedAt = Date.now();
    const index = state.nextSubIdx ?? 0;
    const originalSubQuestion = state.subQuestions?.[index]?.trim();
    if (!originalSubQuestion) {
      throw new Error(`不存在可改写的子问题（下标 ${index}）`);
    }

    const planItem = state.planItems?.[index];
    const dependencies = planItem?.dependsOn ?? [];
    const targetPlanIndexes = planItem?.targetPlanIndexes?.length
      ? planItem.targetPlanIndexes
      : [index];
    if (!dependencies.length) {
      const record = createRewriteRecord({
        subQuestionIndex: index,
        originalSubQuestion,
        status: "skipped_independent",
        reason: "计划项不依赖前序结果，直接使用原始子问题",
      });
      return {
        currentOriginalSubQuestion: originalSubQuestion,
        currentQuery: originalSubQuestion,
        currentTargetPlanIndexes: targetPlanIndexes,
        skipCurrentRetrieval: false,
        rewriteHistory: [...(state.rewriteHistory ?? []), record],
        execution: updateExecution(state.execution, {
          node: "rewriteSubQuestion",
          durationMs: Date.now() - startedAt,
        }),
      };
    }

    const dependencyCoverage = dependencies.map((dependency) => (
      state.coverage?.find((item) => item.planIndex === dependency - 1)
    ));
    const unsupportedDependencies = dependencyCoverage.filter((item) => (
      !item?.isSufficient
    ));
    const priorEvidence = buildRewriteEvidence(
      state.retrievalHistory,
      dependencies,
      state.coverage,
    );
    const placeholderDetected = hasDependencyPlaceholder(originalSubQuestion);

    const useSafeFallback = ({ status, reason, failureCode, diagnostics = {} }) => {
      const safeQuery = state.question.trim();
      const previousQueries = new Set(
        (state.retrievalHistory ?? []).map((retrieval) => (
          normalizePlanQuestion(retrieval.query)
        )),
      );
      const duplicate = previousQueries.has(normalizePlanQuestion(safeQuery));
      const record = createRewriteRecord({
        subQuestionIndex: index,
        originalSubQuestion,
        rewrittenQuery: safeQuery,
        status,
        reason,
        fallbackReason: failureCode,
        fallbackStrategy: "dependency_fallback_original_question",
        placeholderDetected,
        attemptedEvidenceIndexes: diagnostics.attemptedEvidenceIndexes,
        allowedEvidenceIndexes: diagnostics.allowedEvidenceIndexes
          ?? priorEvidence.map((item) => item.evidenceIndex),
        supportingDocumentIds: diagnostics.supportingDocumentIds,
      });
      return {
        currentOriginalSubQuestion: originalSubQuestion,
        currentQuery: duplicate ? "" : safeQuery,
        currentTargetPlanIndexes: targetPlanIndexes,
        skipCurrentRetrieval: duplicate,
        nextSubIdx: duplicate ? index + 1 : index,
        rewriteHistory: [...(state.rewriteHistory ?? []), record],
      };
    };

    if (unsupportedDependencies.length || !priorEvidence.length) {
      const fallback = useSafeFallback({
        status: "dependency_fallback_original_question",
        failureCode: unsupportedDependencies.length
          ? "dependency_not_supported"
          : "missing_dependency_evidence",
        reason: "依赖项尚无充分证据，改用不含内部占位符的原始完整问题",
      });
      return {
        ...fallback,
        execution: updateExecution(state.execution, {
          node: "rewriteSubQuestion",
          durationMs: Date.now() - startedAt,
        }),
      };
    }

    try {
      const rewriter = model.withStructuredOutput(RewriteSchema);
      const result = await invokeModelWithTimeout(rewriter, `
你是${sourceLabel} 的检索查询改写器。你的任务不是回答问题，而是判断当前子问题是否依赖前序检索结果，并生成适合${retrievalLabel}的自包含查询。

用户原始问题：${state.question}
当前待检索的原始子问题：${originalSubQuestion}

只能使用以下已经完成的前序检索及其原文证据：
${formatRewriteEvidence(priorEvidence)}

规则：
1. 仅当当前子问题有指代、实体省略或明确语义依赖，并且前序原文足以唯一确认实体时，needsRewrite 才为 true。
2. 不依赖前序资料时保留原问题；rewrittenQuery 必须与原问题完全一致。
3. 证据不足或多个候选实体相互冲突时不得猜测；hasConflictingEvidence 应如实标记，并保留原问题。
4. 不得使用常识、模型记忆、后续子问题或前序证据之外的事实。
5. 改写时只补全检索所必需的实体，不要提前回答当前子问题。
6. resolvedEntities 只填写实际补入查询的实体，而且实体文字必须直接出现在支持文档原文中。
7. supportingEvidenceIndexes 只能填写上面给出的 [证据N] 编号，不得填写文档 ID；reason 仅用于调试，不属于事实证据。
8. 必须保留原问题“谁、为什么、为何、如何、是否、哪里、多少”等疑问意图，不得把疑问改写为未经证实的事实断言。
      `, {
        stage: "rewrite",
        timeoutMs: modelTimeoutMs,
        signal: runnableConfig?.signal,
      });
      const decision = validateRewrite(originalSubQuestion, result, priorEvidence);

      if (!decision.valid || !decision.applied) {
        const fallback = useSafeFallback({
          status: "fallback_invalid_rewrite",
          reason: decision.reason,
          failureCode: decision.failureCode ?? "rewrite_not_applied",
          diagnostics: decision,
        });
        return {
          ...fallback,
          execution: updateExecution(state.execution, {
            node: "rewriteSubQuestion",
            durationMs: Date.now() - startedAt,
            llmCalls: { rewrite: 1 },
            llmDurationMs: { rewrite: Date.now() - startedAt },
          }),
        };
      }

      const record = createRewriteRecord({
        subQuestionIndex: index,
        originalSubQuestion,
        rewrittenQuery: decision.query,
        rewriteApplied: decision.applied,
        status: decision.status,
        reason: decision.reason,
        resolvedEntities: decision.resolvedEntities,
        supportingDocumentIds: decision.supportingDocumentIds,
        attemptedEvidenceIndexes: decision.attemptedEvidenceIndexes,
        allowedEvidenceIndexes: decision.allowedEvidenceIndexes,
        placeholderDetected,
      });
      return {
        currentOriginalSubQuestion: originalSubQuestion,
        currentQuery: decision.query,
        currentTargetPlanIndexes: targetPlanIndexes,
        skipCurrentRetrieval: false,
        rewriteHistory: [...(state.rewriteHistory ?? []), record],
        execution: updateExecution(state.execution, {
          node: "rewriteSubQuestion",
          durationMs: Date.now() - startedAt,
          llmCalls: { rewrite: 1 },
          llmDurationMs: { rewrite: Date.now() - startedAt },
        }),
      };
    } catch (error) {
      if (error instanceof AgentInvocationTimeoutError) throw error;
      const timedOut = error instanceof ModelInvocationTimeoutError;
      const fallback = useSafeFallback({
        status: timedOut ? "fallback_model_timeout" : "fallback_model_error",
        reason: timedOut
          ? "改写模型调用超时，已回退到原始完整问题"
          : "改写模型调用失败，已回退到原始完整问题",
        failureCode: timedOut ? "rewrite_model_timeout" : "rewrite_model_error",
      });
      return {
        ...fallback,
        execution: updateExecution(state.execution, {
          node: "rewriteSubQuestion",
          durationMs: Date.now() - startedAt,
          llmCalls: { rewrite: 1 },
          llmDurationMs: { rewrite: Date.now() - startedAt },
        }),
      };
    }
  };
}
