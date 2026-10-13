import { updateExecution } from "../services/execution.js";

export function createWebSearchNode({ webSearch }) {
  return async function webSearchNode(state) {
    const startedAt = Date.now();
    const query = state.evaluation?.web_query?.trim() || state.question;
    const result = await webSearch(query, 8);
    const searchNumber = (state.webSearchCount ?? 0) + 1;

    return {
      webContext: [
        state.webContext,
        `第 ${searchNumber} 次联网查询：${query}\n${result.text}`,
      ].filter(Boolean).join("\n\n=========\n\n"),
      webSources: [...(state.webSources ?? []), ...(result.sources ?? [])],
      webSearchCount: searchNumber,
      execution: updateExecution(state.execution, {
        node: "webSearch",
        durationMs: Date.now() - startedAt,
        webSearches: 1,
      }),
    };
  };
}
