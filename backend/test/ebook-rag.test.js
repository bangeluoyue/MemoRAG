import test from "node:test";
import assert from "node:assert/strict";
import { createEbookRag } from "../src/rag/ebook/index.js";
import { validateLocalCitations } from "../src/rag/ebook/agent-graph.js";
import {
  AgentInvocationTimeoutError,
  ModelInvocationTimeoutError,
  TIMEOUT_SOURCES,
} from "../src/rag/shared/timeouts.js";

function createTestConfig() {
  return {
    model: {
      apiKey: "test-key",
      baseUrl: undefined,
      chatModel: "test-chat",
      embeddingModel: "test-embedding",
      embeddingDimension: 2,
      requestTimeoutMs: 100,
      maxRetries: 0,
    },
    milvus: {
      address: "localhost:19530",
      token: undefined,
      collectionName: "ebook_collection",
      bookId: "1",
      nprobe: 8,
    },
    rag: {
      bookName: "天龙八部",
      retrievalK: 5,
      maxRetrievals: 4,
      maxContextDocuments: 8,
      maxSubQuestions: 4,
      maxPlanRepairAttempts: 1,
      maxSingleRetrievals: 2,
      maxGapRecoveryAttempts: 1,
      agentTimeoutMs: 500,
      decisionTimeoutMs: 50,
    },
    rerank: {
      enabled: false,
      topN: 5,
      candidateK: 20,
      failureMode: "fallback",
    },
    webSearch: {
      enabled: false,
      apiKey: "",
      url: "https://example.test/search",
      maxSearches: 1,
    },
    langsmith: {
      requested: false,
      enabled: false,
      noteTracingEnabled: false,
      contentMode: "metadata_only",
    },
  };
}

function planItem(question, options = {}) {
  return {
    question,
    purpose: options.purpose ?? "回答原问题的必要部分",
    dependsOn: options.dependsOn ?? [],
    introducedAssumptions: options.introducedAssumptions ?? [],
  };
}

class ScriptedModel {
  constructor({
    route = { mode: "single_retrieval", reason: "需要一次书库检索" },
    plan = [],
    decisions = [{ nextAction: "generate", reason: "已有资料" }],
    answers = ["根据资料可以确认 [本地1]。"],
  } = {}) {
    this.route = route;
    this.plan = plan;
    this.decisions = [...decisions];
    this.answers = [...answers];
    this.calls = { route: 0, decompose: 0, decision: 0, generate: 0 };
    this.prompts = [];
  }

  withStructuredOutput(schema) {
    const keys = Object.keys(schema.shape);
    if (keys.includes("mode")) {
      return { invoke: async () => {
        this.calls.route += 1;
        return this.route;
      } };
    }
    if (keys.includes("sub_questions")) {
      return { invoke: async () => {
        this.calls.decompose += 1;
        return { sub_questions: this.plan, reason: "必要的多跳计划" };
      } };
    }
    if (keys.includes("nextAction")) {
      return { invoke: async () => {
        this.calls.decision += 1;
        return this.decisions.shift()
          ?? { nextAction: "generate", reason: "Mock 决策用尽" };
      } };
    }
    throw new Error(`未知结构化 Schema：${keys.join(",")}`);
  }

  async invoke(prompt) {
    this.calls.generate += 1;
    this.prompts.push(prompt);
    return { content: this.answers.shift() ?? "无法根据资料确认。" };
  }
}

function bookDocument(id, content, options = {}) {
  return {
    id,
    score: options.score ?? 0.9,
    bookId: options.bookId ?? "1",
    bookName: "天龙八部",
    chapterNum: options.chapterNum ?? 1,
    chunkIndex: options.chunkIndex ?? 0,
    content,
  };
}

function createMockRag({ config = createTestConfig(), model, retriever, ...options }) {
  return createEbookRag({
    config,
    model,
    embeddings: {},
    milvusClient: {},
    retriever,
    ...options,
  });
}

test("default EPUB graph keeps direct questions outside retrieval", async () => {
  const model = new ScriptedModel({
    route: { mode: "direct", reason: "无需书中证据" },
    answers: ["你好，我可以帮助查询电子书内容。"],
  });
  let retrievals = 0;
  const rag = createMockRag({
    model,
    retriever: { async search() { retrievals += 1; return []; } },
  });

  const result = await rag.ask("你好");

  assert.equal(result.route.mode, "direct");
  assert.equal(result.answer, "你好，我可以帮助查询电子书内容。");
  assert.equal(retrievals, 0);
  assert.equal(model.calls.route, 1);
  assert.equal(model.calls.generate, 1);
  assert.equal(model.calls.decision, 0);
  assert.deepEqual(result.sources, []);
});

test("single-retrieval EPUB path uses one Milvus retrieval and actual sources", async () => {
  const queries = [];
  const model = new ScriptedModel({
    answers: ["阿朱以自己代替段正淳赴约 [本地1]。"],
  });
  const rag = createMockRag({
    model,
    retriever: {
      async search(query, options) {
        queries.push({ query, options });
        return [bookDocument("doc-1", "阿朱决定以自己代替段正淳赴约。")];
      },
    },
  });

  const result = await rag.ask("阿朱为什么要假扮段正淳？");

  assert.deepEqual(queries, [{
    query: "阿朱为什么要假扮段正淳？",
    options: { k: 5, bookId: "1" },
  }]);
  assert.equal(result.route.mode, "single_retrieval");
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].id, "doc-1");
  assert.equal(result.sources[0].reference, "本地1");
  assert.equal(result.trace.retrievals[0].status, "retrieved");
  assert.deepEqual(result.trace.coverage, []);
  assert.deepEqual(result.trace.rewriteHistory, []);
  assert.equal(result.trace.execution.llmCalls.evaluate, 0);
  assert.equal(result.trace.execution.llmCalls.rewrite, 0);
  assert.equal(result.trace.execution.llmCalls.decision, 1);
  assert.equal(result.trace.execution.llmCalls.generate, 1);
  assert.equal(result.trace.execution.localRetrievalCount, 1);
});

test("EPUB generation uses only the question and retrieved evidence, not routing reasons", async () => {
  const routeMarker = "UNVERIFIED_ROUTE_RELATION";
  const decisionMarker = "UNVERIFIED_DECISION_RELATION";
  const model = new ScriptedModel({
    route: { mode: "single_retrieval", reason: routeMarker },
    decisions: [{ nextAction: "generate", reason: decisionMarker }],
    answers: ["只能确认资料直接支持的关系 [本地1]。"],
  });
  const rag = createMockRag({
    model,
    retriever: {
      async search() {
        return [bookDocument("doc-evidence", "原文明确记载的人物与事件。")];
      },
    },
  });

  const result = await rag.ask("请根据原文核对人物关系");
  const generationPrompt = model.prompts.at(-1);

  assert.equal(result.route.reason, routeMarker);
  assert.equal(result.trace.evaluation.reason, decisionMarker);
  assert.equal(model.calls.generate, 1);
  assert.match(generationPrompt, /请根据原文核对人物关系/u);
  assert.match(generationPrompt, /原文明确记载的人物与事件/u);
  assert.doesNotMatch(generationPrompt, new RegExp(routeMarker, "u"));
  assert.doesNotMatch(generationPrompt, new RegExp(decisionMarker, "u"));
  assert.match(generationPrompt, /行为主体、行为对象和因果关系/u);
  assert.match(generationPrompt, /人物当时相信、听说、猜测或受骗后认为的内容/u);
  assert.match(generationPrompt, /流程决策、常识或模型记忆/u);
});

test("multi-hop EPUB path decomposes and performs bounded multiple retrievals", async () => {
  const queries = [];
  const model = new ScriptedModel({
    route: { mode: "multi_hop", reason: "包含两个独立事实" },
    plan: [
      planItem("误杀阿朱的人是谁？"),
      planItem("聚贤庄大战中发生了什么？"),
    ],
    decisions: [
      { nextAction: "retrieve", reason: "还需第二项" },
      { nextAction: "generate", reason: "计划内检索已完成" },
    ],
    answers: ["误杀阿朱的是萧峰 [本地1]，聚贤庄发生大战 [本地2]。"],
  });
  const rag = createMockRag({
    model,
    retriever: {
      async search(query) {
        queries.push(query);
        return [bookDocument(
          `doc-${queries.length}`,
          queries.length === 1 ? "萧峰误杀阿朱。" : "聚贤庄发生大战。",
          { chapterNum: queries.length },
        )];
      },
    },
  });

  const result = await rag.ask("误杀阿朱的人是谁？聚贤庄发生了什么？");

  assert.deepEqual(queries, ["误杀阿朱的人是谁？", "聚贤庄大战中发生了什么？"]);
  assert.equal(result.route.mode, "multi_hop");
  assert.equal(result.trace.retrievalCount, 2);
  assert.equal(result.sources.length, 2);
  assert.equal(model.calls.decompose, 1);
  assert.equal(model.calls.decision, 2);
  assert.equal(result.trace.execution.llmCalls.rewrite, 0);
  assert.equal(result.trace.execution.llmCalls.evaluate, 0);
});

test("dependent sub-questions never send an unconfirmed entity to retrieval", async () => {
  const original = "误杀阿朱的人是谁？这个人在聚贤庄经历了什么？";
  const queries = [];
  const model = new ScriptedModel({
    route: { mode: "multi_hop", reason: "第二部分依赖第一部分" },
    plan: [
      planItem("误杀阿朱的人是谁？"),
      // Even if a decomposer ignores the schema's dependency marker and fills
      // the entity from model memory, the original question still contains an
      // unresolved reference, so this later query must be rejected locally.
      planItem("萧峰在聚贤庄经历了什么？"),
    ],
    decisions: [
      { nextAction: "retrieve", reason: "继续安全查询" },
      { nextAction: "generate", reason: "预算内检索完成" },
    ],
    answers: ["现有资料只能确认第一部分 [本地1]，其余仍无法确认。"],
  });
  const rag = createMockRag({
    model,
    retriever: {
      async search(query) {
        queries.push(query);
        return [bookDocument(`doc-${queries.length}`, `查询 ${queries.length} 的资料`)];
      },
    },
  });

  const result = await rag.ask(original);

  assert.deepEqual(queries, ["误杀阿朱的人是谁？", original]);
  assert.equal(result.trace.planValidation.status, "dependency_safe_fallback");
  assert.doesNotMatch(queries.join("\n"), /萧峰/u);
  assert.doesNotMatch(queries.join("\n"), /第\s*1\s*项/u);
});

test("lightweight decision timeout falls back safely and remains bounded", async () => {
  class HangingDecisionModel extends ScriptedModel {
    withStructuredOutput(schema) {
      const keys = Object.keys(schema.shape);
      if (!keys.includes("nextAction")) return super.withStructuredOutput(schema);
      return {
        invoke: async (_prompt, { signal } = {}) => {
          this.calls.decision += 1;
          return new Promise((_, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
        },
      };
    }
  }

  const config = createTestConfig();
  config.rag.decisionTimeoutMs = 15;
  config.model.requestTimeoutMs = 100;
  const queries = [];
  const model = new HangingDecisionModel({
    route: { mode: "multi_hop", reason: "两项" },
    plan: [planItem("第一项？"), planItem("第二项？")],
    answers: ["根据两轮资料保守回答 [本地1]。"],
  });
  const rag = createMockRag({
    config,
    model,
    retriever: {
      async search(query) {
        queries.push(query);
        return [bookDocument(`doc-${queries.length}`, `第 ${queries.length} 轮资料`)];
      },
    },
  });

  const startedAt = Date.now();
  const result = await rag.ask("需要两轮的测试问题");

  assert.deepEqual(queries, ["第一项？", "第二项？"]);
  assert.equal(model.calls.decision, 2);
  assert.equal(result.trace.retrievalCount, 2);
  assert.equal(result.trace.evaluation.status, "safe_fallback");
  assert.equal(result.trace.evaluation.fallbackReason, "decision_timeout");
  assert.equal(result.trace.evaluation.decisionTimeoutMs, 15);
  assert.ok(Date.now() - startedAt < 200);
});

test("local and web budgets force termination even when the model keeps retrieving", async () => {
  const config = createTestConfig();
  config.rag.maxRetrievals = 2;
  const model = new ScriptedModel({
    route: { mode: "multi_hop", reason: "三项" },
    plan: [planItem("第一项？"), planItem("第二项？"), planItem("第三项？")],
    decisions: [
      { nextAction: "retrieve", reason: "继续" },
      { nextAction: "retrieve", reason: "仍想继续" },
    ],
    answers: ["达到预算后根据现有资料回答 [本地1]。"],
  });
  let retrievals = 0;
  const rag = createMockRag({
    config,
    model,
    retriever: {
      async search() {
        retrievals += 1;
        return [bookDocument(`doc-${retrievals}`, `资料 ${retrievals}`)];
      },
    },
  });

  const result = await rag.ask("持续要求检索的测试");

  assert.equal(retrievals, 2);
  assert.equal(result.trace.retrievalCount, 2);
  assert.equal(result.trace.evaluation.nextAction, "generate");
  assert.equal(
    result.trace.evaluation.fallbackReason,
    "local_retrieval_budget_exhausted",
  );
});

test("EPUB can use one bounded Bocha fallback and returns web sources", async () => {
  const config = createTestConfig();
  config.webSearch.enabled = true;
  const model = new ScriptedModel({
    decisions: [{
      nextAction: "web_search",
      reason: "本地无结果",
      web_query: "不含未确认人物的安全查询",
    }],
    answers: ["网页资料提供了补充信息 [网页1]。"],
  });
  const webQueries = [];
  const rag = createMockRag({
    config,
    model,
    retriever: { async search() { return []; } },
    webSearch: async (query) => {
      webQueries.push(query);
      return {
        text: "[网页1]\n摘要：公开资料",
        sources: [{ title: "公开来源", url: "https://example.test/source" }],
      };
    },
  });

  const result = await rag.ask("需要联网补充的问题");

  assert.deepEqual(webQueries, ["不含未确认人物的安全查询"]);
  assert.equal(result.trace.webSearchCount, 1);
  assert.equal(result.trace.execution.webSearchCount, 1);
  assert.equal(result.webSources.length, 1);
  assert.equal(result.webSources[0].reference, "网页1");
  assert.deepEqual(result.sources, []);
});

test("web failure terminates safely without inventing an answer", async () => {
  const config = createTestConfig();
  config.webSearch.enabled = true;
  const model = new ScriptedModel({
    decisions: [{ nextAction: "web_search", reason: "本地为空" }],
  });
  const rag = createMockRag({
    config,
    model,
    retriever: { async search() { return []; } },
    webSearch: async () => { throw new Error("private upstream detail"); },
  });

  const result = await rag.ask("无本地资料的问题");

  assert.match(result.answer, /无法根据现有资料确认/u);
  assert.equal(result.trace.webSearchCount, 1);
  assert.equal(result.trace.evaluation.fallbackReason, "web_search_error");
  assert.equal(model.calls.generate, 0);
  assert.deepEqual(result.sources, []);
  assert.deepEqual(result.webSources, []);
  assert.doesNotMatch(JSON.stringify(result), /private upstream detail/u);
});

test("empty retrieval without web skips answer generation", async () => {
  const model = new ScriptedModel({
    decisions: [{ nextAction: "generate", reason: "没有更多来源" }],
  });
  const rag = createMockRag({
    model,
    retriever: { async search() { return []; } },
  });

  const result = await rag.ask("资料库中不存在的问题");

  assert.match(result.answer, /没有检索到/u);
  assert.equal(model.calls.generate, 0);
  assert.equal(result.trace.execution.llmCalls.generate, 0);
  assert.deepEqual(result.sources, []);
});

test("optional EPUB Rerank remains compatible with the core graph", async () => {
  const config = createTestConfig();
  config.rerank = {
    enabled: true,
    apiKey: "test-key",
    url: "https://example.test/rerank",
    model: "qwen3-rerank",
    topN: 1,
    candidateK: 3,
    timeoutMs: 100,
    failureMode: "fallback",
  };
  const model = new ScriptedModel({ answers: ["重排结果 [本地1]。"] });
  let reranks = 0;
  const rag = createMockRag({
    config,
    model,
    retriever: {
      async search() {
        return [
          bookDocument("vector-first", "向量第一"),
          bookDocument("rerank-first", "重排第一", { score: 0.7 }),
        ];
      },
    },
    reranker: {
      async rerank() {
        reranks += 1;
        return [{ index: 1, score: 0.98, rank: 1 }];
      },
    },
  });

  const result = await rag.ask("需要重排的问题", { k: 1 });

  assert.equal(reranks, 1);
  assert.equal(result.sources[0].id, "rerank-first");
  assert.equal(result.trace.retrievals[0].rerank.status, "success");
  assert.equal(result.trace.execution.rerankRequestCount, 1);
});

test("citation validator rejects local reference 15 when 14 sources exist", () => {
  const result = validateLocalCitations("错误引用 [本地15]", 14);
  assert.equal(result.isValid, false);
  assert.deepEqual(result.invalidReferences, ["[本地15]"]);
});

test("core EPUB generation keeps bounded citation correction", async () => {
  const config = createTestConfig();
  config.rag.maxContextDocuments = 14;
  const model = new ScriptedModel({
    answers: ["错误编号 [本地15]。", "已纠正 [本地14]。"],
  });
  const rag = createMockRag({
    config,
    model,
    retriever: {
      async search() {
        return Array.from({ length: 14 }, (_, index) => bookDocument(
          `doc-${index + 1}`,
          `片段 ${index + 1}`,
          { score: 1 - (index * 0.01) },
        ));
      },
    },
  });

  const result = await rag.ask("十四条资料测试");

  assert.equal(result.sources.length, 14);
  assert.equal(result.answer, "已纠正 [本地14]。");
  assert.equal(result.trace.citationValidation.status, "corrected");
  assert.equal(result.trace.execution.llmCalls.citationCorrection, 1);
});

test("route and generation preserve safe third-party timeout classification", async () => {
  class ThirdPartyTimeoutModel extends ScriptedModel {
    constructor(stage) {
      super();
      this.stage = stage;
    }

    timeout() {
      const error = new Error("sensitive upstream response");
      error.name = "TimeoutError";
      throw error;
    }

    withStructuredOutput(schema) {
      const runnable = super.withStructuredOutput(schema);
      if (Object.keys(schema.shape).includes("mode") && this.stage === "route") {
        return { invoke: async () => this.timeout() };
      }
      return runnable;
    }

    async invoke(prompt) {
      if (this.stage === "generate") this.timeout();
      return super.invoke(prompt);
    }
  }

  for (const stage of ["route", "generate"]) {
    const rag = createMockRag({
      model: new ThirdPartyTimeoutModel(stage),
      retriever: {
        async search() { return [bookDocument("timeout-doc", "Mock 资料")]; },
      },
    });
    await assert.rejects(
      () => rag.ask("第三方超时"),
      (error) => error instanceof ModelInvocationTimeoutError
        && error.stage === stage
        && error.timeoutSource === TIMEOUT_SOURCES.SDK_OR_UPSTREAM
        && !error.message.includes("sensitive"),
    );
  }
});

test("whole request timeout still bounds the core graph", async () => {
  class SlowRouteModel extends ScriptedModel {
    withStructuredOutput(schema) {
      if (!Object.keys(schema.shape).includes("mode")) {
        return super.withStructuredOutput(schema);
      }
      return {
        invoke: async (_prompt, { signal } = {}) => new Promise((resolve) => {
          this.signal = signal;
          setTimeout(() => resolve({ mode: "direct", reason: "慢调用" }), 50);
        }),
      };
    }
  }
  const config = createTestConfig();
  config.rag.agentTimeoutMs = 15;
  const model = new SlowRouteModel();
  const rag = createMockRag({
    config,
    model,
    retriever: { async search() { return []; } },
  });

  await assert.rejects(
    () => rag.ask("总时限测试"),
    (error) => error instanceof AgentInvocationTimeoutError
      && error.stage === "agent"
      && error.timeoutSource === TIMEOUT_SOURCES.APPLICATION,
  );
  assert.equal(model.signal?.aborted, true);
});
