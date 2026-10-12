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
});

test("getConfig rejects an invalid embedding dimension", () => {
  assert.throws(
    () => getConfig({ ...validEnv, EMBEDDING_DIMENSION: "0" }),
    /EMBEDDING_DIMENSION/,
  );
});
