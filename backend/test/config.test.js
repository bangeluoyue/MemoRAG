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
  assert.equal(config.http.host, "127.0.0.1");
  assert.equal(config.http.port, 3000);
  assert.equal(config.milvus.collectionName, "ebook_collection");
  assert.equal(config.model.embeddingDimension, 1024);
  assert.equal(config.model.requestTimeoutMs, 60000);
  assert.equal(config.model.maxRetries, 0);
  assert.equal(config.milvus.bookId, "1");
  assert.equal(config.webSearch.enabled, false);
  assert.equal(config.rerank.enabled, false);
  assert.equal(config.rerank.model, "qwen3-rerank");
  assert.equal(config.rerank.topN, 8);
  assert.equal(config.rerank.candidateK, 20);
  assert.equal(config.rerank.failureMode, "fallback");
  assert.equal(config.rag.maxContextDocuments, 12);
  assert.equal(config.rag.maxSubQuestions, 4);
  assert.equal(config.rag.maxPlanRepairAttempts, 1);
  assert.equal(config.rag.maxSingleRetrievals, 2);
  assert.equal(config.rag.maxGapRecoveryAttempts, 1);
  assert.equal(config.rag.agentTimeoutMs, 120000);
  assert.equal(config.langsmith.requested, false);
  assert.equal(config.langsmith.enabled, false);
  assert.equal(config.langsmith.contentMode, "metadata_only");
  assert.equal(config.langsmith.noteTracingEnabled, false);
  assert.equal(config.notes.knowledgeBase, "life_notes");
  assert.equal(config.notes.postgres.connectionString, "");
  assert.equal(config.notes.postgres.ssl, false);
  assert.equal(config.notes.elasticsearch.node, "http://localhost:9200");
  assert.equal(config.notes.elasticsearch.indexName, "life_notes");
  assert.equal(config.notes.milvus.collectionName, "life_notes");
  assert.equal(config.notes.keywordK, 20);
  assert.equal(config.notes.vectorK, 20);
  assert.equal(config.notes.rerankEnabled, false);
});

test("getConfig validates HTTP listen settings", () => {
  const config = getConfig({
    ...validEnv,
    HTTP_HOST: "localhost",
    HTTP_PORT: "8080",
  });
  assert.deepEqual(config.http, { host: "localhost", port: 8080 });
  assert.throws(
    () => getConfig({ ...validEnv, HTTP_PORT: "70000" }),
    /HTTP_PORT/u,
  );
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
  assert.throws(
    () => getConfig({ ...validEnv, ENABLE_NOTE_RERANK: "true" }),
    /RERANK_URL/,
  );
});

test("getConfig applies life-notes retrieval overrides", () => {
  const config = getConfig({
    ...validEnv,
    ELASTICSEARCH_NODE: "https://elastic.example.test",
    ELASTICSEARCH_NOTES_INDEX: "tenant_notes",
    MILVUS_NOTES_COLLECTION: "tenant_notes_vectors",
    NOTES_KEYWORD_K: "15",
    NOTES_VECTOR_K: "25",
    ENABLE_NOTE_RERANK: "true",
    RERANK_URL: "https://rerank.example.test",
    DATABASE_URL: "postgresql://example.test/memorag",
    DATABASE_SSL: "true",
  });
  assert.equal(config.notes.elasticsearch.node, "https://elastic.example.test");
  assert.equal(config.notes.elasticsearch.indexName, "tenant_notes");
  assert.equal(config.notes.milvus.collectionName, "tenant_notes_vectors");
  assert.equal(config.notes.keywordK, 15);
  assert.equal(config.notes.vectorK, 25);
  assert.equal(config.notes.rerankEnabled, true);
  assert.equal(config.notes.postgres.connectionString, "postgresql://example.test/memorag");
  assert.equal(config.notes.postgres.ssl, true);
});

test("getConfig rejects an unsupported Rerank failure mode", () => {
  assert.throws(
    () => getConfig({ ...validEnv, RERANK_FAILURE_MODE: "silent" }),
    /RERANK_FAILURE_MODE/,
  );
});

test("getConfig validates Agent planning and single-retrieval budgets", () => {
  assert.throws(
    () => getConfig({ ...validEnv, MAX_SUB_QUESTIONS: "9" }),
    /MAX_SUB_QUESTIONS/,
  );
  assert.throws(
    () => getConfig({ ...validEnv, MAX_PLAN_REPAIR_ATTEMPTS: "3" }),
    /MAX_PLAN_REPAIR_ATTEMPTS/,
  );
  assert.throws(
    () => getConfig({ ...validEnv, MAX_SINGLE_RETRIEVALS: "0" }),
    /MAX_SINGLE_RETRIEVALS/,
  );
  assert.throws(
    () => getConfig({ ...validEnv, MAX_GAP_RECOVERY_ATTEMPTS: "2" }),
    /MAX_GAP_RECOVERY_ATTEMPTS/,
  );
});

test("getConfig validates bounded LLM and whole-Agent timeouts", () => {
  const config = getConfig({
    ...validEnv,
    LLM_TIMEOUT_MS: "45000",
    LLM_MAX_RETRIES: "1",
    AGENT_TIMEOUT_MS: "90000",
  });
  assert.equal(config.model.requestTimeoutMs, 45000);
  assert.equal(config.model.maxRetries, 1);
  assert.equal(config.rag.agentTimeoutMs, 90000);
  assert.throws(
    () => getConfig({ ...validEnv, LLM_TIMEOUT_MS: "999" }),
    /LLM_TIMEOUT_MS/u,
  );
  assert.throws(
    () => getConfig({ ...validEnv, LLM_MAX_RETRIES: "-1" }),
    /LLM_MAX_RETRIES/u,
  );
  assert.throws(
    () => getConfig({ ...validEnv, AGENT_TIMEOUT_MS: "600001" }),
    /AGENT_TIMEOUT_MS/u,
  );
});

test("getConfig resolves LangSmith aliases with LANGSMITH priority", () => {
  const config = getConfig({
    ...validEnv,
    LANGSMITH_TRACING: "true",
    LANGCHAIN_TRACING_V2: "false",
    LANGSMITH_API_KEY: "preferred-key",
    LANGCHAIN_API_KEY: "legacy-key",
    LANGSMITH_PROJECT: "preferred-project",
    LANGCHAIN_PROJECT: "legacy-project",
    LANGSMITH_ENDPOINT: "https://preferred.example.test",
    LANGCHAIN_ENDPOINT: "https://legacy.example.test",
    MEMORAG_LANGSMITH_CONTENT_MODE: "full",
    ENABLE_NOTE_LANGSMITH_TRACING: "true",
  });

  assert.equal(config.langsmith.requested, true);
  assert.equal(config.langsmith.enabled, true);
  assert.equal(config.langsmith.apiKey, "preferred-key");
  assert.equal(config.langsmith.project, "preferred-project");
  assert.equal(config.langsmith.endpoint, "https://preferred.example.test");
  assert.equal(config.langsmith.contentMode, "full");
  assert.equal(config.langsmith.noteTracingEnabled, true);

  const legacyOnly = getConfig({
    ...validEnv,
    LANGCHAIN_TRACING_V2: "true",
    LANGCHAIN_API_KEY: "legacy-key",
    LANGCHAIN_PROJECT: "legacy-project",
    LANGCHAIN_ENDPOINT: "https://legacy.example.test",
  });
  assert.equal(legacyOnly.langsmith.enabled, true);
  assert.equal(legacyOnly.langsmith.apiKey, "legacy-key");
  assert.equal(legacyOnly.langsmith.project, "legacy-project");
  assert.equal(legacyOnly.langsmith.endpoint, "https://legacy.example.test");
});

test("getConfig safely disables requested tracing when the LangSmith key is absent", () => {
  const config = getConfig({
    ...validEnv,
    LANGCHAIN_TRACING: "true",
  });

  assert.equal(config.langsmith.requested, true);
  assert.equal(config.langsmith.enabled, false);
  assert.equal(config.langsmith.disabledReason, "missing_api_key");
});

test("getConfig only enables tracing for the exact string true", () => {
  const config = getConfig({
    ...validEnv,
    LANGSMITH_TRACING: "1",
    LANGSMITH_API_KEY: "test-langsmith-key",
  });

  assert.equal(config.langsmith.requested, false);
  assert.equal(config.langsmith.enabled, false);
});
