export function buildExecutionTrace(execution, finalContextDocumentCount) {
  const llmCalls = { ...(execution?.llmCalls ?? {}) };
  return {
    totalDurationMs: Math.max(
      0,
      Date.now() - Number(execution?.startedAtMs ?? Date.now()),
    ),
    nodes: execution?.nodes ?? {},
    llmCallCount: Object.values(llmCalls)
      .reduce((total, count) => total + Number(count ?? 0), 0),
    llmCalls,
    llmDurationMs: execution?.llmDurationMs ?? {},
    retrievalStages: execution?.retrievalStages ?? {},
    localRetrievalCount: execution?.localRetrievalCount ?? 0,
    rerankRequestCount: execution?.rerankRequestCount ?? 0,
    rerankFallbackCount: execution?.rerankFallbackCount ?? 0,
    webSearchCount: execution?.webSearchCount ?? 0,
    finalContextDocumentCount,
  };
}

export function buildAgentResponse(result, tracing, { mapSource } = {}) {
  const citationDocuments = result.citationDocuments ?? result.documents ?? [];
  const sourceMapper = mapSource ?? ((document) => ({ ...document }));

  return {
    answer: result.generation,
    route: {
      strategy: result.strategy,
      mode: result.routeMode,
      reason: result.routeReason,
    },
    sources: citationDocuments.map((document, index) => ({
      ...sourceMapper(document),
      reference: `本地${index + 1}`,
    })),
    webSources: (result.webSources ?? []).map((source, index) => ({
      reference: `网页${index + 1}`,
      ...source,
    })),
    trace: {
      subQuestions: result.subQuestions ?? [],
      plan: result.planItems ?? [],
      planValidation: result.planValidation ?? null,
      rewriteHistory: result.rewriteHistory ?? [],
      retrievals: (result.retrievalHistory ?? []).map((retrieval) => ({
        subQuestionIndex: retrieval.subQuestionIndex,
        originalSubQuestion: retrieval.originalSubQuestion,
        query: retrieval.query,
        rewriteApplied: retrieval.rewriteApplied,
        fallbackReason: retrieval.fallbackReason ?? null,
        fallbackStrategy: retrieval.fallbackStrategy ?? null,
        targetPlanIndexes: retrieval.targetPlanIndexes ?? [],
        documentIds: retrieval.documentIds,
        rerank: retrieval.rerank ?? null,
        timing: retrieval.timing ?? null,
        status: retrieval.errorCategory ? "retrieval_error" : (
          (retrieval.targetPlanIndexes ?? [retrieval.subQuestionIndex])
            .map((planIndex) => result.coverage?.find((item) => (
              item.planIndex === planIndex
            ))?.status)
            .filter(Boolean)[0]
          ?? (retrieval.documentIds.length
            ? "retrieved_not_supportive"
            : "no_hits_for_query")
        ),
        errorCategory: retrieval.errorCategory ?? null,
      })),
      retrievalCount: result.retrievalCount ?? 0,
      webSearchCount: result.webSearchCount ?? 0,
      evaluation: result.evaluation,
      coverage: result.coverage ?? [],
      gapRecoveryCount: result.gapRecoveryCount ?? 0,
      citationValidation: result.citationValidation ?? null,
      execution: buildExecutionTrace(
        result.execution,
        citationDocuments.length,
      ),
      langsmith: tracing.summary(),
    },
  };
}
