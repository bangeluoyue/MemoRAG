import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDataset,
  EvaluationSampleError,
  normalizeEvaluationSample,
  sampleToDatasetInputs,
} from "../legacy/eval/build_dataset.mjs";
import {
  createRagEvaluators,
  EVALUATION_METRICS,
} from "../legacy/eval/evaluators.mjs";
import { runRecordedEvaluation } from "../legacy/eval/run_eval.mjs";

function validSample(overrides = {}) {
  return {
    sampleId: "aq-mock-001",
    knowledgeBase: "ebook",
    bookId: "epub-public-book",
    bookName: "公开测试书",
    question: "人物如何安慰自己？",
    answer: "人物通过重新解释失败来安慰自己 [本地1]。",
    capturedAt: "2026-10-15T08:00:00.000Z",
    traceId: "trace-public-1",
    sources: [{
      id: "doc-public-1",
      reference: "本地1",
      bookId: "epub-public-book",
      bookName: "公开测试书",
      chapterNum: 1,
      chunkIndex: 2,
      content: "公开测试原文描述人物重新解释失败。",
    }],
    ...overrides,
  };
}

test("evaluation sample preserves actual answer/source mapping and rejects invented references", () => {
  const sample = normalizeEvaluationSample(validSample());
  const inputs = sampleToDatasetInputs(sample);

  assert.equal(inputs.recorded_answer, sample.answer);
  assert.equal(inputs.retrieved_context.length, 1);
  assert.match(inputs.retrieved_context[0], /doc-public-1/u);
  assert.deepEqual(inputs.sources.map((source) => source.id), ["doc-public-1"]);
  assert.equal(inputs.trace_id, "trace-public-1");
  assert.match(inputs.sample_fingerprint, /^[a-f0-9]{64}$/u);

  assert.throws(
    () => normalizeEvaluationSample(validSample({ answer: "错误引用 [本地2]。" })),
    (error) => error instanceof EvaluationSampleError
      && /不存在的引用/u.test(error.message),
  );
  assert.throws(
    () => normalizeEvaluationSample(validSample({ knowledgeBase: "life_notes" })),
    (error) => error instanceof EvaluationSampleError
      && /只接受公开 EPUB/u.test(error.message),
  );
});

test("dataset and experiment dry-runs never access LangSmith or a model", async () => {
  const client = new Proxy({}, {
    get() { throw new Error("EXTERNAL_CLIENT_MUST_NOT_BE_USED"); },
  });
  const datasetPlan = await buildDataset({
    sample: validSample(),
    datasetName: "memorag-dry-run",
    execute: false,
    client,
  });
  const evaluationPlan = await runRecordedEvaluation({
    sample: validSample(),
    datasetName: "memorag-dry-run",
    execute: false,
    client,
    judge: new Proxy({}, {
      get() { throw new Error("JUDGE_MUST_NOT_BE_USED"); },
    }),
  });

  assert.equal(datasetPlan.mode, "dry-run");
  assert.equal(datasetPlan.judgeCalls, 0);
  assert.equal(evaluationPlan.mode, "dry-run");
  assert.equal(evaluationPlan.judgeCalls, 0);
  assert.equal(evaluationPlan.ragCalls, 0);
  assert.equal(evaluationPlan.embeddingCalls, 0);
  assert.deepEqual(evaluationPlan.metrics, EVALUATION_METRICS);
});

test("three OpenEvals adapters share one Judge and receive the expected RAG fields", async () => {
  const judge = { id: "shared-judge" };
  const definitions = [];
  const invocations = [];
  const judgeFactory = (definition) => {
    definitions.push(definition);
    return async (payload) => {
      invocations.push({ key: definition.feedbackKey, payload });
      return { key: definition.feedbackKey, score: 0.8, comment: "mock" };
    };
  };
  const evaluators = createRagEvaluators({ judge, judgeFactory });
  const inputs = { question: "人物如何安慰自己？" };
  const outputs = {
    answer: "根据原文回答 [本地1]。",
    context: ["[本地1] 公开原文"],
  };
  for (const evaluator of evaluators) await evaluator({ inputs, outputs });

  assert.deepEqual(definitions.map((item) => item.feedbackKey), EVALUATION_METRICS);
  assert.equal(definitions.every((item) => item.judge === judge), true);
  assert.equal(definitions.every((item) => item.continuous === true), true);
  assert.deepEqual(invocations[0].payload, {
    context: { documents: outputs.context },
    outputs: { answer: outputs.answer },
  });
  assert.deepEqual(invocations[1].payload, {
    inputs,
    outputs: { answer: outputs.answer },
  });
  assert.deepEqual(invocations[2].payload, {
    inputs,
    context: { documents: outputs.context },
  });
});

test("mock execute creates one replay experiment, three scores, and a local result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "memorag-eval-"));
  const sample = normalizeEvaluationSample(validSample());
  const datasetInputs = sampleToDatasetInputs(sample);
  let capturedOptions;
  let judgeCalls = 0;
  const client = {
    async hasDataset() { return true; },
    async readDataset() { return { id: "dataset-1", name: "memorag-eval" }; },
    async *listExamples() {},
    async createExamples(examples) {
      return [{ id: "example-1", inputs: examples[0].inputs }];
    },
    async getDatasetUrl() { return "https://smith.example/datasets/dataset-1"; },
    async *listProjects() { yield { id: "experiment-1" }; },
  };
  const judgeFactory = ({ feedbackKey }) => async () => {
    judgeCalls += 1;
    return { key: feedbackKey, score: 0.9, comment: `${feedbackKey} mock` };
  };
  const evaluateFn = async (target, options) => {
    capturedOptions = options;
    const outputs = target(datasetInputs);
    const feedback = [];
    for (const evaluator of options.evaluators) {
      feedback.push(await evaluator({
        inputs: datasetInputs,
        outputs,
      }));
    }
    return {
      experimentName: "memorag-openevals-mock",
      async *[Symbol.asyncIterator]() {
        yield {
          run: { id: "run-1" },
          example: { inputs: datasetInputs },
          evaluationResults: { results: feedback },
        };
      },
    };
  };

  try {
    const result = await runRecordedEvaluation({
      sample,
      datasetName: "memorag-eval",
      execute: true,
      client,
      evaluateFn,
      judge: { id: "shared-judge" },
      judgeModelName: "mock-judge",
      judgeFactory,
      resultsDirectory: directory,
    });

    assert.equal(judgeCalls, 3);
    assert.equal(capturedOptions.maxConcurrency, 1);
    assert.equal(capturedOptions.numRepetitions, 1);
    assert.equal(capturedOptions.data.length, 1);
    assert.equal(capturedOptions.data[0].id, "example-1");
    assert.equal(capturedOptions.disableEvaluatorTracing, true);
    assert.equal(result.feedback.length, 3);
    assert.deepEqual(result.missingMetrics, []);
    assert.match(result.experimentUrl, /selectedSessions=experiment-1/u);
    const saved = JSON.parse(await readFile(result.resultPath, "utf8"));
    assert.deepEqual(saved.feedback, result.feedback);
    assert.equal(saved.ragCalls, 0);
    assert.equal(saved.embeddingCalls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
