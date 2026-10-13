import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCompactLocalContext,
  calculateAgenticRagRecursionLimit,
  createAgenticRagGraph,
  createInitialState,
  mergeUniqueDocuments,
  validateQuestionPlan,
} from "../src/rag/ebook/agent-graph.js";

class ScriptedModel {
  constructor({
    mode = "multi_hop",
    strategy = null,
    subQuestions = ["萧峰是谁？"],
    dependencies = [],
    planResults = null,
    rewriteResults = [],
    evaluationActions = ["generate"],
    answer = "这是测试回答 [本地1]",
    answers = null,
  } = {}) {
    this.mode = strategy === "simple" ? "direct" : mode;
    this.planResults = planResults ? [...planResults] : [{
      sub_questions: subQuestions.map((question, index) => ({
        question,
        purpose: `回答原问题所需的第 ${index + 1} 项事实`,
        dependsOn: dependencies[index] ?? [],
        introducedAssumptions: [],
      })),
      reason: "测试拆分",
    }];
    this.rewriteResults = [...rewriteResults];
    this.evaluationActions = [...evaluationActions];
    this.answer = answer;
    this.answers = answers ? [...answers] : null;
    this.rewritePrompts = [];
    this.evaluationPrompts = [];
    this.invokePrompts = [];
    this.structuredCallCounts = {
      route: 0,
      decompose: 0,
      rewrite: 0,
      evaluate: 0,
    };
  }

  withStructuredOutput(schema) {
    const keys = Object.keys(schema.shape);
    if (keys.includes("mode")) {
      return {
        invoke: async () => {
          this.structuredCallCounts.route += 1;
          return { mode: this.mode, reason: "测试路由" };
        },
      };
    }
    if (keys.includes("sub_questions")) {
      return {
        invoke: async () => {
          this.structuredCallCounts.decompose += 1;
          const result = this.planResults.shift();
          if (result instanceof Error) throw result;
          return result;
        },
      };
    }
    if (keys.includes("needsRewrite")) {
      return {
        invoke: async (prompt) => {
          this.structuredCallCounts.rewrite += 1;
          this.rewritePrompts.push(prompt);
          const result = this.rewriteResults.shift();
          if (result instanceof Error) throw result;
          return result;
        },
      };
    }

    return {
      invoke: async (prompt) => {
        this.structuredCallCounts.evaluate += 1;
        this.evaluationPrompts.push(prompt);
        const action = this.evaluationActions.shift() ?? "generate";
        return typeof action === "string"
          ? {
              isSufficient: action === "generate",
              nextAction: action,
              missing: action === "generate" ? [] : ["测试缺失信息"],
              nextPlanItemAddressesGap: action === "retrieve",
              reason: "测试评估",
              ...(action === "web_search" ? { web_query: "测试联网查询" } : {}),
            }
          : action;
      },
    };
  }

  async invoke(prompt) {
    this.invokePrompts.push(prompt);
    return {
      content: this.answers?.length ? this.answers.shift() : this.answer,
    };
  }
}

function document(id, content, score = 0.9) {
  return {
    id,
    score,
    bookId: "1",
    bookName: "天龙八部",
    chapterNum: 1,
    chunkIndex: 0,
    content,
  };
}

function planItem(question, {
  purpose = "回答原问题所需事实",
  dependsOn = [],
  introducedAssumptions = [],
} = {}) {
  return { question, purpose, dependsOn, introducedAssumptions };
}

function initialState(question = "测试问题") {
  return createInitialState(question, {
    bookId: "1",
    k: 5,
    maxRetrievals: 8,
  });
}

test("scenario A: dependent sub-question uses the rewritten query", async () => {
  const queries = [];
  const model = new ScriptedModel({
    subQuestions: ["误杀阿朱的人是谁？", "他后来经历了什么？"],
    dependencies: [[], [1]],
    rewriteResults: [{
      needsRewrite: true,
      rewrittenQuery: "萧峰后来经历了什么？",
      resolvedEntities: ["萧峰"],
      supportingDocumentIds: ["doc-q1"],
      hasConflictingEvidence: false,
      reason: "前序证据确认误杀阿朱的人是萧峰",
    }],
    evaluationActions: ["retrieve", "generate"],
  });
  const graph = createAgenticRagGraph({
    model,
    retriever: {
      async search(query) {
        queries.push(query);
        return query === "误杀阿朱的人是谁？"
          ? [document("doc-q1", "原文明确写道，误杀阿朱的人是萧峰。")]
          : [document("doc-q2", "萧峰后来经历了聚贤庄大战。")];
      },
    },
    bookName: "天龙八部",
  });

  const result = await graph.invoke(initialState("误杀阿朱的人是谁？他后来经历了什么？"));

  assert.deepEqual(queries, ["误杀阿朱的人是谁？", "萧峰后来经历了什么？"]);
  assert.equal(result.rewriteHistory[1].rewriteApplied, true);
  assert.equal(result.rewriteHistory[1].rewrittenQuery, "萧峰后来经历了什么？");
  assert.equal(result.retrievalHistory[1].query, "萧峰后来经历了什么？");
  assert.match(model.rewritePrompts[0], /doc-q1/);
  assert.doesNotMatch(model.rewritePrompts[0], /萧峰后来经历了聚贤庄大战/);
});

test("scenario B: independent sub-questions keep their original queries", async () => {
  const queries = [];
  const model = new ScriptedModel({
    subQuestions: ["阿朱是谁？", "段誉是谁？"],
    rewriteResults: [{
      needsRewrite: false,
      rewrittenQuery: "段誉是谁？",
      resolvedEntities: [],
      supportingDocumentIds: [],
      hasConflictingEvidence: false,
      reason: "两个子问题互不依赖",
    }],
    evaluationActions: ["retrieve", "generate"],
  });
  const graph = createAgenticRagGraph({
    model,
    retriever: {
      async search(query) {
        queries.push(query);
        return [document(`doc-${queries.length}`, `${query}的相关原文`)];
      },
    },
    bookName: "天龙八部",
  });

  const result = await graph.invoke(initialState("阿朱是谁？段誉是谁？"));

  assert.deepEqual(queries, ["阿朱是谁？", "段誉是谁？"]);
  assert.equal(result.rewriteHistory[1].rewriteApplied, false);
  assert.equal(result.rewriteHistory[1].status, "skipped_independent");
  assert.equal(model.rewritePrompts.length, 0);
});

test("scenario C: missing prior evidence cannot produce an invented entity", async () => {
  const queries = [];
  const model = new ScriptedModel({
    subQuestions: ["某位身份无法确定的人物是谁？", "他后来去了哪里？"],
    dependencies: [[], [1]],
    rewriteResults: [new Error("rewriter should not run without evidence")],
    evaluationActions: ["retrieve", "generate"],
  });
  const graph = createAgenticRagGraph({
    model,
    retriever: {
      async search(query) {
        queries.push(query);
        return [];
      },
    },
    bookName: "天龙八部",
  });

  const result = await graph.invoke(initialState());

  assert.deepEqual(queries, ["某位身份无法确定的人物是谁？", "他后来去了哪里？"]);
  assert.equal(model.rewritePrompts.length, 0);
  assert.equal(result.rewriteHistory[1].status, "skipped_missing_dependency_evidence");
});

test("scenario D: Q3 can use Q1 and Q2 evidence but never future evidence", async () => {
  const queries = [];
  const model = new ScriptedModel({
    subQuestions: ["误杀阿朱的人是谁？", "他的父亲是谁？", "他后来去了哪里？"],
    dependencies: [[], [1], [1, 2]],
    rewriteResults: [
      {
        needsRewrite: true,
        rewrittenQuery: "萧峰的父亲是谁？",
        resolvedEntities: ["萧峰"],
        supportingDocumentIds: ["doc-q1"],
        hasConflictingEvidence: false,
        reason: "Q1 证据确认人物是萧峰",
      },
      {
        needsRewrite: true,
        rewrittenQuery: "萧远山后来去了哪里？",
        resolvedEntities: ["萧远山"],
        supportingDocumentIds: ["doc-q2"],
        hasConflictingEvidence: false,
        reason: "Q2 证据确认萧峰的父亲是萧远山",
      },
    ],
    evaluationActions: ["retrieve", "retrieve", "generate"],
  });
  const graph = createAgenticRagGraph({
    model,
    retriever: {
      async search(query) {
        queries.push(query);
        if (queries.length === 1) return [document("doc-q1", "误杀阿朱的人是萧峰。")];
        if (queries.length === 2) return [document("doc-q2", "萧峰的父亲是萧远山。")];
        return [document("doc-q3", "未来证据：萧远山后来去了少林寺。")];
      },
    },
    bookName: "天龙八部",
  });

  const result = await graph.invoke(initialState());

  assert.deepEqual(queries, [
    "误杀阿朱的人是谁？",
    "萧峰的父亲是谁？",
    "萧远山后来去了哪里？",
  ]);
  assert.doesNotMatch(model.rewritePrompts[0], /doc-q2|未来证据/);
  assert.match(model.rewritePrompts[1], /doc-q1/);
  assert.match(model.rewritePrompts[1], /doc-q2/);
  assert.doesNotMatch(model.rewritePrompts[1], /未来证据/);
  assert.equal(result.rewriteHistory[2].rewriteApplied, true);
});

test("scenario E: rewrite model errors fall back to the original query", async () => {
  const queries = [];
  const model = new ScriptedModel({
    subQuestions: ["误杀阿朱的人是谁？", "他后来经历了什么？"],
    dependencies: [[], [1]],
    rewriteResults: [new Error("mock timeout")],
    evaluationActions: ["retrieve", "generate"],
  });
  const graph = createAgenticRagGraph({
    model,
    retriever: {
      async search(query) {
        queries.push(query);
        return [document("doc-q1", "误杀阿朱的人是萧峰。")];
      },
    },
    bookName: "天龙八部",
  });

  const result = await graph.invoke(initialState());

  assert.deepEqual(queries, ["误杀阿朱的人是谁？", "他后来经历了什么？"]);
  assert.equal(result.rewriteHistory[1].status, "fallback_model_error");
  assert.match(result.rewriteHistory[1].reason, /回退/);
});

test("scenario E: ungrounded rewrite output is rejected", async () => {
  const queries = [];
  const model = new ScriptedModel({
    subQuestions: ["误杀阿朱的人是谁？", "他后来经历了什么？"],
    dependencies: [[], [1]],
    rewriteResults: [{
      needsRewrite: true,
      rewrittenQuery: "慕容复后来经历了什么？",
      resolvedEntities: ["慕容复"],
      supportingDocumentIds: ["doc-q1"],
      hasConflictingEvidence: false,
      reason: "无依据的错误改写",
    }],
    evaluationActions: ["retrieve", "generate"],
  });
  const graph = createAgenticRagGraph({
    model,
    retriever: {
      async search(query) {
        queries.push(query);
        return [document("doc-q1", "误杀阿朱的人是萧峰。")];
      },
    },
    bookName: "天龙八部",
  });

  const result = await graph.invoke(initialState());

  assert.equal(queries[1], "他后来经历了什么？");
  assert.equal(result.rewriteHistory[1].status, "fallback_invalid_rewrite");
});

test("conflicting prior evidence forces the original query fallback", async () => {
  const queries = [];
  const model = new ScriptedModel({
    subQuestions: ["关键人物是谁？", "他后来经历了什么？"],
    dependencies: [[], [1]],
    rewriteResults: [{
      needsRewrite: true,
      rewrittenQuery: "萧峰后来经历了什么？",
      resolvedEntities: ["萧峰"],
      supportingDocumentIds: ["candidate-1"],
      hasConflictingEvidence: true,
      reason: "前序结果同时出现多个候选人物",
    }],
    evaluationActions: ["retrieve", "generate"],
  });
  const graph = createAgenticRagGraph({
    model,
    retriever: {
      async search(query) {
        queries.push(query);
        return [
          document("candidate-1", "候选人物是萧峰。", 0.9),
          document("candidate-2", "候选人物是段誉。", 0.89),
        ];
      },
    },
    bookName: "天龙八部",
  });

  const result = await graph.invoke(initialState());

  assert.equal(queries[1], "他后来经历了什么？");
  assert.equal(result.rewriteHistory[1].status, "fallback_invalid_rewrite");
  assert.match(result.rewriteHistory[1].reason, /冲突/);
});

test("scenario F: simple questions still bypass retrieval", async () => {
  const graph = createAgenticRagGraph({
    model: new ScriptedModel({ strategy: "simple" }),
    retriever: { async search() { throw new Error("should not run"); } },
    bookName: "天龙八部",
  });

  const result = await graph.invoke(initialState("你好"));

  assert.equal(result.strategy, "simple");
  assert.equal(result.retrievalCount, 0);
  assert.deepEqual(result.rewriteHistory, []);
  assert.equal(result.execution.llmCalls.route, 1);
  assert.equal(result.execution.llmCalls.generate, 1);
  assert.equal(result.execution.localRetrievalCount, 0);
});

test("single retrieval handles the motivating question without decomposition or rewrite", async () => {
  const queries = [];
  const model = new ScriptedModel({
    mode: "single_retrieval",
    answer: "阿朱这样做是为了保护段正淳 [本地1]。",
  });
  const graph = createAgenticRagGraph({
    model,
    retriever: {
      async search(query) {
        queries.push(query);
        return [document("azhu", "阿朱决定假扮段正淳以保护他。")];
      },
    },
    bookName: "天龙八部",
  });

  const result = await graph.invoke(initialState("阿朱为什么要假扮段正淳？"));

  assert.deepEqual(queries, ["阿朱为什么要假扮段正淳？"]);
  assert.equal(result.routeMode, "single_retrieval");
  assert.equal(model.structuredCallCounts.decompose, 0);
  assert.equal(model.structuredCallCounts.rewrite, 0);
  assert.equal(result.execution.llmCalls.route, 1);
  assert.equal(result.execution.llmCalls.evaluate, 1);
  assert.equal(result.execution.llmCalls.generate, 1);
  assert.equal(result.execution.localRetrievalCount, 1);
});

test("single retrieval allows only one deterministic supplemental local query", async () => {
  const queries = [];
  const model = new ScriptedModel({
    mode: "single_retrieval",
    evaluationActions: ["retrieve", "retrieve", "generate"],
  });
  const graph = createAgenticRagGraph({
    model,
    retriever: {
      async search(query) {
        queries.push(query);
        return [document(`single-${queries.length}`, `证据 ${queries.length}`)];
      },
    },
    bookName: "天龙八部",
    maxSingleRetrievals: 2,
  });

  const result = await graph.invoke(initialState("阿朱为什么要假扮段正淳？"));

  assert.equal(queries.length, 2);
  assert.equal(queries[0], "阿朱为什么要假扮段正淳？");
  assert.match(queries[1], /^阿朱为什么要假扮段正淳？ 补充检索重点：/);
  assert.equal(model.structuredCallCounts.decompose, 0);
  assert.equal(model.structuredCallCounts.rewrite, 0);
  assert.equal(result.evaluation.nextAction, "generate");
  assert.equal(result.retrievalCount, 2);
});

test("single retrieval may use bounded web fallback after local evidence is insufficient", async () => {
  let webCalls = 0;
  const model = new ScriptedModel({
    mode: "single_retrieval",
    evaluationActions: ["web_search", "web_search"],
  });
  const graph = createAgenticRagGraph({
    model,
    retriever: { async search() { return []; } },
    bookName: "天龙八部",
    webSearch: async () => {
      webCalls += 1;
      return { text: "联网补充仍不足", sources: [] };
    },
    maxWebSearches: 1,
  });

  const result = await graph.invoke(initialState("小说改编信息是什么？"));

  assert.equal(result.retrievalCount, 1);
  assert.equal(webCalls, 1);
  assert.equal(result.webSearchCount, 1);
  assert.equal(result.evaluation.nextAction, "generate");
});

test("question plan validation rejects excessive, duplicate, future-dependent and assumed items", () => {
  assert.equal(validateQuestionPlan(
    Array.from({ length: 5 }, (_, index) => planItem(`问题 ${index + 1}`)),
    4,
  ).valid, false);
  assert.equal(validateQuestionPlan([
    planItem("重复问题？"),
    planItem("重复问题？"),
  ], 4).valid, false);
  assert.equal(validateQuestionPlan([
    planItem("第一项？", { dependsOn: [2] }),
    planItem("第二项？"),
  ], 4).valid, false);
  assert.equal(validateQuestionPlan([
    planItem("带前提的问题？", { introducedAssumptions: ["某人已经死亡"] }),
  ], 4).valid, false);
});

test("invalid multi-hop plan is repaired once before execution", async () => {
  const invalidPlan = {
    sub_questions: Array.from({ length: 5 }, (_, index) => planItem(`冗余问题 ${index + 1}`)),
    reason: "过度拆题",
  };
  const repairedPlan = {
    sub_questions: [
      planItem("先确认人物是谁？"),
      planItem("第 1 项人物后来去了哪里？", { dependsOn: [1] }),
    ],
    reason: "修复后的必要两跳",
  };
  const model = new ScriptedModel({
    planResults: [invalidPlan, repairedPlan],
    evaluationActions: [{
      isSufficient: true,
      nextAction: "retrieve",
      missing: ["无需继续"],
      nextPlanItemAddressesGap: true,
      reason: "第一轮已经充分",
    }],
  });
  const graph = createAgenticRagGraph({
    model,
    retriever: { async search() { return [document("enough", "资料已经充分")]; } },
    bookName: "天龙八部",
  });

  const result = await graph.invoke(initialState("一个真正的两跳问题"));

  assert.equal(result.planValidation.status, "repaired");
  assert.equal(result.planValidation.repairAttempts, 1);
  assert.equal(model.structuredCallCounts.decompose, 2);
  assert.equal(result.retrievalCount, 1);
  assert.equal(result.execution.llmCalls.decompose, 2);
});

test("plan repair failure falls back to the original question without a third plan call", async () => {
  const invalid = {
    sub_questions: [
      planItem("重复问题？"),
      planItem("重复问题？"),
    ],
    reason: "重复计划",
  };
  const model = new ScriptedModel({
    planResults: [invalid, invalid],
  });
  const queries = [];
  const graph = createAgenticRagGraph({
    model,
    retriever: {
      async search(query) {
        queries.push(query);
        return [document("fallback", "回退证据")];
      },
    },
    bookName: "天龙八部",
  });

  const result = await graph.invoke(initialState("原始复杂问题？"));

  assert.equal(result.planValidation.status, "fallback_single");
  assert.equal(result.planValidation.repairAttempts, 1);
  assert.equal(model.structuredCallCounts.decompose, 2);
  assert.deepEqual(queries, ["原始复杂问题？"]);
  assert.deepEqual(result.subQuestions, ["原始复杂问题？"]);
});

test("sufficient evidence stops a multi-hop plan before remaining retrievals", async () => {
  let retrievalCalls = 0;
  const model = new ScriptedModel({
    subQuestions: ["必要事实一？", "必要事实二？", "必要事实三？"],
    evaluationActions: [{
      isSufficient: true,
      nextAction: "retrieve",
      missing: ["模型错误地要求继续"],
      nextPlanItemAddressesGap: true,
      reason: "资料实际已经充分",
    }],
  });
  const graph = createAgenticRagGraph({
    model,
    retriever: {
      async search() {
        retrievalCalls += 1;
        return [document("early-stop", "足以回答原始问题的资料")];
      },
    },
    bookName: "天龙八部",
  });

  const result = await graph.invoke(initialState("需要判断是否提前结束的问题"));

  assert.equal(retrievalCalls, 1);
  assert.equal(result.evaluation.nextAction, "generate");
  assert.equal(result.nextSubIdx, 1);
});

test("dependent rewrite that loses interrogative intent is rejected", async () => {
  const queries = [];
  const model = new ScriptedModel({
    subQuestions: ["关键人物是谁？", "他为什么离开大理？"],
    dependencies: [[], [1]],
    rewriteResults: [{
      needsRewrite: true,
      rewrittenQuery: "萧峰离开了大理",
      resolvedEntities: ["萧峰"],
      supportingDocumentIds: ["identity"],
      hasConflictingEvidence: false,
      reason: "错误地改成事实断言",
    }],
    evaluationActions: ["retrieve", "generate"],
  });
  const graph = createAgenticRagGraph({
    model,
    retriever: {
      async search(query) {
        queries.push(query);
        return [document("identity", "关键人物是萧峰。")];
      },
    },
    bookName: "天龙八部",
  });

  const result = await graph.invoke(initialState("关键人物是谁，他为什么离开大理？"));

  assert.equal(queries[1], "他为什么离开大理？");
  assert.equal(result.rewriteHistory[1].status, "fallback_invalid_rewrite");
  assert.match(result.rewriteHistory[1].reason, /疑问意图/);
});

test("evaluation context is capped at six documents and 600 characters each", async () => {
  const longContent = `${"甲".repeat(600)}不应进入评估提示`;
  const model = new ScriptedModel({ mode: "single_retrieval" });
  const graph = createAgenticRagGraph({
    model,
    retriever: {
      async search() {
        return Array.from({ length: 14 }, (_, index) => (
          document(`compact-${index + 1}`, longContent, 1 - index * 0.01)
        ));
      },
    },
    bookName: "天龙八部",
    maxContextDocuments: 12,
  });

  const result = await graph.invoke(initialState("紧凑上下文测试"));
  const evaluationPrompt = model.evaluationPrompts[0];

  assert.equal(result.documents.length, 12);
  assert.match(evaluationPrompt, /文档ID：compact-6/);
  assert.doesNotMatch(evaluationPrompt, /文档ID：compact-7/);
  assert.doesNotMatch(evaluationPrompt, /不应进入评估提示/);
  assert.equal(buildCompactLocalContext(result.documents).match(/文档ID：/g).length, 6);
});

test("scenario F: maximum retrieval count still terminates the graph", async () => {
  const queries = [];
  const model = new ScriptedModel({
    subQuestions: ["问题一？", "问题二？"],
    evaluationActions: ["retrieve"],
  });
  const graph = createAgenticRagGraph({
    model,
    retriever: {
      async search(query) {
        queries.push(query);
        return [document("doc-limit", "第一轮证据")];
      },
    },
    bookName: "天龙八部",
  });
  const state = createInitialState("测试检索上限", {
    bookId: "1",
    k: 5,
    maxRetrievals: 1,
  });

  const result = await graph.invoke(state);

  assert.deepEqual(queries, ["问题一？"]);
  assert.equal(result.retrievalCount, 1);
  assert.equal(result.evaluation.nextAction, "generate");
});

test("scenario F: web search, generation and web sources still work", async () => {
  let webCalls = 0;
  const model = new ScriptedModel({
    subQuestions: ["电视剧中对应哪几集？"],
    evaluationActions: ["web_search", "web_search"],
  });
  const graph = createAgenticRagGraph({
    model,
    retriever: { async search() { return [document("doc-local", "小说本地证据")]; } },
    bookName: "天龙八部",
    webSearch: async () => {
      webCalls += 1;
      return {
        text: "[网页1] 测试网页摘要",
        sources: [{ title: "测试网页", url: "https://example.com" }],
      };
    },
    maxWebSearches: 1,
  });

  const result = await graph.invoke(initialState());

  assert.equal(webCalls, 1);
  assert.equal(result.webSearchCount, 1);
  assert.equal(result.webSources[0].url, "https://example.com");
  assert.match(result.generation, /本地1/);
});

test("maximum legal retrieval and web path terminates with the derived limit", async () => {
  const subQuestions = Array.from({ length: 8 }, (_, index) => `子问题 ${index + 1}`);
  const keepOriginal = () => ({
    needsRewrite: false,
    rewrittenQuery: "",
    resolvedEntities: [],
    supportingDocumentIds: [],
    hasConflictingEvidence: false,
    reason: "证据始终不足，保留原查询",
  });
  const model = new ScriptedModel({
    subQuestions,
    rewriteResults: Array.from({ length: 7 }, keepOriginal),
    evaluationActions: [
      ...Array.from({ length: 7 }, () => "retrieve"),
      "web_search",
      "web_search",
      "web_search",
    ],
    answer: "达到所有循环上限后生成回答 [本地1]",
  });
  let retrievalCalls = 0;
  let webCalls = 0;
  const graph = createAgenticRagGraph({
    model,
    retriever: {
      async search() {
        retrievalCalls += 1;
        return [document(`doc-${retrievalCalls}`, `不足的证据 ${retrievalCalls}`)];
      },
    },
    bookName: "天龙八部",
    webSearch: async () => {
      webCalls += 1;
      return { text: "联网证据仍不足", sources: [] };
    },
    maxWebSearches: 2,
    maxSubQuestions: 8,
  });
  const recursionLimit = calculateAgenticRagRecursionLimit({
    maxRetrievals: 8,
    maxWebSearches: 2,
  });
  const nodeSequence = [];
  const retrievalProgress = [];
  const webProgress = [];

  for await (const update of await graph.stream(initialState(), {
    streamMode: "updates",
    recursionLimit,
  })) {
    const [nodeName] = Object.keys(update);
    nodeSequence.push(nodeName);
    if (update.retrieve) {
      retrievalProgress.push([
        update.retrieve.retrievalCount,
        update.retrieve.nextSubIdx,
      ]);
    }
    if (update.webSearch) webProgress.push(update.webSearch.webSearchCount);
  }

  const expectedSequence = ["routeQuestion", "decomposeQuestion"];
  for (let index = 0; index < 8; index += 1) {
    expectedSequence.push("rewriteSubQuestion", "retrieve", "evaluate");
  }
  expectedSequence.push("webSearch", "evaluate", "webSearch", "evaluate", "generate");

  assert.equal(recursionLimit, 32);
  assert.deepEqual(nodeSequence, expectedSequence);
  assert.deepEqual(
    retrievalProgress,
    Array.from({ length: 8 }, (_, index) => [index + 1, index + 1]),
  );
  assert.deepEqual(webProgress, [1, 2]);
  assert.equal(retrievalCalls, 8);
  assert.equal(webCalls, 2);
});

test("mergeUniqueDocuments keeps the best score and applies the limit", () => {
  const documents = mergeUniqueDocuments(
    [{ id: "a", score: 0.4 }, { id: "b", score: 0.8 }],
    [{ id: "a", score: 0.9 }, { id: "c", score: 0.7 }],
    2,
  );

  assert.deepEqual(documents.map((item) => item.id), ["a", "b"]);
});

test("mergeUniqueDocuments uses reciprocal rank fusion across reranked rounds", () => {
  const documents = mergeUniqueDocuments(
    [
      { id: "a", score: 0.99, rankFusionScore: 1 / 61, rankFusionFirstSeen: 0 },
      { id: "b", score: 0.40, rankFusionScore: 1 / 62, rankFusionFirstSeen: 1 },
    ],
    [
      { id: "b", score: 0.10, rankFusionScore: 1 / 61 },
      { id: "c", score: 1.00, rankFusionScore: 1 / 62 },
    ],
    3,
  );

  assert.deepEqual(documents.map((item) => item.id), ["b", "a", "c"]);
  assert.equal(documents[0].score, 0.40);
  assert.ok(documents[0].rankFusionScore > documents[1].rankFusionScore);
});

test("citation snapshot preserves valid references after dedupe, sorting and trimming", async () => {
  const model = new ScriptedModel({
    answer: "高分片段见 [本地1]，次高分片段见 [本地2]。",
  });
  const graph = createAgenticRagGraph({
    model,
    retriever: {
      async search() {
        return [
          document("a", "A 的旧片段", 0.4),
          document("b", "B 的片段", 0.8),
          document("a", "A 的高分片段", 0.9),
          document("c", "被裁剪的片段", 0.7),
        ];
      },
    },
    bookName: "天龙八部",
    maxContextDocuments: 2,
  });

  const result = await graph.invoke(initialState());

  assert.deepEqual(result.citationDocuments.map((item) => item.id), ["a", "b"]);
  assert.equal(result.citationDocuments[0].content, "A 的高分片段");
  assert.equal(result.generation, "高分片段见 [本地1]，次高分片段见 [本地2]。");
  assert.equal(result.citationValidation.status, "valid");
  assert.equal(result.citationValidation.correctionAttempts, 0);
  assert.equal(result.citationValidation.contentSupportChecked, false);
  assert.match(model.invokePrompts[0], /\[本地1\]\n文档ID：a/);
  assert.match(model.invokePrompts[0], /\[本地2\]\n文档ID：b/);
  assert.doesNotMatch(model.invokePrompts[0], /文档ID：c/);
});

test("invalid local references are removed after the bounded correction still fails", async () => {
  const model = new ScriptedModel({
    answers: [
      "错误引用 [本地2]，有效引用 [本地1]。",
      "仍有错误引用 [本地9]，保留有效引用 [本地1]。",
    ],
  });
  const graph = createAgenticRagGraph({
    model,
    retriever: { async search() { return [document("only", "唯一片段")]; } },
    bookName: "天龙八部",
  });

  const result = await graph.invoke(initialState());

  assert.doesNotMatch(result.generation, /\[本地9\]/);
  assert.match(result.generation, /\[本地1\]/);
  assert.equal(result.citationValidation.status, "sanitized");
  assert.deepEqual(result.citationValidation.initialInvalidReferences, ["[本地2]"]);
  assert.deepEqual(result.citationValidation.removedInvalidReferences, ["[本地9]"]);
  assert.deepEqual(result.citationValidation.finalInvalidReferences, []);
  assert.equal(result.citationValidation.correctionAttempts, 1);
  assert.equal(result.citationValidation.contentSupportChecked, false);
});

test("ordinary answers without local citations do not trigger correction", async () => {
  const model = new ScriptedModel({ answer: "资料不足，暂时无法确认。" });
  const graph = createAgenticRagGraph({
    model,
    retriever: { async search() { return []; } },
    bookName: "天龙八部",
  });

  const result = await graph.invoke(initialState());

  assert.equal(result.generation, "资料不足，暂时无法确认。");
  assert.equal(result.citationValidation.status, "valid");
  assert.deepEqual(result.citationValidation.finalReferences, []);
  assert.equal(result.citationValidation.correctionAttempts, 0);
  assert.equal(model.invokePrompts.length, 1);
});
