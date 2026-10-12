import test from "node:test";
import assert from "node:assert/strict";
import {
  createAgenticRagGraph,
  createInitialState,
  mergeUniqueDocuments,
} from "../src/rag/ebook/agent-graph.js";

class ScriptedModel {
  constructor({
    strategy = "complex",
    subQuestions = ["萧峰是谁？"],
    rewriteResults = [],
    evaluationActions = ["generate"],
    answer = "这是测试回答 [本地1]",
  } = {}) {
    this.strategy = strategy;
    this.subQuestions = subQuestions;
    this.rewriteResults = [...rewriteResults];
    this.evaluationActions = [...evaluationActions];
    this.answer = answer;
    this.rewritePrompts = [];
  }

  withStructuredOutput(schema) {
    const keys = Object.keys(schema.shape);
    if (keys.includes("strategy")) {
      return { invoke: async () => ({ strategy: this.strategy, reason: "测试路由" }) };
    }
    if (keys.includes("sub_questions")) {
      return {
        invoke: async () => ({
          sub_questions: this.subQuestions,
          reason: "测试拆分",
        }),
      };
    }
    if (keys.includes("needsRewrite")) {
      return {
        invoke: async (prompt) => {
          this.rewritePrompts.push(prompt);
          const result = this.rewriteResults.shift();
          if (result instanceof Error) throw result;
          return result;
        },
      };
    }

    return {
      invoke: async () => {
        const action = this.evaluationActions.shift() ?? "generate";
        return typeof action === "string"
          ? {
              nextAction: action,
              missing: action === "generate" ? [] : ["测试缺失信息"],
              reason: "测试评估",
              ...(action === "web_search" ? { web_query: "测试联网查询" } : {}),
            }
          : action;
      },
    };
  }

  async invoke() {
    return { content: this.answer };
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
  assert.equal(result.rewriteHistory[1].status, "kept_original");
});

test("scenario C: missing prior evidence cannot produce an invented entity", async () => {
  const queries = [];
  const model = new ScriptedModel({
    subQuestions: ["某位身份无法确定的人物是谁？", "他后来去了哪里？"],
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
  assert.equal(result.rewriteHistory[1].status, "skipped_no_prior_evidence");
});

test("scenario D: Q3 can use Q1 and Q2 evidence but never future evidence", async () => {
  const queries = [];
  const model = new ScriptedModel({
    subQuestions: ["误杀阿朱的人是谁？", "他的父亲是谁？", "他后来去了哪里？"],
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

test("mergeUniqueDocuments keeps the best score and applies the limit", () => {
  const documents = mergeUniqueDocuments(
    [{ id: "a", score: 0.4 }, { id: "b", score: 0.8 }],
    [{ id: "a", score: 0.9 }, { id: "c", score: 0.7 }],
    2,
  );

  assert.deepEqual(documents.map((item) => item.id), ["a", "b"]);
});
