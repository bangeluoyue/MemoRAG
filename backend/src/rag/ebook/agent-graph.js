import { END, START, StateGraph } from "@langchain/langgraph";
import { createDecomposeQuestionNode } from "./nodes/decompose.js";
import { createEvaluateNode } from "./nodes/evaluate.js";
import { createGenerateNodes } from "./nodes/generate.js";
import { createRetrieveNode } from "./nodes/retrieve.js";
import { createRewriteSubQuestionNode } from "./nodes/rewrite.js";
import { createRouteNodes } from "./nodes/route.js";
import { createWebSearchNode } from "./nodes/web-search.js";
import { EbookRagState } from "./state.js";

export { EbookRagState, createInitialState } from "./state.js";
export {
  stringifyMessageContent,
  validateLocalCitations,
  removeInvalidLocalCitations,
} from "./services/citations.js";
export {
  buildCompactLocalContext,
  buildLocalContext,
  mergeUniqueDocuments,
} from "./services/document-merge.js";
export {
  calculateAgenticRagRecursionLimit,
  validateQuestionPlan,
} from "./services/planning.js";

export function createAgenticRagGraph({
  model,
  retriever,
  bookName,
  maxContextDocuments = 12,
  maxSubQuestions = 4,
  maxPlanRepairAttempts = 1,
  maxSingleRetrievals = 2,
  maxGapRecoveryAttempts = 1,
  webSearch = null,
  maxWebSearches = 2,
  maxCitationCorrectionAttempts = 1,
}) {
  const citationCorrectionLimit = Math.max(
    0,
    Math.floor(Number(maxCitationCorrectionAttempts) || 0),
  );
  const subQuestionLimit = Math.min(
    8,
    Math.max(1, Math.floor(Number(maxSubQuestions) || 4)),
  );
  const planRepairLimit = Math.min(
    2,
    Math.max(0, Math.floor(Number(maxPlanRepairAttempts) || 0)),
  );
  const singleRetrievalLimit = Math.min(
    3,
    Math.max(1, Math.floor(Number(maxSingleRetrievals) || 2)),
  );
  const gapRecoveryLimit = Math.min(
    1,
    Math.max(0, Math.floor(Number(maxGapRecoveryAttempts) || 0)),
  );

  const { routeQuestionNode, prepareSingleRetrievalNode } = createRouteNodes({
    model,
    bookName,
  });
  const decomposeQuestionNode = createDecomposeQuestionNode({
    model,
    bookName,
    subQuestionLimit,
    planRepairLimit,
  });
  const rewriteSubQuestionNode = createRewriteSubQuestionNode({
    model,
    bookName,
  });
  const retrieveNode = createRetrieveNode({ retriever, maxContextDocuments });
  const evaluateNode = createEvaluateNode({
    model,
    singleRetrievalLimit,
    gapRecoveryLimit,
    webSearch,
    maxWebSearches,
  });
  const webSearchNode = createWebSearchNode({ webSearch });
  const { directAnswerNode, generateNode } = createGenerateNodes({
    model,
    citationCorrectionLimit,
  });

  return new StateGraph(EbookRagState)
    .addNode("routeQuestion", routeQuestionNode)
    .addNode("directAnswer", directAnswerNode)
    .addNode("prepareSingleRetrieval", prepareSingleRetrievalNode)
    .addNode("decomposeQuestion", decomposeQuestionNode)
    .addNode("rewriteSubQuestion", rewriteSubQuestionNode)
    .addNode("retrieve", retrieveNode)
    .addNode("evaluate", evaluateNode)
    .addNode("webSearch", webSearchNode)
    .addNode("generate", generateNode)
    .addEdge(START, "routeQuestion")
    .addConditionalEdges("routeQuestion", (state) => state.routeMode, {
      direct: "directAnswer",
      single_retrieval: "prepareSingleRetrieval",
      multi_hop: "decomposeQuestion",
    })
    .addEdge("directAnswer", END)
    .addEdge("prepareSingleRetrieval", "retrieve")
    .addEdge("decomposeQuestion", "rewriteSubQuestion")
    .addConditionalEdges("rewriteSubQuestion", (state) => (
      state.skipCurrentRetrieval ? "skip" : "retrieve"
    ), {
      skip: "evaluate",
      retrieve: "retrieve",
    })
    .addEdge("retrieve", "evaluate")
    .addConditionalEdges("evaluate", (state) => {
      if (state.evaluation?.nextAction !== "retrieve") {
        return state.evaluation?.nextAction ?? "generate";
      }
      return state.evaluation.retrievalMode === "multi_hop"
        ? "retrieve_multi"
        : "retrieve_direct";
    }, {
      retrieve_direct: "retrieve",
      retrieve_multi: "rewriteSubQuestion",
      web_search: "webSearch",
      generate: "generate",
    })
    .addEdge("webSearch", "evaluate")
    .addEdge("generate", END)
    .compile();
}
