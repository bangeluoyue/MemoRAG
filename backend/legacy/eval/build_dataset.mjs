import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "langsmith";
import { getConfig } from "../../src/config.js";

export const DEFAULT_DATASET_NAME = "memorag-epub-eval-v1";
const SAFE_SAMPLE_ID = /^[A-Za-z0-9_.:-]+$/u;
const LOCAL_REFERENCE = /^本地([1-9]\d*)$/u;

export class EvaluationSampleError extends Error {
  constructor(message) {
    super(message);
    this.name = "EvaluationSampleError";
  }
}

function requiredText(value, field, maximum = 20_000) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new EvaluationSampleError(`${field} 不能为空`);
  if (normalized.length > maximum) {
    throw new EvaluationSampleError(`${field} 超过长度限制`);
  }
  return normalized;
}

function optionalInteger(value, field) {
  if (value == null || value === "") return null;
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 0) {
    throw new EvaluationSampleError(`${field} 必须是非负整数`);
  }
  return normalized;
}

export function normalizeEvaluationSample(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EvaluationSampleError("评估样本必须是 JSON 对象");
  }
  const sampleId = requiredText(value.sampleId, "sampleId", 120);
  if (!SAFE_SAMPLE_ID.test(sampleId)) {
    throw new EvaluationSampleError("sampleId 只能包含字母、数字、点、冒号、下划线或连字符");
  }
  const knowledgeBase = requiredText(value.knowledgeBase, "knowledgeBase", 40);
  if (knowledgeBase !== "ebook") {
    throw new EvaluationSampleError("最小评估只接受公开 EPUB 样本");
  }
  const bookId = requiredText(value.bookId, "bookId", 128);
  const bookName = requiredText(value.bookName, "bookName", 500);
  const question = requiredText(value.question, "question", 4_000);
  const answer = requiredText(value.answer, "answer", 20_000);
  const capturedAt = requiredText(value.capturedAt, "capturedAt", 80);
  if (!Number.isFinite(Date.parse(capturedAt))) {
    throw new EvaluationSampleError("capturedAt 必须是有效的 ISO 日期时间");
  }
  if (!Array.isArray(value.sources) || value.sources.length === 0) {
    throw new EvaluationSampleError("sources 必须包含实际检索来源");
  }
  if (value.sources.length > 20) {
    throw new EvaluationSampleError("单个评估样本最多包含 20 条来源");
  }

  const sourceIds = new Set();
  const references = new Set();
  const sources = value.sources.map((source, index) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw new EvaluationSampleError(`sources[${index}] 必须是对象`);
    }
    const id = requiredText(source.id, `sources[${index}].id`, 200);
    const reference = requiredText(source.reference, `sources[${index}].reference`, 40);
    const match = reference.match(LOCAL_REFERENCE);
    if (!match || Number(match[1]) !== index + 1) {
      throw new EvaluationSampleError("sources 必须按 本地1、本地2… 的真实顺序保存");
    }
    if (sourceIds.has(id) || references.has(reference)) {
      throw new EvaluationSampleError("sources 中的文档 ID 和引用编号必须唯一");
    }
    sourceIds.add(id);
    references.add(reference);
    const sourceBookId = requiredText(source.bookId, `sources[${index}].bookId`, 128);
    if (sourceBookId !== bookId) {
      throw new EvaluationSampleError("source.bookId 与样本 bookId 不一致");
    }
    return {
      id,
      reference,
      bookId: sourceBookId,
      bookName: requiredText(
        source.bookName ?? bookName,
        `sources[${index}].bookName`,
        500,
      ),
      chapterNum: optionalInteger(source.chapterNum, `sources[${index}].chapterNum`),
      chunkIndex: optionalInteger(source.chunkIndex, `sources[${index}].chunkIndex`),
      content: requiredText(source.content, `sources[${index}].content`, 30_000),
    };
  });

  const citedReferences = [...answer.matchAll(/\[本地(\d+)\]/gu)]
    .map((match) => `本地${Number(match[1])}`);
  if (!citedReferences.length) {
    throw new EvaluationSampleError("answer 必须包含至少一个真实本地引用");
  }
  const invalidReference = citedReferences.find((reference) => !references.has(reference));
  if (invalidReference) {
    throw new EvaluationSampleError(`answer 包含不存在的引用 ${invalidReference}`);
  }

  return {
    sampleId,
    knowledgeBase,
    bookId,
    bookName,
    question,
    answer,
    capturedAt: new Date(capturedAt).toISOString(),
    traceId: String(value.traceId ?? "").trim() || null,
    sources,
  };
}

export async function loadEvaluationSample(samplePath) {
  if (!samplePath) throw new EvaluationSampleError("请通过 --sample 指定真实样本 JSON");
  const absolutePath = resolve(samplePath);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(absolutePath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new EvaluationSampleError("评估样本不是有效 JSON");
    }
    throw new EvaluationSampleError("无法读取评估样本文件");
  }
  return normalizeEvaluationSample(parsed);
}

export function sampleToDatasetInputs(sample) {
  const context = sample.sources.map((source) => (
    `[${source.reference}] 文档ID=${source.id}\n${source.content}`
  ));
  const base = {
    sample_id: sample.sampleId,
    knowledge_base: sample.knowledgeBase,
    book_id: sample.bookId,
    book_name: sample.bookName,
    question: sample.question,
    recorded_answer: sample.answer,
    retrieved_context: context,
    sources: sample.sources.map((source) => ({
      id: source.id,
      reference: source.reference,
      book_id: source.bookId,
      book_name: source.bookName,
      chapter_num: source.chapterNum,
      chunk_index: source.chunkIndex,
    })),
    captured_at: sample.capturedAt,
    trace_id: sample.traceId,
  };
  return {
    ...base,
    sample_fingerprint: createHash("sha256")
      .update(JSON.stringify(base))
      .digest("hex"),
  };
}

export async function syncEvaluationDataset({ client, datasetName, sample }) {
  const inputs = sampleToDatasetInputs(sample);
  let dataset;
  if (await client.hasDataset({ datasetName })) {
    dataset = await client.readDataset({ datasetName });
  } else {
    dataset = await client.createDataset(datasetName, {
      description: "MemoRAG EPUB 已记录问答的最小 OpenEvals 评估集",
      metadata: { knowledge_base: "ebook", metric_count: 3 },
    });
  }

  const existingExamples = [];
  for await (const example of client.listExamples({ datasetId: dataset.id, limit: 100 })) {
    existingExamples.push(example);
  }
  const matching = existingExamples.find(
    (example) => example.inputs?.sample_id === sample.sampleId,
  );
  if (matching) {
    if (matching.inputs?.sample_fingerprint !== inputs.sample_fingerprint) {
      throw new EvaluationSampleError(
        "LangSmith 中同 sampleId 已存在不同内容；请使用新的 sampleId",
      );
    }
    return { dataset, example: matching, created: false };
  }
  if (existingExamples.length >= 3) {
    throw new EvaluationSampleError("最小评估数据集最多保留 3 条样本");
  }
  const [example] = await client.createExamples([{
    dataset_id: dataset.id,
    inputs,
    metadata: {
      sample_id: sample.sampleId,
      source_document_ids: sample.sources.map((source) => source.id),
      captured_from: "memorag_recorded_response",
    },
  }]);
  return { dataset, example, created: true };
}

export function parseDatasetArgs(argv) {
  const options = {
    execute: false,
    samplePath: "",
    datasetName: process.env.LANGSMITH_EVAL_DATASET?.trim()
      || DEFAULT_DATASET_NAME,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--execute") options.execute = true;
    else if (argument === "--sample") options.samplePath = argv[++index] ?? "";
    else if (argument === "--dataset") options.datasetName = argv[++index] ?? "";
    else if (argument === "--help") options.help = true;
    else throw new EvaluationSampleError(`未知参数：${argument}`);
  }
  options.datasetName = requiredText(options.datasetName, "datasetName", 200);
  return options;
}

export async function buildDataset({
  sample,
  datasetName = DEFAULT_DATASET_NAME,
  execute = false,
  client,
} = {}) {
  const normalized = normalizeEvaluationSample(sample);
  if (!execute) {
    return {
      mode: "dry-run",
      datasetName,
      sampleId: normalized.sampleId,
      sourceCount: normalized.sources.length,
      judgeCalls: 0,
    };
  }
  if (!client) throw new EvaluationSampleError("execute 模式缺少 LangSmith Client");
  const synced = await syncEvaluationDataset({ client, datasetName, sample: normalized });
  return {
    mode: "execute",
    datasetName,
    sampleId: normalized.sampleId,
    sourceCount: normalized.sources.length,
    judgeCalls: 0,
    ...synced,
  };
}

function printUsage() {
  console.log("用法：npm run eval:dataset -- --sample <真实样本.json> [--dataset 名称] [--execute]");
  console.log("默认仅校验；只有 --execute 才会创建或更新 LangSmith Dataset。");
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseDatasetArgs(argv);
  if (options.help) {
    printUsage();
    return;
  }
  const sample = await loadEvaluationSample(options.samplePath);
  if (!options.execute) {
    const result = await buildDataset({
      sample,
      datasetName: options.datasetName,
      execute: false,
    });
    console.log(JSON.stringify(result, null, 2));
    console.log("dry-run 完成：未访问 LangSmith，未调用模型。");
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
  const result = await buildDataset({
    sample,
    datasetName: options.datasetName,
    execute: true,
    client,
  });
  const datasetUrl = await client.getDatasetUrl({ datasetId: result.dataset.id });
  console.log(`${result.created ? "已创建" : "已复用"}样本：${result.sampleId}`);
  console.log(`Dataset：${datasetUrl}`);
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    const message = error instanceof EvaluationSampleError
      ? error.message
      : "LangSmith Dataset 操作失败";
    console.error(`${error?.name ?? "Error"}：${message}`);
    process.exitCode = 1;
  });
}
