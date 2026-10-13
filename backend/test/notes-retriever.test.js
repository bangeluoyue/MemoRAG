import test from "node:test";
import assert from "node:assert/strict";
import { createLangSmithObservability } from "../src/observability/langsmith.js";
import { ElasticsearchNotesRetriever } from "../src/rag/notes/elasticsearch-retriever.js";
import { HybridNotesRetriever } from "../src/rag/notes/hybrid-retriever.js";
import { MilvusNotesRetriever } from "../src/rag/notes/milvus-retriever.js";
import { createNotesRetriever } from "../src/rag/notes/index.js";
import { createRetrievalDocument } from "../src/rag/retrieval/index.js";

const scope = { knowledgeBase: "life_notes", userId: "user-1" };

function note(id, scores = {}, overrides = {}) {
  return createRetrievalDocument({
    id,
    knowledgeBase: "life_notes",
    userId: "user-1",
    content: `${id} PRIVATE_NOTE_CONTENT`,
    scores,
    ...overrides,
  });
}

function sourceRetriever(documents = [], error = null) {
  return {
    calls: [],
    async searchWithTrace(query, options) {
      this.calls.push({ query, options });
      if (error) throw error;
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

test("Elasticsearch notes retrieval forces tenant filters and rejects injected results", async () => {
  let request;
  const retriever = new ElasticsearchNotesRetriever({
    indexName: "notes-index",
    client: {
      async search(value) {
        request = value;
        return {
          hits: {
            hits: [
              { _score: 8.5, _source: { note_id: "ok", user_id: "user-1", knowledge_base: "life_notes", content: "kept", title: "title" } },
              { _score: 9, _source: { note_id: "other-user", user_id: "user-2", knowledge_base: "life_notes", content: "filtered" } },
              { _score: 9, _source: { note_id: "ebook", user_id: "user-1", knowledge_base: "ebook", content: "filtered" } },
              { _score: 7, _source: { user_id: "user-1", knowledge_base: "life_notes", content: "missing id" } },
            ],
          },
        };
      },
    },
  });
  const query = "  rewritten query  ";
  const result = await retriever.searchWithTrace(query, { k: 7, scope });

  assert.equal(request.index, "notes-index");
  assert.equal(request.size, 7);
  assert.equal(request.query.bool.must[0].match.content.query, query);
  assert.deepEqual(request.query.bool.filter, [
    { term: { knowledge_base: "life_notes" } },
    { term: { user_id: "user-1" } },
  ]);
  assert.deepEqual(result.documents.map((document) => document.id), ["ok"]);
  assert.equal(result.documents[0].scores.keyword, 8.5);
  assert.equal(result.documents[0].metadata.title, "title");
  assert.equal(result.diagnostics.scopeFilteredCount, 2);
  assert.equal(result.diagnostics.missingLogicalIdCount, 1);
});

test("Milvus notes retrieval uses the same query and enforces both filters", async () => {
  let embeddedQuery;
  let request;
  const retriever = new MilvusNotesRetriever({
    collectionName: "notes_collection",
    embeddingDimension: 2,
    nprobe: 12,
    embeddings: {
      async embedQuery(query) {
        embeddedQuery = query;
        return [0.1, 0.2];
      },
    },
    client: {
      async search(value) {
        request = value;
        return {
          status: { error_code: "Success", code: 0 },
          results: [
            { note_id: "ok", user_id: "user-1", knowledge_base: "life_notes", content: "kept", score: 0.91 },
            { note_id: "other-user", user_id: "user-2", knowledge_base: "life_notes", content: "filtered", score: 0.99 },
            { note_id: "ebook", user_id: "user-1", knowledge_base: "ebook", content: "filtered", score: 0.98 },
            { user_id: "user-1", knowledge_base: "life_notes", content: "missing id", score: 0.7 },
          ],
        };
      },
    },
  });
  const query = "  rewritten query  ";
  const result = await retriever.searchWithTrace(query, { k: 6, scope });

  assert.equal(embeddedQuery, query);
  assert.equal(request.collection_name, "notes_collection");
  assert.equal(request.limit, 6);
  assert.equal(
    request.filter,
    'knowledge_base == "life_notes" && user_id == "user-1"',
  );
  assert.deepEqual(request.params, { nprobe: 12 });
  assert.deepEqual(result.documents.map((document) => document.id), ["ok"]);
  assert.equal(result.documents[0].scores.vector, 0.91);
  assert.equal(result.diagnostics.scopeFilteredCount, 2);
  assert.equal(result.diagnostics.missingLogicalIdCount, 1);
});

test("hybrid notes retrieval merges IDs, preserves four scores, and keeps query unchanged", async () => {
  const elasticsearch = sourceRetriever([
    note("shared", { keyword: 12 }),
    note("keyword-only", { keyword: 10 }),
  ]);
  const milvus = sourceRetriever([
    note("shared", { vector: 0.92 }),
    note("vector-only", { vector: 0.90 }),
  ]);
  const rerankCalls = [];
  const retriever = new HybridNotesRetriever({
    elasticsearchRetriever: elasticsearch,
    milvusRetriever: milvus,
    keywordK: 4,
    vectorK: 5,
    reranker: {
      async rerank(query, documents, options) {
        rerankCalls.push({ query, ids: documents.map((item) => item.id), options });
        return [
          { index: 0, score: 0.98, rank: 1 },
          { index: 2, score: 0.76, rank: 2 },
        ];
      },
    },
  });
  const query = "rewritten currentQuery";
  const result = await retriever.searchWithTrace(query, { k: 2, scope });

  assert.equal(elasticsearch.calls[0].query, query);
  assert.equal(milvus.calls[0].query, query);
  assert.equal(rerankCalls[0].query, query);
  assert.deepEqual(rerankCalls[0].ids, ["shared", "keyword-only", "vector-only"]);
  assert.deepEqual(rerankCalls[0].options, { topN: 2 });
  assert.deepEqual(result.documents.map((document) => document.id), ["shared", "vector-only"]);
  assert.equal(result.documents[0].scores.keyword, 12);
  assert.equal(result.documents[0].scores.vector, 0.92);
  assert.equal(result.documents[0].scores.fusion, (1 / 61) + (1 / 61));
  assert.equal(result.documents[0].scores.rerank, 0.98);
  assert.deepEqual(
    result.documents[0].provenance.map((item) => item.source),
    ["elasticsearch", "milvus"],
  );
  assert.equal(result.trace.status, "success");
  assert.equal(result.trace.rerank.status, "success");
});

test("hybrid notes retrieval degrades across empty and failed backends", async (t) => {
  await t.test("ES empty keeps Milvus results", async () => {
    const retriever = new HybridNotesRetriever({
      elasticsearchRetriever: sourceRetriever([]),
      milvusRetriever: sourceRetriever([note("vector", { vector: 0.8 })]),
    });
    const result = await retriever.searchWithTrace("query", { k: 2, scope });
    assert.deepEqual(result.documents.map((document) => document.id), ["vector"]);
    assert.equal(result.trace.status, "success");
  });

  await t.test("Milvus empty keeps ES results", async () => {
    const retriever = new HybridNotesRetriever({
      elasticsearchRetriever: sourceRetriever([note("keyword", { keyword: 8 })]),
      milvusRetriever: sourceRetriever([]),
    });
    const result = await retriever.searchWithTrace("query", { k: 2, scope });
    assert.deepEqual(result.documents.map((document) => document.id), ["keyword"]);
    assert.equal(result.trace.status, "success");
  });

  await t.test("both empty are distinguishable from backend failure", async () => {
    const retriever = new HybridNotesRetriever({
      elasticsearchRetriever: sourceRetriever([]),
      milvusRetriever: sourceRetriever([]),
    });
    const result = await retriever.searchWithTrace("query", { k: 2, scope });
    assert.deepEqual(result.documents, []);
    assert.equal(result.trace.status, "empty");
  });

  await t.test("one failure returns safe diagnostics and the healthy source", async () => {
    const retriever = new HybridNotesRetriever({
      elasticsearchRetriever: sourceRetriever([], new TypeError("PRIVATE_CONNECTION")),
      milvusRetriever: sourceRetriever([note("vector", { vector: 0.8 })]),
    });
    const result = await retriever.searchWithTrace("query", { k: 2, scope });
    assert.deepEqual(result.documents.map((document) => document.id), ["vector"]);
    assert.equal(result.trace.status, "partial");
    assert.equal(result.trace.backends.elasticsearch.errorCategory, "ELASTICSEARCH_TYPEERROR");
    assert.equal(JSON.stringify(result.trace).includes("PRIVATE_CONNECTION"), false);
  });

  await t.test("both failures return failed rather than pretending there were no hits", async () => {
    const retriever = new HybridNotesRetriever({
      elasticsearchRetriever: sourceRetriever([], new Error("PRIVATE_ES")),
      milvusRetriever: sourceRetriever([], new Error("PRIVATE_MILVUS")),
    });
    const result = await retriever.searchWithTrace("query", { k: 2, scope });
    assert.deepEqual(result.documents, []);
    assert.equal(result.trace.status, "failed");
    assert.equal(JSON.stringify(result.trace).includes("PRIVATE_"), false);
  });
});

test("hybrid notes retrieval safely falls back when Rerank fails", async () => {
  const retriever = new HybridNotesRetriever({
    elasticsearchRetriever: sourceRetriever([
      note("first", { keyword: 10 }),
      note("second", { keyword: 9 }),
    ]),
    milvusRetriever: sourceRetriever([]),
    reranker: { async rerank() { throw new TypeError("PRIVATE_RERANK_FAILURE"); } },
    rerankFailureMode: "fallback",
  });
  const result = await retriever.searchWithTrace("query", { k: 1, scope });

  assert.deepEqual(result.documents.map((document) => document.id), ["first"]);
  assert.equal(result.trace.rerank.status, "fallback");
  assert.equal(result.trace.rerank.failureCategory, "RERANK_TYPEERROR");
  assert.equal(JSON.stringify(result.trace).includes("PRIVATE_RERANK_FAILURE"), false);
});

test("hybrid notes retrieval can propagate Rerank errors by policy", async () => {
  const retriever = new HybridNotesRetriever({
    elasticsearchRetriever: sourceRetriever([note("first", { keyword: 10 })]),
    milvusRetriever: sourceRetriever([]),
    reranker: { async rerank() { throw new Error("rerank failed"); } },
    rerankFailureMode: "error",
  });
  await assert.rejects(
    retriever.search("query", { k: 1, scope }),
    /rerank failed/,
  );
});

class MemoryTracingClient {
  constructor() {
    this.calls = [];
  }

  async createRun(run) {
    this.calls.push({ operation: "create", run });
  }

  async updateRun(runId, run) {
    this.calls.push({ operation: "update", runId, run });
  }
}

function tracingConfig(noteTracingEnabled) {
  return {
    requested: true,
    enabled: true,
    apiKey: "PRIVATE_LANGSMITH_KEY",
    project: "memorag-test",
    contentMode: "metadata_only",
    noteTracingEnabled,
  };
}

test("notes retrieval tracing is default-off and explicit metadata-only", async () => {
  const blockedClient = new MemoryTracingClient();
  const blockedObservability = createLangSmithObservability(
    tracingConfig(false),
    { client: blockedClient },
  );
  const blockedRetriever = new HybridNotesRetriever({
    elasticsearchRetriever: sourceRetriever([]),
    milvusRetriever: sourceRetriever([]),
    observability: blockedObservability,
  });
  const blocked = await blockedRetriever.searchWithTrace("private query", { k: 2, scope });
  assert.equal(blockedClient.calls.length, 0);
  assert.equal(blocked.trace.langsmith.disabledReason, "scope_disabled");

  const enabledClient = new MemoryTracingClient();
  const enabledObservability = createLangSmithObservability(
    tracingConfig(true),
    { client: enabledClient },
  );
  const enabledRetriever = new HybridNotesRetriever({
    elasticsearchRetriever: sourceRetriever([note("safe-id", { keyword: 4 })]),
    milvusRetriever: sourceRetriever([]),
    observability: enabledObservability,
  });
  const enabled = await enabledRetriever.searchWithTrace("private query", { k: 2, scope });

  assert.equal(enabled.trace.langsmith.enabled, true);
  assert.ok(enabledClient.calls.length >= 2);
  const serialized = JSON.stringify(enabledClient.calls);
  assert.equal(serialized.includes("PRIVATE_NOTE_CONTENT"), false);
  assert.equal(serialized.includes("PRIVATE_LANGSMITH_KEY"), false);
  assert.ok(enabledClient.calls.every(({ run }) => (
    run.extra?.metadata?.memorag_scope === "notes"
  )));
});

test("createNotesRetriever exposes the unified interface without initializing injected backends", async () => {
  const config = {
    model: {
      apiKey: "test-key",
      embeddingModel: "test-embedding",
      embeddingDimension: 2,
    },
    milvus: { address: "unused", nprobe: 8 },
    notes: {
      elasticsearch: { node: "http://unused", indexName: "unused" },
      milvus: { collectionName: "unused" },
      keywordK: 3,
      vectorK: 4,
      rerankEnabled: false,
    },
    rerank: { failureMode: "fallback" },
    langsmith: { requested: false, enabled: false },
  };
  const elasticsearchRetriever = sourceRetriever([note("keyword", { keyword: 5 })]);
  const milvusRetriever = sourceRetriever([]);
  const retriever = createNotesRetriever({
    config,
    elasticsearchRetriever,
    milvusRetriever,
  });

  const documents = await retriever.search("query", { k: 1, scope });
  assert.deepEqual(documents.map((document) => document.id), ["keyword"]);
  assert.equal(elasticsearchRetriever.calls[0].options.k, 3);
  assert.equal(milvusRetriever.calls[0].options.k, 4);
  await retriever.close();
});
