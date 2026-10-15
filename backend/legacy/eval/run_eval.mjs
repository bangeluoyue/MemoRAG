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
} = {}) {
  const normalized = normalizeEvaluationSample(sample);
  const plan = {
    mode: execute ? "execute" : "dry-run",
    sampleId: normalized.sampleId,
    datasetName,
    experimentPrefix,
    metrics: [...EVALUATION_METRICS],
    judgeModel: judgeModelName,
    judgeCalls: execute ? 3 : 0,
    ragCalls: 0,
    embeddingCalls: 0,
    sourceCount: normalized.sources.length,
  };
  if (!execute) return plan;
  if (!client || !judge) {
    throw new EvaluationSampleError("execute 模式缺少 LangSmith Client 或 Judge");
  }

  const synced = await syncEvaluationDataset({ client, datasetName, sample: normalized });
  const evaluators = createRagEvaluators({ judge, judgeFactory });
  const experiment = await evaluateFn(replayRecordedAnswer, {
    data: [synced.example],
    evaluators,
    client,
    experimentPrefix,
    maxConcurrency: 1,
    targetConcurrency: 1,
    evaluationConcurrency: 1,
    numRepetitions: 1,
    disableEvaluatorTracing: true,
    metadata: {
      sample_id: normalized.sampleId,
      knowledge_base: "ebook",
      judge_model: judgeModelName,
      rag_replayed: true,
    },
  });

  const rows = [];
  for await (const row of experiment) {
    rows.push({
      runId: row.run?.id ?? null,
      sampleId: row.example?.inputs?.sample_id ?? normalized.sampleId,
      feedback: (row.evaluationResults?.results ?? []).map(normalizeFeedback),
    });
  }
  const feedback = rows.flatMap((row) => row.feedback);
  const received = new Set(feedback.map((item) => item.key));
  const missingMetrics = EVALUATION_METRICS.filter((key) => !received.has(key));
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
  console.log("用法：npm run eval:run -- --sample <真实样本.json> [--execute]");
  console.log("默认只校验并显示计划；--execute 会上传 Dataset 并串行调用 3 次 Judge。");
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
  });

  console.log(`Experiment：${result.experimentName}`);
  for (const item of result.feedback) {
    console.log(`${item.key}: ${item.score}`);
    if (item.comment) console.log(`  ${item.comment}`);
  }
  if (result.missingMetrics.length) {
    console.log(`缺少指标：${result.missingMetrics.join(", ")}`);
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
