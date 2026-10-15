import test from "node:test";
import assert from "node:assert/strict";
import { createNotesRag } from "../src/rag/notes/agent.js";

class NotesGenerationModel {
  constructor(answer = "体检安排在周五上午 [本地1]。") {
    this.answer = answer;
    this.invokeCount = 0;
  }

  withStructuredOutput() {
    throw new Error("生活笔记默认问答不得调用路由、拆题或评估模型");
  }

  async invoke() {
    this.invokeCount += 1;
    return { content: this.answer };
  }
}

function config({ rerankEnabled = false } = {}) {
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
    milvus: { address: "localhost:19530", nprobe: 8 },
    notes: {
      knowledgeBase: "life_notes",
      keywordK: 5,
      vectorK: 5,
      rerankEnabled,
      elasticsearch: { node: "http://localhost:9200", indexName: "life_notes" },
      milvus: { collectionName: "life_notes" },
    },
    rag: {
      retrievalK: 4,
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
      apiKey: "test-key",
      url: "https://example.test/rerank",
      model: "qwen3-rerank",
      topN: 2,
      candidateK: 5,
      timeoutMs: 100,
      failureMode: "fallback",
    },
    webSearch: { enabled: true, maxSearches: 2 },
    langsmith: {
      requested: false,
      enabled: false,
      noteTracingEnabled: false,
      contentMode: "metadata_only",
    },
  };
}

function note(id, overrides = {}) {
  return {
    id,
    knowledgeBase: "life_notes",
    userId: "user-1",
    content: overrides.content ?? `${id} 的笔记内容`,
    metadata: { title: overrides.title ?? `${id} 标题` },
    scores: {
      keyword: overrides.keyword ?? null,
      vector: overrides.vector ?? null,
      fusion: overrides.fusion ?? null,
      rerank: overrides.rerank ?? null,
    },
    provenance: overrides.provenance ?? [],
  };
}

function sourceRetriever(documents, calls) {
  return {
    async searchWithTrace(query, options) {
      calls.push({ query, options });
      return {
        documents,
        diagnostics: {
          returnedCount: documents.length,
          missingLogicalIdCount: 0,
          scopeFilteredCount: 0,
        },
      };
    },
  };
}

test("notes RAG is independent from the EPUB graph and keeps strict scope", async () => {
  const calls = [];
  const model = new NotesGenerationModel();
  const rag = createNotesRag({
    config: config(),
    model,
    retriever: {
      async searchWithTrace(query, options) {
        calls.push({ query, options });
        return {
          documents: [
            note("cross-scope", {
              content: "其他用户内容",
              title: "越权数据",
              userId: "other-user",
            }),
            note("note-1", {
              content: "体检安排在周五上午。",
              title: "体检安排",
              fusion: 0.032,
            }),
          ].map((document, index) => index === 0
            ? { ...document, userId: "other-user" }
            : document),
          trace: {
            status: "success",
            totalDurationMs: 7,
            rerank: { enabled: false, status: "disabled" },
          },
        };
      },
    },
  });

  try {
    const result = await rag.ask("我的体检安排在什么时候？", {
      userId: "user-1",
    });

    assert.equal(rag.graph, undefined);
    assert.equal(model.invokeCount, 1);
    assert.equal(result.answer, "体检安排在周五上午 [本地1]。");
    assert.equal(result.route.strategy, "hybrid");
    assert.equal(result.route.mode, "single_retrieval");
    assert.match(result.route.reason, /RRF.*Rerank 未启用/u);
    assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0].noteId, "note-1");
    assert.equal(result.sources[0].reference, "本地1");
    assert.equal(result.trace.retrievalCount, 1);
    assert.equal(result.trace.webSearchCount, 0);
    assert.deepEqual(result.trace.subQuestions, ["我的体检安排在什么时候？"]);
    assert.deepEqual(result.trace.coverage, []);
    assert.deepEqual(result.trace.rewriteHistory, []);
    assert.equal(result.trace.execution.llmCallCount, 1);
    assert.equal(result.trace.execution.localRetrievalCount, 1);
    assert.deepEqual(calls, [{
      query: "我的体检安排在什么时候？",
      options: {
        k: 4,
        scope: { knowledgeBase: "life_notes", userId: "user-1" },
      },
    }]);
  } finally {
    await rag.close();
  }
});

test("notes RAG performs one ES call, one Milvus call, RRF dedupe and one generation", async () => {
  const esCalls = [];
  const milvusCalls = [];
  const model = new NotesGenerationModel("负责人是林晓 [本地1]。有关时间见另一条笔记 [本地2]。");
  const rag = createNotesRag({
    config: config(),
    model,
    elasticsearchRetriever: sourceRetriever([
      note("shared", { keyword: 12, content: "负责人是林晓。" }),
      note("keyword-only", { keyword: 10, content: "关键词命中。" }),
    ], esCalls),
    milvusRetriever: sourceRetriever([
      note("shared", { vector: 0.94, content: "负责人是林晓。" }),
      note("vector-only", { vector: 0.88, content: "周五下午四点整理。" }),
    ], milvusCalls),
  });

  try {
    const result = await rag.ask("负责人是谁，何时整理？", { userId: "user-1" });

    assert.equal(esCalls.length, 1);
    assert.equal(milvusCalls.length, 1);
    assert.equal(esCalls[0].query, "负责人是谁，何时整理？");
    assert.equal(milvusCalls[0].query, "负责人是谁，何时整理？");
    assert.deepEqual(esCalls[0].options.scope, {
      knowledgeBase: "life_notes",
      userId: "user-1",
    });
    assert.deepEqual(milvusCalls[0].options.scope, esCalls[0].options.scope);
    assert.equal(model.invokeCount, 1);
    assert.deepEqual(
      result.sources.map((source) => source.id),
      ["shared", "keyword-only", "vector-only"],
    );
    assert.equal(result.sources.filter((source) => source.id === "shared").length, 1);
    assert.ok(result.sources[0].scores.fusion > 0);
    assert.equal(result.trace.retrievals[0].rerank.status, "disabled");
    assert.equal(result.trace.execution.llmCallCount, 1);
  } finally {
    await rag.close();
  }
});

test("notes RAG exposes successful Rerank strategy", async () => {
  const model = new NotesGenerationModel("重排后的笔记答案 [本地1]。");
  let rerankCalls = 0;
  const rag = createNotesRag({
    config: config({ rerankEnabled: true }),
    model,
    elasticsearchRetriever: sourceRetriever([
      note("first", { keyword: 10 }),
      note("second", { keyword: 9 }),
    ], []),
    milvusRetriever: sourceRetriever([], []),
    reranker: {
      async rerank(_query, _documents, options) {
        rerankCalls += 1;
        assert.deepEqual(options, { topN: 2 });
        return [{ index: 1, score: 0.98, rank: 1 }];
      },
    },
  });

  try {
    const result = await rag.ask("重排测试", { userId: "user-1" });
    assert.equal(rerankCalls, 1);
    assert.equal(result.sources[0].id, "second");
    assert.match(result.route.reason, /执行 Rerank/u);
    assert.equal(result.trace.retrievals[0].rerank.status, "success");
    assert.equal(result.trace.execution.rerankRequestCount, 1);
  } finally {
    await rag.close();
  }
});

test("notes RAG exposes Rerank fallback and keeps RRF results", async () => {
  const model = new NotesGenerationModel("回退后的答案 [本地1]。");
  const rag = createNotesRag({
    config: config({ rerankEnabled: true }),
    model,
    elasticsearchRetriever: sourceRetriever([
      note("rrf-first", { keyword: 10 }),
      note("rrf-second", { keyword: 9 }),
    ], []),
    milvusRetriever: sourceRetriever([], []),
    reranker: { async rerank() { throw new TypeError("private rerank failure"); } },
  });

  try {
    const result = await rag.ask("回退测试", { userId: "user-1" });
    assert.equal(result.sources[0].id, "rrf-first");
    assert.match(result.route.reason, /回退到 RRF/u);
    assert.equal(result.trace.retrievals[0].rerank.status, "fallback");
    assert.equal(result.trace.execution.rerankFallbackCount, 1);
    assert.doesNotMatch(JSON.stringify(result), /private rerank failure/u);
  } finally {
    await rag.close();
  }
});

test("empty notes retrieval skips generation and returns no unsupported answer", async () => {
  const model = new NotesGenerationModel();
  const rag = createNotesRag({
    config: config(),
    model,
    elasticsearchRetriever: sourceRetriever([], []),
    milvusRetriever: sourceRetriever([], []),
  });

  try {
    const result = await rag.ask("不存在的笔记", { userId: "user-1" });
    assert.equal(model.invokeCount, 0);
    assert.match(result.answer, /没有检索到/u);
    assert.deepEqual(result.sources, []);
    assert.equal(result.trace.execution.llmCallCount, 0);
    assert.equal(result.trace.execution.localRetrievalCount, 1);
  } finally {
    await rag.close();
  }
});

test("createNotesRag requires userId before retrieval", async () => {
  let retrievals = 0;
  const rag = createNotesRag({
    config: config(),
    model: new NotesGenerationModel(),
    retriever: { async search() { retrievals += 1; return []; } },
  });
  try {
    await assert.rejects(
      () => rag.ask("测试问题"),
      /scope\.userId 不能为空/u,
    );
    assert.equal(retrievals, 0);
  } finally {
    await rag.close();
  }
});
