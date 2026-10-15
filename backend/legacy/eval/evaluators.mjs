import { ChatOpenAI } from "@langchain/openai";
import {
  createLLMAsJudge,
  RAG_GROUNDEDNESS_PROMPT,
  RAG_HELPFULNESS_PROMPT,
  RAG_RETRIEVAL_RELEVANCE_PROMPT,
} from "openevals";
import { getConfig } from "../../src/config.js";

export const EVALUATION_METRICS = Object.freeze([
  "rag_groundedness",
  "rag_helpfulness",
  "rag_retrieval_relevance",
]);

function positiveTimeout(value, fallback) {
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized > 0
    ? Math.floor(normalized)
    : fallback;
}

export function createEvaluationJudge(options = {}) {
  const config = options.config ?? getConfig();
  const modelName = String(
    options.modelName
      ?? process.env.EVAL_MODEL_NAME
      ?? config.model.chatModel,
  ).trim();
  if (!modelName) throw new Error("评估模型名称不能为空");
  return {
    modelName,
    judge: new ChatOpenAI({
      apiKey: config.model.apiKey,
      configuration: config.model.baseUrl
        ? { baseURL: config.model.baseUrl }
        : undefined,
      model: modelName,
      temperature: 0,
      timeout: positiveTimeout(
        options.timeoutMs ?? process.env.EVAL_TIMEOUT_MS,
        config.model.requestTimeoutMs,
      ),
      maxRetries: 0,
    }),
  };
}

function assertEvaluationPayload({ inputs, outputs }) {
  if (!String(inputs?.question ?? "").trim()) {
    throw new Error("评估输入缺少 question");
  }
  if (!String(outputs?.answer ?? "").trim()) {
    throw new Error("评估输出缺少 answer");
  }
  if (!Array.isArray(outputs?.context) || outputs.context.length === 0) {
    throw new Error("评估输出缺少实际检索 context");
  }
}

export function createRagEvaluators({
  judge,
  judgeFactory = createLLMAsJudge,
} = {}) {
  if (!judge) throw new Error("三个评估器必须共用一个 Judge 模型实例");
  const groundednessJudge = judgeFactory({
    prompt: RAG_GROUNDEDNESS_PROMPT,
    feedbackKey: EVALUATION_METRICS[0],
    judge,
    continuous: true,
  });
  const helpfulnessJudge = judgeFactory({
    prompt: RAG_HELPFULNESS_PROMPT,
    feedbackKey: EVALUATION_METRICS[1],
    judge,
    continuous: true,
  });
  const retrievalRelevanceJudge = judgeFactory({
    prompt: RAG_RETRIEVAL_RELEVANCE_PROMPT,
    feedbackKey: EVALUATION_METRICS[2],
    judge,
    continuous: true,
  });

  const ragGroundednessEvaluator = async ({ inputs, outputs }) => {
    assertEvaluationPayload({ inputs, outputs });
    return groundednessJudge({
      context: { documents: outputs.context },
      outputs: { answer: outputs.answer },
    });
  };
  const ragHelpfulnessEvaluator = async ({ inputs, outputs }) => {
    assertEvaluationPayload({ inputs, outputs });
    return helpfulnessJudge({
      inputs: { question: inputs.question },
      outputs: { answer: outputs.answer },
    });
  };
  const ragRetrievalRelevanceEvaluator = async ({ inputs, outputs }) => {
    assertEvaluationPayload({ inputs, outputs });
    return retrievalRelevanceJudge({
      inputs: { question: inputs.question },
      context: { documents: outputs.context },
    });
  };

  Object.defineProperty(ragGroundednessEvaluator, "name", {
    value: EVALUATION_METRICS[0],
  });
  Object.defineProperty(ragHelpfulnessEvaluator, "name", {
    value: EVALUATION_METRICS[1],
  });
  Object.defineProperty(ragRetrievalRelevanceEvaluator, "name", {
    value: EVALUATION_METRICS[2],
  });

  return [
    ragGroundednessEvaluator,
    ragHelpfulnessEvaluator,
    ragRetrievalRelevanceEvaluator,
  ];
}
