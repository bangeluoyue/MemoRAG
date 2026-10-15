import { createCitationGenerator } from "../services/citations.js";
import { buildLocalContext } from "../services/document-merge.js";
import { updateExecution } from "../services/execution.js";

function noEvidenceResult() {
  return {
    generation: "抱歉，当前没有检索到能够支持回答的本地或网页资料，无法根据现有资料确认。",
    citationDocuments: [],
    localContext: "",
    citationValidation: {
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
    },
  };
}

export function createCoreGenerateNode({
  model,
  citationCorrectionLimit,
  modelTimeoutMs,
}) {
  const generateWithValidatedCitations = createCitationGenerator({
    model,
    citationCorrectionLimit,
    modelTimeoutMs,
  });

  return async function coreGenerateNode(state, runnableConfig) {
    const startedAt = Date.now();
    const citationDocuments = state.documents ?? [];
    const localContext = buildLocalContext(citationDocuments);
    const hasWebEvidence = (state.webSources?.length ?? 0) > 0;
    const context = [
      localContext,
      hasWebEvidence ? state.webContext : "",
    ].filter(Boolean).join("\n\n--- 联网补充 ---\n\n");

    if (!context) {
      return {
        ...noEvidenceResult(),
        execution: updateExecution(state.execution, {
          node: "generate",
          durationMs: Date.now() - startedAt,
        }),
      };
    }

    const allowedLocalReferences = citationDocuments.length
      ? `[本地1] 至 [本地${citationDocuments.length}]`
      : "无本地引用";
    const generated = await generateWithValidatedCitations({
      prompt: `
你是一个严谨的中文阅读问答助手。只能依据本次给出的本地片段和可选网页资料回答，不得使用模型记忆补齐资料中没有的事实。

资料：
${context}

用户问题：${state.question}

要求：
1. 回答用户最初提出的完整问题，不要只回答某个检索子问题。
2. 使用本地资料时标注 [本地N]，合法范围仅为 ${allowedLocalReferences}；使用网页资料时标注对应的 [网页N]。
3. 不得虚构人物关系、原因、事件、文档 ID、章节、URL 或引用编号。
4. 某一部分没有直接证据时，明确说明该部分无法根据现有资料确认。
5. 资料相互冲突时指出冲突并保守作答。
      `,
      question: state.question,
      context,
      citationDocuments,
      signal: runnableConfig?.signal,
    });
    const durationMs = Date.now() - startedAt;
    return {
      ...generated,
      answerEvidenceDocuments: citationDocuments,
      execution: updateExecution(state.execution, {
        node: "generate",
        durationMs,
        llmCalls: {
          generate: generated.generationLlmCalls,
          citationCorrection: generated.citationCorrectionLlmCalls,
        },
        llmDurationMs: {
          generate: generated.generationDurationMs,
          citationCorrection: generated.citationCorrectionDurationMs,
        },
      }),
    };
  };
}
