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
export const EVALUATION_STRUCTURED_OUTPUT_METHOD = "functionCalling";

class EvaluationChatOpenAI extends ChatOpenAI {
  withStructuredOutput(outputSchema, config = {}) {
    return super.withStructuredOutput(outputSchema, {
      ...config,
      method: EVALUATION_STRUCTURED_OUTPUT_METHOD,
    });
  }
}

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
  const configuration = {
    ...(config.model.baseUrl ? { baseURL: config.model.baseUrl } : {}),
    ...(options.configuration ?? {}),
  };
  return {
    modelName,
    structuredOutputMethod: EVALUATION_STRUCTURED_OUTPUT_METHOD,
    judge: new EvaluationChatOpenAI({
      apiKey: config.model.apiKey,
      configuration,
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

function safeLabel(value, fallback) {
  const normalized = String(value ?? "")
    .replace(/[^A-Za-z0-9_.:-]/gu, "_")
    .slice(0, 80);
  return normalized || fallback;
}

function firstHttpStatus(error) {
  const candidates = [
    error?.status,
    error?.statusCode,
    error?.response?.status,
    error?.cause?.status,
    error?.cause?.statusCode,
  ];
  const status = candidates.map(Number).find(
    (value) => Number.isInteger(value) && value >= 100 && value <= 599,
  );
  return status ?? null;
}

function evaluatorErrorSummary(metric, error) {
  return {
    event: "langsmith_evaluator_failed",
    metric,
    errorType: safeLabel(
      error?.name ?? error?.constructor?.name,
      "UnknownError",
    ),
    httpStatus: firstHttpStatus(error),
    errorCode: safeLabel(error?.code ?? error?.cause?.code, "UNKNOWN"),
  };
}

export function writeEvaluationDiagnostic(summary) {
  process.stderr.write(`${JSON.stringify(summary)}\n`);
}

function valueType(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function safeFieldNames(value) {
  if (!value || typeof value !== "object") return [];
  return Object.keys(value).slice(0, 20).map(
    (field) => safeLabel(field, "unknown"),
  );
}

function emitDiagnostic(logger, event) {
  try {
    logger(event);
  } catch {
    // 诊断失败不能改变评估结果。
  }
}

function observableJudge(judge, metric, diagnosticLogger) {
  return {
    _modelType: judge._modelType.bind(judge),
    withStructuredOutput(outputSchema, config) {
      const runnable = judge.withStructuredOutput(outputSchema, config);
      return {
        async invoke(...args) {
          emitDiagnostic(diagnosticLogger, {
            event: "evaluation_judge_started",
            metric,
          });
          try {
            const result = await runnable.invoke(...args);
            emitDiagnostic(diagnosticLogger, {
              event: "evaluation_judge_returned",
              metric,
              resultType: valueType(result),
              resultFields: safeFieldNames(result),
            });
            return result;
          } catch (error) {
            emitDiagnostic(diagnosticLogger, {
              ...evaluatorErrorSummary(metric, error),
              event: "evaluation_judge_failed",
            });
            throw error;
          }
        },
      };
    },
  };
}

function inspectEvaluatorResult(result, metric) {
  const isArray = Array.isArray(result);
  const resultFields = safeFieldNames(result);
  const hasKey = !isArray && typeof result?.key === "string";
  const keyMatches = hasKey && result.key === metric;
  const hasValidScore = !isArray && (
    typeof result?.score === "boolean"
    || (typeof result?.score === "number" && Number.isFinite(result.score))
  );
  return {
    resultType: valueType(result),
    resultCount: isArray ? result.length : null,
    resultFields,
    hasKey,
    keyMatches,
    hasValidScore,
  };
}

async function runEvaluatorSafely(metric, invoke, errorLogger) {
  try {
    return await invoke();
  } catch (error) {
    try {
      errorLogger(evaluatorErrorSummary(metric, error));
    } catch {
      // 日志失败不能覆盖原始评估失败；缺失指标会由 run_eval 统一终止。
    }
    // LangSmith evaluate 会自行吞掉 evaluator 异常并打印完整错误。
    // 返回空结果可避免泄露上游响应；run_eval 会把该指标判为缺失并失败退出。
    return [];
  }
}

export function createRagEvaluators({
  judge,
  judgeFactory = createLLMAsJudge,
  errorLogger = writeEvaluationDiagnostic,
  diagnosticLogger = () => {},
  metrics = EVALUATION_METRICS,
} = {}) {
  if (!judge) throw new Error("三个评估器必须共用一个 Judge 模型实例");
  const selectedMetrics = [...new Set(metrics)];
  if (!selectedMetrics.length || selectedMetrics.some(
    (metric) => !EVALUATION_METRICS.includes(metric),
  )) {
    throw new Error("评估指标配置无效");
  }
  const definitions = {
    [EVALUATION_METRICS[0]]: {
      prompt: RAG_GROUNDEDNESS_PROMPT,
      payload: ({ outputs }) => ({
        context: { documents: outputs.context },
        outputs: { answer: outputs.answer },
      }),
    },
    [EVALUATION_METRICS[1]]: {
      prompt: RAG_HELPFULNESS_PROMPT,
      payload: ({ inputs, outputs }) => ({
        inputs: { question: inputs.question },
        outputs: { answer: outputs.answer },
      }),
    },
    [EVALUATION_METRICS[2]]: {
      prompt: RAG_RETRIEVAL_RELEVANCE_PROMPT,
      payload: ({ inputs, outputs }) => ({
        inputs: { question: inputs.question },
        context: { documents: outputs.context },
      }),
    },
  };

  return selectedMetrics.map((metric) => {
    const definition = definitions[metric];
    const metricJudgeModel = typeof judge?._modelType === "function"
      && typeof judge?.withStructuredOutput === "function"
      ? observableJudge(judge, metric, diagnosticLogger)
      : judge;
    const metricJudge = judgeFactory({
      prompt: definition.prompt,
      feedbackKey: metric,
      judge: metricJudgeModel,
      continuous: true,
    });
    const evaluator = async ({ inputs, outputs }) => {
      emitDiagnostic(diagnosticLogger, {
        event: "evaluation_evaluator_invoked",
        metric,
        inputFields: safeFieldNames(inputs),
        outputFields: safeFieldNames(outputs),
        hasQuestion: Boolean(String(inputs?.question ?? "").trim()),
        hasAnswer: Boolean(String(outputs?.answer ?? "").trim()),
        contextCount: Array.isArray(outputs?.context) ? outputs.context.length : 0,
      });
      return runEvaluatorSafely(metric, async () => {
        assertEvaluationPayload({ inputs, outputs });
        emitDiagnostic(diagnosticLogger, {
          event: "evaluation_payload_validated",
          metric,
        });
        const result = await metricJudge(definition.payload({ inputs, outputs }));
        const inspection = inspectEvaluatorResult(result, metric);
        emitDiagnostic(diagnosticLogger, {
          event: "evaluation_openevals_returned",
          metric,
          ...inspection,
        });
        if (!inspection.keyMatches || !inspection.hasValidScore) {
          const error = new Error("OpenEvals 返回结果无效");
          error.name = "InvalidEvaluatorResultError";
          error.code = "INVALID_EVALUATOR_RESULT";
          throw error;
        }
        return result;
      }, errorLogger);
    };
    Object.defineProperty(evaluator, "name", { value: metric });
    return evaluator;
  });
}
