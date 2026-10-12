import test from "node:test";
import assert from "node:assert/strict";
import { getConfig } from "../src/config.js";

const validEnv = {
  OPENAI_API_KEY: "test-key",
  MODEL_NAME: "test-chat",
  EMBEDDINGS_MODEL_NAME: "test-embedding",
  MILVUS_ADDRESS: "localhost:19530",
};

test("getConfig applies the EPUB RAG defaults", () => {
  const config = getConfig(validEnv);
  assert.equal(config.milvus.collectionName, "ebook_collection");
  assert.equal(config.model.embeddingDimension, 1024);
  assert.equal(config.milvus.bookId, "1");
  assert.equal(config.webSearch.enabled, false);
  assert.equal(config.rerank.enabled, false);
  assert.equal(config.rerank.model, "qwen3-rerank");
  assert.equal(config.rerank.topN, 8);
  assert.equal(config.rerank.candidateK, 20);
  assert.equal(config.rerank.failureMode, "fallback");
});

test("getConfig rejects an invalid embedding dimension", () => {
  assert.throws(
    () => getConfig({ ...validEnv, EMBEDDING_DIMENSION: "0" }),
    /EMBEDDING_DIMENSION/,
  );
});

test("getConfig validates enabled Rerank and applies key priority", () => {
  const config = getConfig({
    ...validEnv,
    ENABLE_RERANK: "true",
    RERANK_URL: "https://example.test/rerank",
    DASHSCOPE_API_KEY: "dashscope-key",
    RERANK_API_KEY: "rerank-key",
    RERANK_TOP_N: "12",
    RERANK_CANDIDATE_K: "6",
    RERANK_FAILURE_MODE: "error",
  });

  assert.equal(config.rerank.enabled, true);
  assert.equal(config.rerank.apiKey, "rerank-key");
  assert.equal(config.rerank.topN, 12);
  assert.equal(config.rerank.candidateK, 12);
  assert.equal(config.rerank.failureMode, "error");
});

test("getConfig requires a URL only when Rerank is enabled", () => {
  assert.throws(
    () => getConfig({ ...validEnv, ENABLE_RERANK: "true" }),
    /RERANK_URL/,
  );
  assert.doesNotThrow(() => getConfig({ ...validEnv, ENABLE_RERANK: "false" }));
});

test("getConfig rejects an unsupported Rerank failure mode", () => {
  assert.throws(
    () => getConfig({ ...validEnv, RERANK_FAILURE_MODE: "silent" }),
    /RERANK_FAILURE_MODE/,
  );
});
