import { buildLocalContext } from "./document-merge.js";

const LOCAL_CITATION_PATTERN = /\[本地([0-9]+)\]/g;

function unique(values) {
  return [...new Set(values)];
}

export function stringifyMessageContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .map((part) => typeof part === "string" ? part : String(part?.text ?? ""))
    .join("");
}

export function validateLocalCitations(answer, sourceCount) {
  const maximum = Math.max(0, Math.floor(Number(sourceCount) || 0));
  const references = [...String(answer ?? "").matchAll(LOCAL_CITATION_PATTERN)]
    .map((match) => ({
      label: match[0],
      digits: match[1],
      number: Number(match[1]),
    }));
  const isValidReference = (reference) => (
    reference.number >= 1
    && reference.number <= maximum
    && String(reference.number) === reference.digits
  );

  const validReferences = unique(
    references.filter(isValidReference).map((reference) => reference.label),
  );
  const invalidReferences = unique(
    references.filter((reference) => !isValidReference(reference))
      .map((reference) => reference.label),
  );

  return {
    references: unique(references.map((reference) => reference.label)),
    validReferences,
    invalidReferences,
    isValid: invalidReferences.length === 0,
  };
}

export function removeInvalidLocalCitations(answer, sourceCount) {
  const maximum = Math.max(0, Math.floor(Number(sourceCount) || 0));
  return String(answer ?? "")
    .replace(LOCAL_CITATION_PATTERN, (label, digits) => {
      const number = Number(digits);
      const isValid = number >= 1
        && number <= maximum
        && String(number) === digits;
      return isValid ? label : "";
    })
    .replace(/[ \t]+(?=[，。！？；：,.!?;:])/g, "")
    .trim();
}

export function createCitationGenerator({ model, citationCorrectionLimit }) {
  return async function generateWithValidatedCitations({
    prompt,
    question,
    context,
    citationDocuments,
  }) {
    const localSourceCount = citationDocuments.length;
    const initialStartedAt = Date.now();
    const initialMessage = await model.invoke(prompt);
    const generationDurationMs = Date.now() - initialStartedAt;
    const initialAnswer = stringifyMessageContent(initialMessage.content).trim();
    const initialValidation = validateLocalCitations(initialAnswer, localSourceCount);
    let answer = initialAnswer;
    let validation = initialValidation;
    let correctionAttempts = 0;
    let correctionFailed = false;
    let citationCorrectionDurationMs = 0;

    while (!validation.isValid && correctionAttempts < citationCorrectionLimit) {
      correctionAttempts += 1;
      const allowedReferences = localSourceCount > 0
        ? `[本地1] 至 [本地${localSourceCount}]`
        : "没有可用本地来源，不得使用任何 [本地N]";

      const correctionStartedAt = Date.now();
      try {
        const correctedMessage = await model.invoke(`
你是中文问答答案的引用纠正器。下面的回答包含不存在的本地引用编号，请使用同一份资料重新生成完整回答。

用户原始问题：${question}

可用资料：
${context || "（空）"}

待纠正回答：
${answer}

检测到的无效本地引用：${validation.invalidReferences.join("、")}
合法本地引用范围：${allowedReferences}

要求：
1. 只使用资料中真实存在的引用编号，不得虚构、补造或改变来源 ID。
2. 保留仍然有效且确有使用的引用；没有资料支持时明确说明资料不足。
3. 网页引用不属于本次编号校验范围，不要把本地引用改成网页引用来规避校验。
4. 只输出纠正后的完整回答，不要解释纠正过程。
        `);
        citationCorrectionDurationMs += Date.now() - correctionStartedAt;
        const correctedAnswer = stringifyMessageContent(correctedMessage.content).trim();
        if (!correctedAnswer) {
          correctionFailed = true;
          break;
        }
        answer = correctedAnswer;
        validation = validateLocalCitations(answer, localSourceCount);
      } catch {
        citationCorrectionDurationMs += Date.now() - correctionStartedAt;
        correctionFailed = true;
        break;
      }
    }

    const removedInvalidReferences = validation.isValid
      ? []
      : validation.invalidReferences;
    let status = initialValidation.isValid ? "valid" : "corrected";
    if (!validation.isValid) {
      answer = removeInvalidLocalCitations(answer, localSourceCount);
      validation = validateLocalCitations(answer, localSourceCount);
      status = "sanitized";
    }

    return {
      generation: answer,
      citationDocuments,
      localContext: buildLocalContext(citationDocuments),
      generationLlmCalls: 1,
      citationCorrectionLlmCalls: correctionAttempts,
      generationDurationMs,
      citationCorrectionDurationMs,
      citationValidation: {
        status,
        localSourceCount,
        initialReferences: initialValidation.references,
        initialInvalidReferences: initialValidation.invalidReferences,
        correctionAttempts,
        correctionFailed,
        removedInvalidReferences,
        finalReferences: validation.references,
        finalInvalidReferences: validation.invalidReferences,
        contentSupportChecked: false,
      },
    };
  };
}
