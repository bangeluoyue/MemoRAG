import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "langsmith";
import { evaluate } from "langsmith/evaluation";
import { getConfig } from "../../src/config.js";
import {
  DEFAULT_DATASET_NAME,
  EvaluationSampleError,
  loadEvaluationSample,
  normalizeEvaluationSample,
  syncEvaluationDataset,
} from "./build_dataset.mjs";
import {
  createEvaluationJudge,
  createRagEvaluators,
  EVALUATION_METRICS,
  writeEvaluationDiagnostic,
} from "./evaluators.mjs";

const DEFAULT_EXPERIMENT_PREFIX = "memorag-openevals";
const DEFAULT_RESULTS_DIRECTORY = join(
  dirname(fileURLToPath(import.meta.url)),
  "results",
);

function requiredText(value, field, maximum = 200) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new EvaluationSampleError(`${field} 不能为空`);
  if (normalized.length > maximum) {
    throw new EvaluationSampleError(`${field} 超过长度限制`);
  }
  return normalized;
}

export function parseEvaluationArgs(argv) {
  const options = {
    execute: false,
    samplePath: "",
    metric: null,
    datasetName: process.env.LANGSMITH_EVAL_DATASET?.trim()
      || DEFAULT_DATASET_NAME,
    experimentPrefix: process.env.LANGSMITH_EVAL_EXPERIMENT_PREFIX?.trim()
      || DEFAULT_EXPERIMENT_PREFIX,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--execute") options.execute = true;
    else if (argument === "--sample") options.samplePath = argv[++index] ?? "";
    else if (argument === "--dataset") options.datasetName = argv[++index] ?? "";
    else if (argument === "--metric") options.metric = argv[++index] ?? "";
    else if (argument === "--experiment-prefix") {
      options.experimentPrefix = argv[++index] ?? "";
    } else if (argument === "--help") options.help = true;
    else throw new EvaluationSampleError(`未知参数：${argument}`);
  }
  options.datasetName = requiredText(options.datasetName, "datasetName");
  options.experimentPrefix = requiredText(
    options.experimentPrefix,
    "experimentPrefix",
  );
  if (options.metric != null && !EVALUATION_METRICS.includes(options.metric)) {
    throw new EvaluationSampleError(
      `metric 必须是以下之一：${EVALUATION_METRICS.join(", ")}`,
    );
  }
  return options;
}

export function replayRecordedAnswer(inputs) {
  return {
    answer: String(inputs?.recorded_answer ?? ""),
    context: Array.isArray(inputs?.retrieved_context)
      ? inputs.retrieved_context
      : [],
    sources: Array.isArray(inputs?.sources) ? inputs.sources : [],
  };
}

function normalizeFeedback(feedback) {
  return {
    key: String(feedback?.key ?? ""),
    score: feedback?.score ?? feedback?.value ?? null,
    comment: String(feedback?.comment ?? "").trim(),
  };
}

function extractRowFeedback(row) {
  const results = row?.evaluationResults?.results;
  if (!Array.isArray(results)) {
    throw new EvaluationSampleError(
      "LangSmith evaluate 返回了无法识别的 evaluationResults 结构",
    );
  }
  return results.map(normalizeFeedback);
}

function hasValidScore(feedback) {
  return typeof feedback.score === "boolean"
    || (typeof feedback.score === "number" && Number.isFinite(feedback.score));
}

function safeLabel(value, fallback) {
  const normalized = String(value ?? "")
    .replace(/[^A-Za-z0-9_.:-]/gu, "_")
    .slice(0, 80);
  return normalized || fallback;
}

function safeFieldNames(value) {
  if (!value || typeof value !== "object") return [];
  return Object.keys(value).slice(0, 20).map(
    (field) => safeLabel(field, "unknown"),
  );
}

function safeErrorFields(error) {
  const candidates = [
    error?.status,
    error?.statusCode,
    error?.response?.status,
    error?.cause?.status,
    error?.cause?.statusCode,
  ];
  const httpStatus = candidates.map(Number).find(
    (value) => Number.isInteger(value) && value >= 100 && value <= 599,
  );
  return {
    errorType: safeLabel(
      error?.name ?? error?.constructor?.name,
      "UnknownError",
    ),
    httpStatus: httpStatus ?? null,
    errorCode: safeLabel(error?.code ?? error?.cause?.code, "UNKNOWN"),
  };
}

function emitDiagnostic(logger, event) {
  try {
    logger(event);
  } catch {
    // 诊断失败不能改变评估结果。
  }
}

function evaluatorResponseCount(value) {
  if (Array.isArray(value)) return value.length;
  if (Array.isArray(value?.results)) return value.results.length;
  return value && typeof value === "object" ? 1 : 0;
}

function createDiagnosticClient(client, diagnosticLogger, state) {
  if (typeof client?.logEvaluationFeedback !== "function") return client;
  const originalLogEvaluationFeedback = client.logEvaluationFeedback.bind(client);
  return new Proxy(client, {
    get(target, property) {
      if (property === "logEvaluationFeedback") {
        return async (...args) => {
          const params = args[0];
          const evaluatorResponse = params
            && typeof params === "object"
            && "evaluatorResponse" in params
            ? params.evaluatorResponse
            : params;
          state.feedbackLogAttempts += 1;
          emitDiagnostic(diagnosticLogger, {
            event: "evaluation_feedback_log_started",
            evaluatorResponseCount: evaluatorResponseCount(evaluatorResponse),
            evaluatorResponseFields: safeFieldNames(evaluatorResponse),
          });
          try {
            const result = await originalLogEvaluationFeedback(...args);
            state.feedbackLogSuccesses += 1;
            emitDiagnostic(diagnosticLogger, {
              event: "evaluation_feedback_log_returned",
              resultIsArray: Array.isArray(result),
              resultCount: Array.isArray(result) ? result.length : 0,
            });
            return result;
          } catch (error) {
            state.feedbackLogFailures += 1;
            emitDiagnostic(diagnosticLogger, {
              event: "evaluation_feedback_log_failed",
              ...safeErrorFields(error),
            });
            // 避免 SDK 再次输出可能包含上游内容的完整异常；缺失指标会统一失败退出。
            return [];
          }
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function createDiagnosticTarget(diagnosticLogger) {
  return (inputs) => {
    emitDiagnostic(diagnosticLogger, {
      event: "evaluation_target_invoked",
      inputFields: safeFieldNames(inputs),
      hasRecordedAnswer: Boolean(String(inputs?.recorded_answer ?? "").trim()),
      retrievedContextCount: Array.isArray(inputs?.retrieved_context)
        ? inputs.retrieved_context.length
        : 0,
    });
    const outputs = replayRecordedAnswer(inputs);
    emitDiagnostic(diagnosticLogger, {
      event: "evaluation_target_returned",
      outputFields: safeFieldNames(outputs),
      hasAnswer: Boolean(outputs.answer.trim()),
      contextCount: outputs.context.length,
      sourceCount: outputs.sources.length,
    });
    return outputs;
  };
}

async function readExperimentRows(experiment, diagnosticLogger) {
  if (Array.isArray(experiment?.results)) {
    emitDiagnostic(diagnosticLogger, {
      event: "evaluation_results_ready",
      source: "results_property",
      rowCount: experiment.results.length,
      processedCount: Number.isInteger(experiment.processedCount)
        ? experiment.processedCount
        : null,
    });
    return experiment.results;
  }
  const rows = [];
  for await (const row of experiment) rows.push(row);
  emitDiagnostic(diagnosticLogger, {
    event: "evaluation_results_ready",
    source: "async_iterator",
    rowCount: rows.length,
    processedCount: null,
  });
  return rows;
}

async function resolveExperimentUrl(client, dataset, experimentName) {
  const datasetUrl = await client.getDatasetUrl({ datasetId: dataset.id });
  for await (const project of client.listProjects({
    name: experimentName,
    referenceDatasetId: dataset.id,
  })) {
    return `${datasetUrl}/compare?selectedSessions=${project.id}`;
  }
  return datasetUrl;
}

export async function runRecordedEvaluation({
  sample,
  datasetName = DEFAULT_DATASET_NAME,
  experimentPrefix = DEFAULT_EXPERIMENT_PREFIX,
  execute = false,
  client,
  evaluateFn = evaluate,
  judge,
  judgeModelName = "qwen-plus",
  judgeFactory,
  resultsDirectory = DEFAULT_RESULTS_DIRECTORY,
  metric = null,
  diagnosticLogger = writeEvaluationDiagnostic,
} = {}) {
  const normalized = normalizeEvaluationSample(sample);
  if (metric != null && !EVALUATION_METRICS.includes(metric)) {
    throw new EvaluationSampleError("评估指标配置无效");
  }
  const selectedMetrics = metric ? [metric] : [...EVALUATION_METRICS];
  const plan = {
    mode: execute ? "execute" : "dry-run",
    sampleId: normalized.sampleId,
    datasetName,
    experimentPrefix,
    metrics: selectedMetrics,
    judgeModel: judgeModelName,
    judgeCalls: execute ? selectedMetrics.length : 0,
    ragCalls: 0,
    embeddingCalls: 0,
    sourceCount: normalized.sources.length,
  };
  if (!execute) return plan;
  if (!client || !judge) {
    throw new EvaluationSampleError("execute 模式缺少 LangSmith Client 或 Judge");
  }

  const synced = await syncEvaluationDataset({ client, datasetName, sample: normalized });
  const diagnosticState = {
    feedbackLogAttempts: 0,
    feedbackLogSuccesses: 0,
    feedbackLogFailures: 0,
  };
  const evaluationClient = createDiagnosticClient(
    client,
    diagnosticLogger,
    diagnosticState,
  );
  const evaluators = createRagEvaluators({
    judge,
    judgeFactory,
    metrics: selectedMetrics,
    diagnosticLogger,
  });
  emitDiagnostic(diagnosticLogger, {
    event: "evaluation_configured",
    dataCount: 1,
    evaluatorCount: evaluators.length,
    targetType: "function",
    selectedMetricCount: selectedMetrics.length,
  });
  const experiment = await evaluateFn(createDiagnosticTarget(diagnosticLogger), {
    data: [synced.example],
    evaluators,
    client: evaluationClient,
    experimentPrefix,
    maxConcurrency: 1,
    targetConcurrency: 1,
    evaluationConcurrency: 1,
    numRepetitions: 1,
    metadata: {
      sample_id: normalized.sampleId,
      knowledge_base: "ebook",
      judge_model: judgeModelName,
      evaluation_metrics: selectedMetrics,
      rag_replayed: true,
    },
  });

  emitDiagnostic(diagnosticLogger, {
    event: "evaluation_evaluate_returned",
    resultFields: safeFieldNames(experiment),
    hasResultsArray: Array.isArray(experiment?.results),
    resultsCount: Array.isArray(experiment?.results)
      ? experiment.results.length
      : null,
  });
  const experimentRows = await readExperimentRows(experiment, diagnosticLogger);
  const rows = experimentRows.map((row, index) => {
    const resultCount = Array.isArray(row?.evaluationResults?.results)
      ? row.evaluationResults.results.length
      : null;
    emitDiagnostic(diagnosticLogger, {
      event: "evaluation_row_received",
      rowIndex: index,
      rowFields: safeFieldNames(row),
      hasRun: Boolean(row?.run),
      hasExample: Boolean(row?.example),
      hasEvaluationResults: Boolean(row?.evaluationResults),
      resultCount,
    });
    return {
      runId: row.run?.id ?? null,
      sampleId: row.example?.inputs?.sample_id ?? normalized.sampleId,
      feedback: extractRowFeedback(row),
    };
  });
  emitDiagnostic(diagnosticLogger, {
    event: "evaluation_feedback_summary",
    feedbackLogAttempts: diagnosticState.feedbackLogAttempts,
    feedbackLogSuccesses: diagnosticState.feedbackLogSuccesses,
    feedbackLogFailures: diagnosticState.feedbackLogFailures,
    rowCount: rows.length,
  });
  const feedback = rows.flatMap((row) => row.feedback);
  const received = new Set(
    feedback.filter(hasValidScore).map((item) => item.key),
  );
  const missingMetrics = selectedMetrics.filter((key) => !received.has(key));
  if (missingMetrics.length) {
    throw new EvaluationSampleError(
      `LangSmith 评估未完整返回有效指标：${missingMetrics.join(", ")}`,
    );
  }
  const url = await resolveExperimentUrl(
    client,
    synced.dataset,
    experiment.experimentName,
  );
  const result = {
    ...plan,
    experimentName: experiment.experimentName,
    experimentUrl: url,
    datasetCreated: synced.created,
    completedAt: new Date().toISOString(),
    feedback,
    missingMetrics,
  };

  await mkdir(resultsDirectory, { recursive: true });
  const resultPath = join(
    resultsDirectory,
    `${result.completedAt.replace(/[:.]/gu, "-")}-${normalized.sampleId}.json`,
  );
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return { ...result, resultPath };
}

function printUsage() {
  console.log("用法：npm run eval:run -- --sample <真实样本.json> [--metric 指标] [--execute]");
  console.log("默认只校验并显示计划；--execute 会上传 Dataset 并串行调用所选 Judge。");
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseEvaluationArgs(argv);
  if (options.help) {
    printUsage();
    return;
  }
  const sample = await loadEvaluationSample(options.samplePath);
  if (!options.execute) {
    const plan = await runRecordedEvaluation({
      sample,
      datasetName: options.datasetName,
      experimentPrefix: options.experimentPrefix,
      execute: false,
      metric: options.metric,
      judgeModelName: process.env.EVAL_MODEL_NAME?.trim() || "qwen-plus",
    });
    console.log(JSON.stringify(plan, null, 2));
    console.log("dry-run 完成：未访问 LangSmith，未调用 Judge、RAG 或 Embedding。");
    return;
  }

  const config = getConfig();
  if (!config.langsmith.apiKey) {
    throw new EvaluationSampleError("execute 模式缺少 LANGSMITH_API_KEY");
  }
  const client = new Client({
    apiKey: config.langsmith.apiKey,
    apiUrl: config.langsmith.endpoint,
  });
  const { judge, modelName } = createEvaluationJudge({ config });
  const result = await runRecordedEvaluation({
    sample,
    datasetName: options.datasetName,
    experimentPrefix: options.experimentPrefix,
    execute: true,
    client,
    judge,
    judgeModelName: modelName,
    metric: options.metric,
  });

  console.log(`Experiment：${result.experimentName}`);
  for (const item of result.feedback) {
    console.log(`${item.key}: ${item.score}`);
    if (item.comment) console.log(`  ${item.comment}`);
  }
  console.log(`LangSmith：${result.experimentUrl}`);
  console.log(`本地结果：${result.resultPath}`);
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    const message = error instanceof EvaluationSampleError
      ? error.message
      : "LangSmith 评估执行失败";
    console.error(`${error?.name ?? "Error"}：${message}`);
    process.exitCode = 1;
  });
}
