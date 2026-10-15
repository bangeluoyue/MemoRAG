const LLM_CALL_CATEGORIES = [
  "route",
  "decompose",
  "rewrite",
  "evaluate",
  "decision",
  "generate",
  "citationCorrection",
];

export function createExecutionState() {
  return {
    startedAtMs: Date.now(),
    nodes: {},
    llmCalls: Object.fromEntries(
      LLM_CALL_CATEGORIES.map((category) => [category, 0]),
    ),
    llmDurationMs: Object.fromEntries(
      LLM_CALL_CATEGORIES.map((category) => [category, 0]),
    ),
    localRetrievalCount: 0,
    retrievalStages: {
      embeddingDurationMs: 0,
      vectorSearchDurationMs: 0,
      rerankDurationMs: 0,
      totalDurationMs: 0,
    },
    rerankRequestCount: 0,
    rerankFallbackCount: 0,
    webSearchCount: 0,
  };
}

export function updateExecution(execution, {
  node,
  durationMs = 0,
  llmCalls = {},
  llmDurationMs = {},
  retrievalTiming = {},
  localRetrievals = 0,
  rerankRequests = 0,
  rerankFallbacks = 0,
  webSearches = 0,
} = {}) {
  const current = execution ?? createExecutionState();
  const nodes = { ...current.nodes };
  if (node) {
    const previous = nodes[node] ?? { count: 0, durationMs: 0 };
    nodes[node] = {
      count: previous.count + 1,
      durationMs: previous.durationMs + Math.max(0, Math.round(durationMs)),
    };
  }

  const nextLlmCalls = { ...current.llmCalls };
  const nextLlmDurationMs = { ...current.llmDurationMs };
  for (const category of LLM_CALL_CATEGORIES) {
    nextLlmCalls[category] = Number(nextLlmCalls[category] ?? 0)
      + Number(llmCalls[category] ?? 0);
    nextLlmDurationMs[category] = Number(nextLlmDurationMs[category] ?? 0)
      + Math.max(0, Math.round(Number(llmDurationMs[category] ?? 0) || 0));
  }

  const retrievalStages = { ...(current.retrievalStages ?? {}) };
  for (const category of [
    "embeddingDurationMs",
    "vectorSearchDurationMs",
    "rerankDurationMs",
    "totalDurationMs",
  ]) {
    retrievalStages[category] = Number(retrievalStages[category] ?? 0)
      + Math.max(0, Math.round(Number(retrievalTiming[category] ?? 0) || 0));
  }

  return {
    ...current,
    nodes,
    llmCalls: nextLlmCalls,
    llmDurationMs: nextLlmDurationMs,
    retrievalStages,
    localRetrievalCount: current.localRetrievalCount + localRetrievals,
    rerankRequestCount: current.rerankRequestCount + rerankRequests,
    rerankFallbackCount: current.rerankFallbackCount + rerankFallbacks,
    webSearchCount: current.webSearchCount + webSearches,
  };
}
