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
  createEvaluationJudge,
  createRagEvaluators,
  EVALUATION_METRICS,
  EVALUATION_STRUCTURED_OUTPUT_METHOD,
} from "../legacy/eval/evaluators.mjs";
import {
  parseEvaluationArgs,
  runRecordedEvaluation,
} from "../legacy/eval/run_eval.mjs";

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

test("qwen-plus evaluation sends function calling instead of json_schema", async () => {
  let requestBody;
  const config = {
    model: {
      apiKey: "offline-placeholder",
      baseUrl: "http://127.0.0.1.invalid/v1",
      chatModel: "qwen-plus",
      requestTimeoutMs: 1_000,
    },
  };
  const { judge, structuredOutputMethod } = createEvaluationJudge({
    config,
    configuration: {
      fetch: async (_url, init) => {
        requestBody = JSON.parse(init.body);
        const functionName = requestBody.tool_choice.function.name;
        return new Response(JSON.stringify({
          id: "chatcmpl-offline",
          object: "chat.completion",
          created: 0,
          model: "qwen-plus",
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{
                id: "call-offline",
                type: "function",
                function: {
                  name: functionName,
                  arguments: JSON.stringify({
                    reasoning: "offline mock",
                    score: 0.9,
                  }),
                },
              }],
            },
            finish_reason: "tool_calls",
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  });
  const [evaluator] = createRagEvaluators({
    judge,
    metrics: ["rag_groundedness"],
  });
  const feedback = await evaluator({
    inputs: { question: "公开问题" },
    outputs: { answer: "公开回答", context: ["公开上下文"] },
  });

  assert.equal(structuredOutputMethod, EVALUATION_STRUCTURED_OUTPUT_METHOD);
  assert.equal(requestBody.response_format, undefined);
  assert.equal(requestBody.tools[0].type, "function");
  assert.equal(requestBody.tool_choice.type, "function");
  assert.equal(feedback.key, "rag_groundedness");
  assert.equal(feedback.score, 0.9);
});

test("metric option limits the plan to one supported Judge", async () => {
  const options = parseEvaluationArgs([
    "--sample",
    "sample.json",
    "--metric",
    "rag_groundedness",
  ]);
  const plan = await runRecordedEvaluation({
    sample: validSample(),
    execute: false,
    metric: options.metric,
  });

  assert.deepEqual(plan.metrics, ["rag_groundedness"]);
  assert.equal(plan.judgeCalls, 0);
  assert.throws(
    () => parseEvaluationArgs(["--sample", "sample.json", "--metric", "unknown"]),
    /metric 必须是以下之一/u,
  );
});

test("evaluator failures emit only safe metadata and return no fake score", async () => {
  const logs = [];
  const unsafeError = new Error("secret prompt and upstream response body");
  unsafeError.name = "APIConnectionError";
  unsafeError.status = 429;
  unsafeError.code = "rate_limit_exceeded";
  unsafeError.response = { status: 429, data: "private response" };
  const evaluators = createRagEvaluators({
    judge: { id: "shared-judge" },
    judgeFactory: () => async () => { throw unsafeError; },
    errorLogger: (entry) => logs.push(entry),
  });

  const results = [];
  for (const evaluator of evaluators) {
    results.push(await evaluator({
      inputs: { question: "公开问题" },
      outputs: { answer: "公开回答", context: ["公开上下文"] },
    }));
  }

  assert.deepEqual(results, [[], [], []]);
  assert.equal(logs.length, 3);
  assert.deepEqual(logs.map((entry) => entry.metric), EVALUATION_METRICS);
  assert.equal(logs.every((entry) => entry.errorType === "APIConnectionError"), true);
  assert.equal(logs.every((entry) => entry.httpStatus === 429), true);
  assert.equal(logs.every((entry) => entry.errorCode === "rate_limit_exceeded"), true);
  assert.doesNotMatch(JSON.stringify(logs), /secret|private response/u);
});

test("default evaluator logger writes a sanitized summary directly to stderr", async () => {
  const originalWrite = process.stderr.write;
  let stderr = "";
  process.stderr.write = (chunk) => {
    stderr += String(chunk);
    return true;
  };
  const unsafeError = new Error("prompt, key, URL, and response must stay hidden");
  unsafeError.name = "BadRequestError";
  unsafeError.status = 400;
  unsafeError.code = "invalid_request_error";

  try {
    const [evaluator] = createRagEvaluators({
      judge: { id: "shared-judge" },
      judgeFactory: () => async () => { throw unsafeError; },
      metrics: ["rag_groundedness"],
    });
    assert.deepEqual(await evaluator({
      inputs: { question: "公开问题" },
      outputs: { answer: "公开回答", context: ["公开上下文"] },
    }), []);
  } finally {
    process.stderr.write = originalWrite;
  }

  const summary = JSON.parse(stderr.trim());
  assert.deepEqual(summary, {
    event: "langsmith_evaluator_failed",
    metric: "rag_groundedness",
    errorType: "BadRequestError",
    httpStatus: 400,
    errorCode: "invalid_request_error",
  });
  assert.doesNotMatch(stderr, /prompt, key|response must stay hidden/u);
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
      diagnosticLogger: () => {},
    });

    assert.equal(judgeCalls, 3);
    assert.equal(capturedOptions.maxConcurrency, 1);
    assert.equal(capturedOptions.numRepetitions, 1);
    assert.equal(capturedOptions.data.length, 1);
    assert.equal(capturedOptions.data[0].id, "example-1");
    assert.equal("disableEvaluatorTracing" in capturedOptions, false);
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

test("missing evaluator feedback fails instead of reporting a successful experiment", async () => {
  const sample = normalizeEvaluationSample(validSample());
  const client = {
    async hasDataset() { return true; },
    async readDataset() { return { id: "dataset-1", name: "memorag-eval" }; },
    async *listExamples() {},
    async createExamples(examples) {
      return [{ id: "example-1", inputs: examples[0].inputs }];
    },
  };
  const evaluateFn = async () => ({
    experimentName: "memorag-openevals-empty",
    async *[Symbol.asyncIterator]() {
      yield {
        run: { id: "run-empty" },
        example: { inputs: sampleToDatasetInputs(sample) },
        evaluationResults: { results: [] },
      };
    },
  });

  await assert.rejects(
    runRecordedEvaluation({
      sample,
      datasetName: "memorag-eval",
      execute: true,
      client,
      evaluateFn,
      judge: { id: "shared-judge" },
      judgeFactory: () => async () => ({ key: "unused", score: true }),
      diagnosticLogger: () => {},
    }),
    (error) => error instanceof EvaluationSampleError
      && /评估未完整返回有效指标/u.test(error.message),
  );
});

test("installed LangSmith evaluate runs the complete offline feedback chain", async () => {
  const directory = await mkdtemp(join(tmpdir(), "memorag-eval-sdk-"));
  const sample = normalizeEvaluationSample(validSample());
  const inputs = sampleToDatasetInputs(sample);
  const now = "2026-10-15T08:00:00.000Z";
  const example = {
    id: "00000000-0000-4000-8000-000000000002",
    dataset_id: "00000000-0000-4000-8000-000000000001",
    inputs,
    outputs: null,
    metadata: {},
    created_at: now,
    modified_at: now,
  };
  const project = {
    id: "00000000-0000-4000-8000-000000000003",
    name: "memorag-offline-sdk",
    reference_dataset_id: example.dataset_id,
    extra: { metadata: {} },
  };
  const client = {
    feedbackLogCalls: 0,
    async hasDataset() { return true; },
    async readDataset() {
      return { id: example.dataset_id, name: "memorag-eval" };
    },
    async *listExamples() { yield example; },
    async createExamples() { throw new Error("existing example must be reused"); },
    async createProject() { return project; },
    async getDatasetUrl() { return "https://smith.example/datasets/offline"; },
    async createRun() {},
    async updateRun() {},
    async updateProject() {},
    async awaitPendingTraceBatches() {},
    async logEvaluationFeedback({ evaluatorResponse }) {
      this.feedbackLogCalls += 1;
      if (Array.isArray(evaluatorResponse?.results)) {
        return evaluatorResponse.results;
      }
      return Array.isArray(evaluatorResponse)
        ? evaluatorResponse
        : [evaluatorResponse];
    },
    async *listProjects() { yield project; },
  };
  const judge = {
    _modelType() { return "base_chat_model"; },
    withStructuredOutput() {
      return {
        async invoke() {
          return { score: 0.85, reasoning: "offline mock" };
        },
      };
    },
  };
  const diagnostics = [];

  try {
    const result = await runRecordedEvaluation({
      sample,
      datasetName: "memorag-eval",
      execute: true,
      client,
      judge,
      judgeModelName: "offline-judge",
      metric: "rag_groundedness",
      resultsDirectory: directory,
      diagnosticLogger: (event) => diagnostics.push(event),
    });

    assert.equal(client.feedbackLogCalls, 1);
    assert.equal(result.feedback.length, 1);
    assert.equal(result.feedback[0].key, "rag_groundedness");
    assert.equal(result.feedback[0].score, 0.85);
    const events = diagnostics.map((event) => event.event);
    for (const expected of [
      "evaluation_configured",
      "evaluation_target_invoked",
      "evaluation_target_returned",
      "evaluation_evaluator_invoked",
      "evaluation_payload_validated",
      "evaluation_judge_started",
      "evaluation_judge_returned",
      "evaluation_openevals_returned",
      "evaluation_feedback_log_started",
      "evaluation_feedback_log_returned",
      "evaluation_evaluate_returned",
      "evaluation_results_ready",
      "evaluation_row_received",
      "evaluation_feedback_summary",
    ]) {
      assert.equal(events.includes(expected), true, `missing ${expected}`);
    }
    const ready = diagnostics.find(
      (event) => event.event === "evaluation_results_ready",
    );
    assert.equal(ready.source, "results_property");
    assert.equal(ready.rowCount, 1);
    assert.equal(ready.processedCount, 1);

    const feedbackError = new Error("private feedback response");
    feedbackError.name = "FeedbackWriteError";
    feedbackError.status = 503;
    feedbackError.code = "feedback_unavailable";
    const failingClient = {
      ...client,
      feedbackLogCalls: 0,
      async logEvaluationFeedback() {
        this.feedbackLogCalls += 1;
        throw feedbackError;
      },
    };
    const failureDiagnostics = [];
    await assert.rejects(
      runRecordedEvaluation({
        sample,
        datasetName: "memorag-eval",
        execute: true,
        client: failingClient,
        judge,
        judgeModelName: "offline-judge",
        metric: "rag_groundedness",
        resultsDirectory: directory,
        diagnosticLogger: (event) => failureDiagnostics.push(event),
      }),
      (error) => error instanceof EvaluationSampleError
        && /评估未完整返回有效指标/u.test(error.message),
    );
    assert.equal(failingClient.feedbackLogCalls, 1);
    assert.deepEqual(
      failureDiagnostics.find(
        (event) => event.event === "evaluation_feedback_log_failed",
      ),
      {
        event: "evaluation_feedback_log_failed",
        errorType: "FeedbackWriteError",
        httpStatus: 503,
        errorCode: "feedback_unavailable",
      },
    );
    assert.doesNotMatch(
      JSON.stringify(failureDiagnostics),
      /private feedback response/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
