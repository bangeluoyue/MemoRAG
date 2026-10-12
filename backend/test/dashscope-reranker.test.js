import test from "node:test";
import assert from "node:assert/strict";
import {
  DashScopeReranker,
  RerankError,
} from "../src/rag/shared/dashscope-reranker.js";

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() { return payload; },
  };
}

test("DashScopeReranker reuses the legacy request protocol and validates results", async () => {
  const calls = [];
  const reranker = new DashScopeReranker({
    apiKey: "secret-test-key",
    model: "qwen3-rerank",
    baseUrl: "https://example.test/rerank",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        results: [
          { index: 1, relevance_score: 0.98 },
          { index: 0, relevance_score: 0.72 },
        ],
      });
    },
  });

  const result = await reranker.rerank("萧峰", [
    { content: "片段 A" },
    { pageContent: "片段 B" },
  ], { topN: 2 });

  assert.deepEqual(result, [
    { index: 1, score: 0.98, rank: 1 },
    { index: 0, score: 0.72, rank: 2 },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.test/rerank");
  assert.equal(calls[0].options.headers.Authorization, "Bearer secret-test-key");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    model: "qwen3-rerank",
    query: "萧峰",
    documents: ["片段 A", "片段 B"],
    top_n: 2,
  });
});

test("DashScopeReranker skips requests for an empty candidate set", async () => {
  let calls = 0;
  const reranker = new DashScopeReranker({
    apiKey: "test-key",
    baseUrl: "https://example.test/rerank",
    fetchImpl: async () => { calls += 1; },
  });

  assert.deepEqual(await reranker.rerank("query", [], { topN: 3 }), []);
  assert.equal(calls, 0);
});

test("DashScopeReranker rejects missing, duplicate and out-of-range result indices", async () => {
  for (const results of [
    [{ relevance_score: 0.9 }],
    [{ index: 0, relevance_score: 0.9 }, { index: 0, relevance_score: 0.8 }],
    [{ index: 2, relevance_score: 0.9 }],
  ]) {
    const reranker = new DashScopeReranker({
      apiKey: "test-key",
      baseUrl: "https://example.test/rerank",
      fetchImpl: async () => jsonResponse({ results }),
    });

    await assert.rejects(
      reranker.rerank("query", [{ content: "A" }, { content: "B" }]),
      (error) => error instanceof RerankError
        && error.code === "RERANK_INVALID_RESPONSE",
    );
  }
});

test("DashScopeReranker classifies HTTP and invalid JSON failures without response data", async () => {
  const httpReranker = new DashScopeReranker({
    apiKey: "test-key",
    baseUrl: "https://example.test/rerank",
    fetchImpl: async () => jsonResponse({ private: "do-not-expose" }, {
      ok: false,
      status: 429,
    }),
  });
  await assert.rejects(
    httpReranker.rerank("query", [{ content: "A" }]),
    (error) => error.code === "RERANK_HTTP_ERROR"
      && !error.message.includes("do-not-expose")
      && !error.message.includes("test-key"),
  );

  const jsonReranker = new DashScopeReranker({
    apiKey: "test-key",
    baseUrl: "https://example.test/rerank",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() { throw new SyntaxError("private body"); },
    }),
  });
  await assert.rejects(
    jsonReranker.rerank("query", [{ content: "A" }]),
    (error) => error.code === "RERANK_INVALID_JSON"
      && !error.message.includes("private body"),
  );
});

test("DashScopeReranker aborts timed-out requests", async () => {
  const reranker = new DashScopeReranker({
    apiKey: "test-key",
    baseUrl: "https://example.test/rerank",
    timeoutMs: 5,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }),
  });

  await assert.rejects(
    reranker.rerank("query", [{ content: "A" }]),
    (error) => error.code === "RERANK_TIMEOUT",
  );
});
