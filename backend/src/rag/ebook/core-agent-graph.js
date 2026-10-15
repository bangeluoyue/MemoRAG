import { END, START, StateGraph } from "@langchain/langgraph";
import { createCoreDecisionNode } from "./nodes/core-decision.js";
import { createCoreDecomposeQuestionNode } from "./nodes/core-decompose.js";
import { createCoreGenerateNode } from "./nodes/core-generate.js";
import { createGenerateNodes } from "./nodes/generate.js";
import { createRetrieveNode } from "./nodes/retrieve.js";
import { createRouteNodes } from "./nodes/route.js";
import { createWebSearchNode } from "./nodes/web-search.js";
import { EbookRagState } from "./state.js";

export function createCoreAgenticRagGraph({
  model,
  retriever,
  bookName,
  maxContextDocuments = 12,
  maxSubQuestions = 4,
  webSearch = null,
  maxWebSearches = 2,
  maxCitationCorrectionAttempts = 1,
  modelTimeoutMs,
  decisionTimeoutMs = 15000,
}) {
  const subQuestionLimit = Math.min(
    8,
    Math.max(1, Math.floor(Number(maxSubQuestions) || 4)),
  );
  const citationCorrectionLimit = Math.max(
    0,
    Math.floor(Number(maxCitationCorrectionAttempts) || 0),
  );
  const { routeQuestionNode, prepareSingleRetrievalNode } = createRouteNodes({
    model,
    bookName,
    knowledgeBase: "ebook",
    modelTimeoutMs,
  });
  const decomposeQuestionNode = createCoreDecomposeQuestionNode({
    model,
    bookName,
    subQuestionLimit,
    modelTimeoutMs,
  });
  const retrieveNode = createRetrieveNode({ retriever, maxContextDocuments });
  const decisionNode = createCoreDecisionNode({
    model,
    webSearch,
    maxWebSearches,
    modelTimeoutMs,
    decisionTimeoutMs,
  });
  const webSearchNode = createWebSearchNode({ webSearch });
  const { directAnswerNode } = createGenerateNodes({
    model,
    citationCorrectionLimit,
    modelTimeoutMs,
  });
  const generateNode = createCoreGenerateNode({
    model,
    citationCorrectionLimit,
    modelTimeoutMs,
  });

  return new StateGraph(EbookRagState)
    .addNode("routeQuestion", routeQuestionNode)
    .addNode("directAnswer", directAnswerNode)
    .addNode("prepareSingleRetrieval", prepareSingleRetrievalNode)
    .addNode("decomposeQuestion", decomposeQuestionNode)
    .addNode("retrieve", retrieveNode)
    .addNode("decision", decisionNode)
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
    .addEdge("decomposeQuestion", "retrieve")
    .addEdge("retrieve", "decision")
    .addConditionalEdges("decision", (state) => (
      state.evaluation?.nextAction ?? "generate"
    ), {
      retrieve: "retrieve",
      web_search: "webSearch",
      generate: "generate",
    })
    .addEdge("webSearch", "generate")
    .addEdge("generate", END)
    .compile();
}
