import test from "node:test";
import assert from "node:assert/strict";
import { createEbookRag } from "../src/rag/ebook/index.js";

class ApiTestModel {
  constructor() {
    this.evaluations = ["retrieve", "generate"];
  }

  withStructuredOutput(schema) {
    const keys = Object.keys(schema.shape);
    if (keys.includes("mode")) {
      return { invoke: async () => ({ mode: "multi_hop", reason: "需要多跳查书" }) };
    }
    if (keys.includes("sub_questions")) {
      return {
        invoke: async () => ({
          sub_questions: [
            {
              question: "误杀阿朱的人是谁？",
              purpose: "确认中间人物",
              dependsOn: [],
              introducedAssumptions: [],
            },
            {
              question: "他后来经历了什么？",
              purpose: "回答后续经历",
              dependsOn: [1],
              introducedAssumptions: [],
            },
          ],
          reason: "依赖问题",
        }),
      };
    }
    if (keys.includes("needsRewrite")) {
      return {
        invoke: async () => ({
          needsRewrite: true,
          rewrittenQuery: "萧峰后来经历了什么？",
          resolvedEntities: ["萧峰"],
          supportingDocumentIds: ["doc-1"],
          hasConflictingEvidence: false,
          reason: "前序原文确认人物为萧峰",
        }),
      };
    }
    return {
      invoke: async () => ({
        ...(this.evaluations[0] === "generate"
          ? { isSufficient: true, missing: [] }
          : { isSufficient: false, missing: ["下一项必要事实"] }),
        nextAction: this.evaluations.shift(),
        nextPlanItemAddressesGap: true,
        reason: "测试评估",
      }),
    };
  }

  async invoke() {
    return { content: "最终回答 [本地1]" };
  }
}

class CitationCorrectionModel {
  constructor() {
    this.prompts = [];
    this.answers = [
      "人物甲在第十四章完成了任务 [本地15]。",
      "人物甲在第十四章完成了任务 [本地14]。",
    ];
  }

  withStructuredOutput(schema) {
    const keys = Object.keys(schema.shape);
    if (keys.includes("mode")) {
      return { invoke: async () => ({ mode: "single_retrieval", reason: "单跳查书" }) };
    }
    return {
      invoke: async () => ({
        isSufficient: true,
        nextAction: "generate",
        missing: [],
        nextPlanItemAddressesGap: false,
        reason: "资料充分",
      }),
    };
  }

  async invoke(prompt) {
    this.prompts.push(prompt);
    return { content: this.answers.shift() };
  }
}

class RerankApiModel {
  withStructuredOutput(schema) {
    const keys = Object.keys(schema.shape);
    if (keys.includes("mode")) {
      return { invoke: async () => ({ mode: "single_retrieval", reason: "单跳查书" }) };
    }
    return {
      invoke: async () => ({
        isSufficient: true,
        nextAction: "generate",
        missing: [],
        nextPlanItemAddressesGap: false,
        reason: "资料充分",
      }),
    };
  }

  async invoke() {
    return { content: "重排后的回答 [本地1]" };
  }
}

class RepeatedRetrievalModel {
  withStructuredOutput(schema) {
    const keys = Object.keys(schema.shape);
    if (keys.includes("mode")) {
      return { invoke: async () => ({ mode: "multi_hop", reason: "需要多跳查书" }) };
    }
    if (keys.includes("sub_questions")) {
      return {
        invoke: async () => ({
          sub_questions: Array.from({ length: 8 }, (_, index) => ({
            question: `子问题 ${index + 1}`,
            purpose: `必要事实 ${index + 1}`,
            dependsOn: [],
            introducedAssumptions: [],
          })),
          reason: "测试最大合法检索路径",
        }),
      };
    }
    if (keys.includes("needsRewrite")) {
      return {
        invoke: async () => ({
          needsRewrite: false,
          rewrittenQuery: "",
          resolvedEntities: [],
          supportingDocumentIds: [],
          hasConflictingEvidence: false,
          reason: "继续使用原查询",
        }),
      };
    }
    return {
      invoke: async () => ({
        isSufficient: false,
        nextAction: "retrieve",
        missing: ["证据始终不足"],
        nextPlanItemAddressesGap: true,
        reason: "继续请求检索直到达到有界上限",
      }),
    };
  }

  async invoke() {
    return { content: "达到检索上限后正常生成 [本地1]" };
  }
}

class SingleHopMetricsModel {
  withStructuredOutput(schema) {
    const keys = Object.keys(schema.shape);
    if (keys.includes("mode")) {
      return {
        invoke: async () => ({
          mode: "single_retrieval",
          reason: "一个完整检索问题即可回答",
        }),
      };
    }
    return {
      invoke: async () => ({
        isSufficient: true,
        nextAction: "generate",
        missing: [],
        nextPlanItemAddressesGap: false,
        reason: "首轮证据充分",
      }),
    };
  }

  async invoke() {
    return { content: "阿朱这样做是为了保护段正淳 [本地1]。" };
  }
}

function createTestConfig() {
  return {
    model: {
      apiKey: "test-key",
      baseUrl: undefined,
      chatModel: "test-chat",
      embeddingModel: "test-embedding",
      embeddingDimension: 2,
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
    },
    webSearch: {
      enabled: false,
      apiKey: "",
      url: "https://example.com",
      maxSearches: 2,
    },
  };
}

function createRepeatedRetrievalRag(rerankMode) {
  const config = createTestConfig();
  config.rag.maxRetrievals = 8;
  config.rag.maxSubQuestions = 8;
  config.rerank = rerankMode === "disabled"
    ? { enabled: false }
    : {
      enabled: true,
      apiKey: "test-key",
      url: "https://example.test/rerank",
      model: "qwen3-rerank",
      topN: 1,
      candidateK: 3,
      timeoutMs: 100,
      failureMode: "fallback",
    };
  const counters = { retrievals: 0, reranks: 0 };
  const rag = createEbookRag({
    config,
    model: new RepeatedRetrievalModel(),
    embeddings: {},
    milvusClient: {},
    retriever: {
      async search() {
        counters.retrievals += 1;
        return [{
          id: `doc-${counters.retrievals}`,
          score: 1 - (counters.retrievals * 0.01),
          bookId: "1",
          bookName: "天龙八部",
          chapterNum: counters.retrievals,
          chunkIndex: 0,
          content: `第 ${counters.retrievals} 条不足证据`,
        }];
      },
    },
    reranker: {
      async rerank() {
        counters.reranks += 1;
        if (rerankMode === "fallback") throw new Error("mock rerank failure");
        return [{ index: 0, score: 0.9, rank: 1 }];
      },
    },
  });
  return { counters, rag };
}

test("createEbookRag().ask() keeps its API and exposes rewrite trace", async () => {
  const queries = [];
  let rerankCalls = 0;
  const rag = createEbookRag({
    config: createTestConfig(),
    model: new ApiTestModel(),
    embeddings: {},
    milvusClient: {},
    retriever: {
      async search(query) {
        queries.push(query);
        return [{
          id: queries.length === 1 ? "doc-1" : "doc-2",
          score: 0.9,
          bookId: "1",
          bookName: "天龙八部",
          chapterNum: 1,
          chunkIndex: queries.length - 1,
          content: queries.length === 1
            ? "误杀阿朱的人是萧峰。"
            : "萧峰后来经历了聚贤庄大战。",
        }];
      },
    },
    reranker: {
      async rerank() { rerankCalls += 1; },
    },
  });

  const result = await rag.ask("误杀阿朱的人是谁？他后来经历了什么？");

  assert.equal(result.answer, "最终回答 [本地1]");
  assert.equal(result.route.strategy, "complex");
  assert.equal(result.route.mode, "multi_hop");
  assert.equal(result.sources.length, 2);
  assert.deepEqual(queries, ["误杀阿朱的人是谁？", "萧峰后来经历了什么？"]);
  assert.equal(result.trace.rewriteHistory[1].rewriteApplied, true);
  assert.equal(result.trace.retrievals[1].query, "萧峰后来经历了什么？");
  assert.equal(result.trace.retrievals[1].documentIds[0], "doc-2");
  assert.equal(rerankCalls, 0);
});

test("motivating question uses one retrieval and reports exact execution metrics", async () => {
  const queries = [];
  const rag = createEbookRag({
    config: createTestConfig(),
    model: new SingleHopMetricsModel(),
    embeddings: {},
    milvusClient: {},
    retriever: {
      async search(query) {
        queries.push(query);
        return [{
          id: "azhu-motive",
          score: 0.95,
          bookId: "1",
          bookName: "天龙八部",
          chapterNum: 41,
          chunkIndex: 2,
          content: "敏感正文哨兵：阿朱决定以自己代替段正淳赴约。",
        }];
      },
    },
  });

  const result = await rag.ask("阿朱为什么要假扮段正淳？");

  assert.deepEqual(queries, ["阿朱为什么要假扮段正淳？"]);
  assert.equal(result.route.strategy, "complex");
  assert.equal(result.route.mode, "single_retrieval");
  assert.deepEqual(result.trace.subQuestions, ["阿朱为什么要假扮段正淳？"]);
  assert.deepEqual(result.trace.rewriteHistory, []);
  assert.equal(result.trace.retrievalCount, 1);
  assert.equal(result.trace.execution.localRetrievalCount, 1);
  assert.equal(result.trace.execution.llmCallCount, 3);
  assert.deepEqual(result.trace.execution.llmCalls, {
    route: 1,
    decompose: 0,
    rewrite: 0,
    evaluate: 1,
    generate: 1,
    citationCorrection: 0,
  });
  assert.equal(
    Object.values(result.trace.execution.nodes)
      .reduce((total, node) => total + node.count, 0),
    5,
  );
  assert.ok(result.trace.execution.totalDurationMs >= 0);
  assert.equal(result.trace.execution.finalContextDocumentCount, 1);
  assert.doesNotMatch(
    JSON.stringify(result.trace.execution),
    /敏感正文哨兵|test-key/,
  );
});

test("createEbookRag corrects local reference 15 when only 14 sources exist", async () => {
  const config = createTestConfig();
  config.rag.maxContextDocuments = 14;
  const model = new CitationCorrectionModel();
  const rag = createEbookRag({
    config,
    model,
    embeddings: {},
    milvusClient: {},
    retriever: {
      async search() {
        return Array.from({ length: 14 }, (_, index) => ({
          id: `doc-${index + 1}`,
          score: 1 - (index * 0.01),
          bookId: "1",
          bookName: "天龙八部",
          chapterNum: index + 1,
          chunkIndex: 0,
          content: index === 13
            ? "第十四章原文：人物甲在这一章完成了任务。"
            : `第 ${index + 1} 条测试片段`,
        }));
      },
    },
  });

  const result = await rag.ask("测试十四条来源");

  assert.equal(result.sources.length, 14);
  assert.equal(result.sources[13].reference, "本地14");
  assert.equal(result.sources[13].id, "doc-14");
  assert.equal(result.answer, "人物甲在第十四章完成了任务 [本地14]。");
  assert.doesNotMatch(result.answer, /\[本地15\]/);
  assert.equal(model.prompts.length, 2);
  assert.match(model.prompts[1], /\[本地14\][\s\S]*人物甲在这一章完成了任务/);
  assert.equal(result.trace.citationValidation.status, "corrected");
  assert.equal(result.trace.citationValidation.localSourceCount, 14);
  assert.deepEqual(
    result.trace.citationValidation.initialInvalidReferences,
    ["[本地15]"],
  );
  assert.deepEqual(result.trace.citationValidation.finalInvalidReferences, []);
  assert.equal(result.trace.citationValidation.correctionAttempts, 1);
  assert.equal(result.trace.citationValidation.contentSupportChecked, false);
  assert.equal(result.trace.execution.llmCalls.citationCorrection, 1);
  assert.equal(result.trace.execution.llmCallCount, 4);
});

test("createEbookRag applies optional Rerank while preserving its response API", async () => {
  const config = createTestConfig();
  config.rerank = {
    enabled: true,
    apiKey: "test-key",
    url: "https://example.test/rerank",
    model: "qwen3-rerank",
    topN: 2,
    candidateK: 3,
    timeoutMs: 100,
    failureMode: "fallback",
  };
  const retrievalCalls = [];
  const rerankCalls = [];
  const rag = createEbookRag({
    config,
    model: new RerankApiModel(),
    embeddings: {},
    milvusClient: {},
    retriever: {
      async search(query, options) {
        retrievalCalls.push({ query, options });
        return [
          {
            id: "doc-a",
            score: 0.99,
            bookId: "1",
            bookName: "天龙八部",
            chapterNum: 1,
            chunkIndex: 0,
            content: "向量第一名",
          },
          {
            id: "doc-b",
            score: 0.70,
            bookId: "1",
            bookName: "天龙八部",
            chapterNum: 2,
            chunkIndex: 0,
            content: "重排第一名",
          },
        ];
      },
    },
    reranker: {
      async rerank(query, documents, options) {
        rerankCalls.push({ query, documents, options });
        return [{ index: 1, score: 0.96, rank: 1 }];
      },
    },
  });

  const result = await rag.ask("萧峰是谁？", { k: 1 });

  assert.deepEqual(retrievalCalls, [{
    query: "萧峰是谁？",
    options: { k: 3, bookId: "1" },
  }]);
  assert.equal(rerankCalls[0].query, "萧峰是谁？");
  assert.deepEqual(rerankCalls[0].options, { topN: 1 });
  assert.equal(result.answer, "重排后的回答 [本地1]");
  assert.equal(result.sources[0].id, "doc-b");
  assert.equal(result.sources[0].score, 0.70);
  assert.equal(result.sources[0].rerankScore, 0.96);
  assert.ok(Array.isArray(result.webSources));
  assert.equal(result.trace.retrievals[0].rerank.status, "success");
  assert.equal(result.trace.citationValidation.status, "valid");
  assert.doesNotMatch(JSON.stringify(result.trace), /向量第一名|重排第一名|test-key/);
});

test("createEbookRag passes the dynamically rewritten query to Rerank", async () => {
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
  const retrievalQueries = [];
  const rerankQueries = [];
  const rag = createEbookRag({
    config,
    model: new ApiTestModel(),
    embeddings: {},
    milvusClient: {},
    retriever: {
      async search(query) {
        retrievalQueries.push(query);
        return [{
          id: retrievalQueries.length === 1 ? "doc-1" : "doc-2",
          score: 0.9,
          bookId: "1",
          bookName: "天龙八部",
          chapterNum: 1,
          chunkIndex: retrievalQueries.length - 1,
          content: retrievalQueries.length === 1
            ? "误杀阿朱的人是萧峰。"
            : "萧峰后来经历了聚贤庄大战。",
        }];
      },
    },
    reranker: {
      async rerank(query) {
        rerankQueries.push(query);
        return [{ index: 0, score: 0.95, rank: 1 }];
      },
    },
  });

  const result = await rag.ask("误杀阿朱的人是谁？他后来经历了什么？");

  assert.deepEqual(retrievalQueries, ["误杀阿朱的人是谁？", "萧峰后来经历了什么？"]);
  assert.deepEqual(rerankQueries, retrievalQueries);
  assert.deepEqual(result.sources.map((source) => source.id), ["doc-1", "doc-2"]);
  assert.equal(result.trace.retrievals[1].query, "萧峰后来经历了什么？");
  assert.equal(result.trace.retrievals[1].rerank.status, "success");
});

test("maximum repeated retrieval path terminates when Rerank is disabled", async () => {
  const { counters, rag } = createRepeatedRetrievalRag("disabled");

  const result = await rag.ask("证据始终不足的测试问题");

  assert.equal(result.answer, "达到检索上限后正常生成 [本地1]");
  assert.equal(result.trace.retrievalCount, 8);
  assert.equal(result.trace.retrievals.length, 8);
  assert.equal(counters.retrievals, 8);
  assert.equal(counters.reranks, 0);
  assert.ok(result.trace.retrievals.every((retrieval) => retrieval.rerank === null));
  assert.equal(result.trace.execution.llmCallCount, 11);
  assert.equal(result.trace.execution.rerankRequestCount, 0);
});

test("maximum repeated retrieval path terminates after successful Rerank", async () => {
  const { counters, rag } = createRepeatedRetrievalRag("success");

  const result = await rag.ask("证据始终不足的测试问题");

  assert.equal(result.trace.retrievalCount, 8);
  assert.equal(counters.retrievals, 8);
  assert.equal(counters.reranks, 8);
  assert.equal(result.trace.execution.rerankRequestCount, 8);
  assert.equal(result.trace.execution.rerankFallbackCount, 0);
  assert.ok(result.trace.retrievals.every(
    (retrieval) => retrieval.rerank.status === "success",
  ));
});

test("maximum repeated retrieval path terminates after Rerank fallback", async () => {
  const { counters, rag } = createRepeatedRetrievalRag("fallback");

  const result = await rag.ask("证据始终不足的测试问题");

  assert.equal(result.trace.retrievalCount, 8);
  assert.equal(counters.retrievals, 8);
  assert.equal(counters.reranks, 8);
  assert.equal(result.trace.execution.rerankRequestCount, 8);
  assert.equal(result.trace.execution.rerankFallbackCount, 8);
  assert.ok(result.trace.retrievals.every(
    (retrieval) => retrieval.rerank.status === "fallback",
  ));
});
