import {
  buildLocalContext,
  mergeUniqueDocuments,
} from "../services/document-merge.js";
import { updateExecution } from "../services/execution.js";

export function createRetrieveNode({ retriever, maxContextDocuments }) {
  return async function retrieveNode(state) {
    const startedAt = Date.now();
    const index = state.nextSubIdx ?? 0;
    const originalSubQuestion = state.subQuestions?.[index]?.trim();
    const query = state.currentQuery?.trim() || originalSubQuestion;
    if (!originalSubQuestion || !query) {
      throw new Error(`不存在可检索的子问题（下标 ${index}）`);
    }

    let retrievalResult;
    let errorCategory = null;
    const retrievalOptions = {
      k: state.k,
      ...(state.bookId ? { bookId: state.bookId } : {}),
      ...(state.retrievalScope ? { scope: state.retrievalScope } : {}),
    };
    try {
      retrievalResult = typeof retriever.searchWithTrace === "function"
        ? await retriever.searchWithTrace(query, retrievalOptions)
        : {
          documents: await retriever.search(query, retrievalOptions),
          rerank: null,
        };
    } catch (error) {
      errorCategory = String(error?.name || "retrieval_error");
      retrievalResult = { documents: [], rerank: null, retrieval: {} };
    }
    const newDocuments = retrievalResult.documents ?? [];
    const rankedNewDocuments = mergeUniqueDocuments(
      [],
      newDocuments,
      maxContextDocuments,
    );
    const documents = mergeUniqueDocuments(
      state.documents,
      newDocuments,
      maxContextDocuments,
    );
    const latestRewrite = [...(state.rewriteHistory ?? [])]
      .reverse()
      .find((rewrite) => rewrite.subQuestionIndex === index);
    const targetPlanIndexes = state.currentTargetPlanIndexes?.length
      ? state.currentTargetPlanIndexes
      : [index];
    const measuredDurationMs = Date.now() - startedAt;
    const retrievalTiming = {
      ...(retrievalResult.retrieval ?? {}),
      totalDurationMs: retrievalResult.retrieval?.totalDurationMs
        ?? measuredDurationMs,
    };
    const retrievalRecord = {
      subQuestionIndex: index,
      targetPlanIndexes,
      originalSubQuestion,
      query,
      rewriteApplied: Boolean(latestRewrite?.rewriteApplied),
      fallbackReason: latestRewrite?.fallbackReason ?? null,
      fallbackStrategy: latestRewrite?.fallbackStrategy ?? null,
      documentIds: rankedNewDocuments.map((document) => document.id),
      retrievedDocuments: rankedNewDocuments,
      rerank: retrievalResult.rerank,
      timing: retrievalTiming,
      errorCategory,
      evidence: rankedNewDocuments.slice(0, 4).map((document) => ({
        documentId: document.id,
        chapterNum: document.chapterNum,
        chunkIndex: document.chunkIndex,
        score: document.score,
        excerpt: String(document.content ?? "").slice(0, 500),
      })),
    };
    const rerankStatus = retrievalResult.rerank?.status;
    const rerankRequested = ["success", "fallback"].includes(rerankStatus);

    return {
      documents,
      localContext: buildLocalContext(documents),
      retrievalHistory: [...(state.retrievalHistory ?? []), retrievalRecord],
      retrievalCount: (state.retrievalCount ?? 0) + 1,
      nextSubIdx: index + 1,
      currentOriginalSubQuestion: originalSubQuestion,
      currentQuery: query,
      currentTargetPlanIndexes: [],
      skipCurrentRetrieval: false,
      execution: updateExecution(state.execution, {
        node: "retrieve",
        durationMs: measuredDurationMs,
        retrievalTiming,
        localRetrievals: 1,
        rerankRequests: rerankRequested ? 1 : 0,
        rerankFallbacks: rerankStatus === "fallback" ? 1 : 0,
      }),
    };
  };
}
