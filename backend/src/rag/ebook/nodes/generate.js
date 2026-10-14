import { createCitationGenerator } from "../services/citations.js";
import { buildLocalContext } from "../services/document-merge.js";
import { updateExecution } from "../services/execution.js";

export function createGenerateNodes({
  model,
  citationCorrectionLimit,
  modelTimeoutMs,
}) {
  const generateWithValidatedCitations = createCitationGenerator({
    model,
    citationCorrectionLimit,
    modelTimeoutMs,
  });

  const directAnswerNode = async (state, runnableConfig) => {
    const startedAt = Date.now();
    const {
      generationLlmCalls,
      citationCorrectionLlmCalls,
      generationDurationMs,
      citationCorrectionDurationMs,
      ...generated
    } = await generateWithValidatedCitations({
      prompt: `
你是一个中文回答助手。请直接、简洁地回答问题。

问题：${state.question}
      `,
      question: state.question,
      context: "",
      citationDocuments: [],
      signal: runnableConfig?.signal,
    });
    return {
      ...generated,
      execution: updateExecution(state.execution, {
        node: "directAnswer",
        durationMs: Date.now() - startedAt,
        llmCalls: {
          generate: generationLlmCalls,
          citationCorrection: citationCorrectionLlmCalls,
        },
        llmDurationMs: {
          generate: generationDurationMs,
          citationCorrection: citationCorrectionDurationMs,
        },
      }),
    };
  };

  const generateNode = async (state, runnableConfig) => {
    const startedAt = Date.now();
    const supportedDocumentIds = new Set(
      (state.coverage ?? [])
        .filter((item) => item.isSufficient)
        .flatMap((item) => item.supportingDocumentIds ?? [])
        .map(String),
    );
    const citationDocuments = (state.evaluationEvidence ?? [])
      .filter((item) => supportedDocumentIds.has(String(item.documentId)))
      .map((item) => ({ ...item.document }));
    const localContext = buildLocalContext(citationDocuments);
    const context = [localContext, state.webContext]
      .filter(Boolean)
      .join("\n\n--- 联网补充 ---\n\n");
    const allowedLocalReferences = citationDocuments.length > 0
      ? `[本地1] 至 [本地${citationDocuments.length}]`
      : "无本地引用";
    const coverageSummary = (state.coverage ?? []).map((item) => [
      `- 计划第 ${item.planIndex + 1} 项：${item.question}`,
      `  已检索：${item.retrieved ? "是" : "否"}`,
      `  存在相关证据：${item.hasRelevantEvidence ? "是" : "否"}`,
      `  足以支持答案：${item.isSufficient ? "是" : "否"}`,
      `  状态：${item.status}`,
      item.isSufficient ? "" : `  未确认内容：${item.missing || "证据不足"}`,
    ].filter(Boolean).join("\n")).join("\n");
    const unresolvedQuestions = (state.coverage ?? [])
      .filter((item) => !item.isSufficient)
      .map((item) => item.missing || item.question);

    const {
      generationLlmCalls,
      citationCorrectionLlmCalls,
      generationDurationMs,
      citationCorrectionDurationMs,
      ...generated
    } = await generateWithValidatedCitations({
      prompt: `
你是一个严谨的中文阅读问答助手。请优先依据给定资料回答，不要编造。

资料：
${context || "（空）"}

用户最开始的问题：${state.question}

逐项证据覆盖状态：
${coverageSummary || "（无需本地证据）"}

要求：
1. 回答完整问题，不要只回答某个子问题。
2. 只陈述“足以支持答案”的计划项中由资料直接支持的事实关系；使用资料时以 [本地1]、[网页1] 这种标记注明依据。
3. 可用本地引用严格限定为：${allowedLocalReferences}。
4. 以下内容仍未获得充分证据：${unresolvedQuestions.join("；") || "无"}。对这些部分必须明确说明尚无法确认，不得用常识、模型记忆或错误前提补齐。
5. 不要虚构引用或 URL。
6. coverage 只是当前证据覆盖判断，并非完整事实蕴含证明；若资料存在冲突或措辞不能直接支持结论，应保守作答。
      `,
      question: state.question,
      context,
      citationDocuments,
      signal: runnableConfig?.signal,
    });
    return {
      ...generated,
      answerEvidenceDocuments: citationDocuments,
      execution: updateExecution(state.execution, {
        node: "generate",
        durationMs: Date.now() - startedAt,
        llmCalls: {
          generate: generationLlmCalls,
          citationCorrection: citationCorrectionLlmCalls,
        },
        llmDurationMs: {
          generate: generationDurationMs,
          citationCorrection: citationCorrectionDurationMs,
        },
      }),
    };
  };

  return { directAnswerNode, generateNode };
}
