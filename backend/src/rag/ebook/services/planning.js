function unique(values) {
  return [...new Set(values)];
}

export function normalizePlanQuestion(question) {
  return String(question ?? "")
    .trim()
    .replace(/[\s，。！？；：,.!?;:]+/g, "")
    .toLocaleLowerCase("zh-CN");
}

export function validateQuestionPlan(rawItems, maxSubQuestions = 4) {
  const errors = [];
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { valid: false, errors: ["计划为空"], items: [] };
  }
  if (rawItems.length > maxSubQuestions) {
    errors.push(`计划包含 ${rawItems.length} 项，超过上限 ${maxSubQuestions}`);
  }

  const seenQuestions = new Set();
  const items = rawItems.map((rawItem, index) => {
    const question = String(rawItem?.question ?? "").trim();
    const purpose = String(rawItem?.purpose ?? "").trim();
    const dependsOn = Array.isArray(rawItem?.dependsOn)
      ? rawItem.dependsOn.map(Number)
      : [];
    const introducedAssumptions = Array.isArray(rawItem?.introducedAssumptions)
      ? rawItem.introducedAssumptions.map((item) => String(item).trim()).filter(Boolean)
      : [];
    const normalizedQuestion = normalizePlanQuestion(question);

    if (!question) errors.push(`第 ${index + 1} 项缺少问题`);
    if (!purpose) errors.push(`第 ${index + 1} 项缺少必要性说明`);
    if (normalizedQuestion && seenQuestions.has(normalizedQuestion)) {
      errors.push(`第 ${index + 1} 项与前序问题重复`);
    }
    if (normalizedQuestion) seenQuestions.add(normalizedQuestion);
    if (introducedAssumptions.length) {
      errors.push(`第 ${index + 1} 项包含未经证实的新增前提`);
    }
    if (dependsOn.some((dependency) => (
      !Number.isInteger(dependency) || dependency < 1 || dependency >= index + 1
    ))) {
      errors.push(`第 ${index + 1} 项包含无效或未来依赖`);
    }

    return {
      question,
      purpose,
      dependsOn: unique(dependsOn),
      introducedAssumptions,
      required: true,
      kind: "planned",
      targetPlanIndexes: [],
    };
  });

  return { valid: errors.length === 0, errors: unique(errors), items };
}

export function planItemForOriginalQuestion(question, purpose, options = {}) {
  return {
    question,
    purpose,
    dependsOn: [],
    introducedAssumptions: [],
    required: options.required !== false,
    kind: options.kind ?? "planned",
    targetPlanIndexes: options.targetPlanIndexes ?? [],
  };
}

export function buildSupplementalQuery(question, missing = []) {
  const gaps = unique(
    missing
      .map((item) => String(item ?? "").replace(/[\r\n]+/g, " ").trim())
      .filter(Boolean),
  )
    .slice(0, 3)
    .map((item) => item.slice(0, 80));
  if (!gaps.length) return "";
  return `${question} 补充检索重点：${gaps.join("；")}`;
}

export function compactWebContext(context, maxCharacters = 3000) {
  return String(context ?? "").slice(0, maxCharacters);
}

function loopBudget(value, minimum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return minimum;
  return Math.max(minimum, Math.ceil(number));
}

export function calculateAgenticRagRecursionLimit({
  maxRetrievals,
  maxWebSearches = 0,
}) {
  const retrievalBudget = loopBudget(maxRetrievals, 1);
  const webSearchBudget = loopBudget(maxWebSearches, 0);

  // complex 路径：route + decompose + 3 * retrieval + 2 * web
  // + generate + LangGraph 的最终 END superstep。
  return (3 * retrievalBudget) + (2 * webSearchBudget) + 4;
}
