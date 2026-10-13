import test from "node:test";
import assert from "node:assert/strict";
import { EbookRetriever } from "../src/rag/ebook/ebook-retriever.js";
import {
  KNOWLEDGE_BASES,
  RetrievalScopeError,
  createRetrievalDocument,
  reciprocalRankFusion,
  validateRetrievalScope,
} from "../src/rag/retrieval/index.js";

function note(id, scores = {}, overrides = {}) {
  return createRetrievalDocument({
    id,
    knowledgeBase: KNOWLEDGE_BASES.LIFE_NOTES,
    userId: "user-1",
    content: `${id} content`,
    scores,
    ...overrides,
  });
}

test("retrieval contract validates knowledge-base-specific scopes", () => {
  assert.deepEqual(
    validateRetrievalScope({ knowledgeBase: "ebook", bookId: "book-1" }),
    { knowledgeBase: "ebook", bookId: "book-1" },
  );
  assert.deepEqual(
    validateRetrievalScope({ knowledgeBase: "life_notes", userId: "user-1" }),
    { knowledgeBase: "life_notes", userId: "user-1" },
  );
  assert.throws(
    () => validateRetrievalScope({ knowledgeBase: "life_notes" }),
    RetrievalScopeError,
  );
  assert.throws(
    () => validateRetrievalScope(
      { knowledgeBase: "ebook", bookId: "book-1" },
      KNOWLEDGE_BASES.LIFE_NOTES,
    ),
    /\u8303\u56f4\u4e0d\u5339\u914d/,
  );
});

test("reciprocalRankFusion merges shared IDs and keeps stable ties", () => {
  const scope = { knowledgeBase: "life_notes", userId: "user-1" };
  const result = reciprocalRankFusion([
    {
      source: "elasticsearch",
      documents: [
        note("shared", { keyword: 12 }),
        note("keyword-only", { keyword: 9 }),
        { ...note("wrong-user", { keyword: 8 }), userId: "user-2" },
        { id: "", knowledgeBase: "life_notes", userId: "user-1" },
      ],
    },
    {
      source: "milvus",
      documents: [
        note("shared", { vector: 0.91 }),
        note("vector-only", { vector: 0.89 }),
      ],
    },
  ], { scope });

  assert.deepEqual(
    result.documents.map((document) => document.id),
    ["shared", "keyword-only", "vector-only"],
  );
  assert.equal(result.documents[0].fusionScore, (1 / 61) + (1 / 61));
  assert.equal(result.documents[0].scores.keyword, 12);
  assert.equal(result.documents[0].scores.vector, 0.91);
  assert.equal(result.documents[0].scores.fusion, (1 / 61) + (1 / 61));
  assert.equal(result.documents[0].scores.rerank, null);
  assert.deepEqual(
    result.documents[0].provenance.map((item) => item.source),
    ["elasticsearch", "milvus"],
  );
  assert.equal(result.documents[1].fusionScore, 1 / 62);
  assert.equal(result.documents[2].fusionScore, 1 / 62);
  assert.equal(result.diagnostics.scopeFilteredCount, 1);
  assert.equal(result.diagnostics.missingLogicalIdCount, 1);
});

test("EbookRetriever supports legacy and unified options while filtering scope", async () => {
  const calls = [];
  const adapter = new EbookRetriever({
    retriever: {
      async search(query, options) {
        calls.push({ query, options });
        return [
          {
            id: "book-1-doc",
            score: 0.9,
            bookId: "book-1",
            bookName: "Book",
            chapterNum: 1,
            chunkIndex: 2,
            content: "kept",
          },
          {
            id: "book-2-doc",
            score: 0.99,
            bookId: "book-2",
            content: "filtered",
          },
        ];
      },
    },
  });

  const legacy = await adapter.searchWithTrace("query", { k: 3, bookId: "book-1" });
  const unified = await adapter.search("query", {
    k: 2,
    scope: { knowledgeBase: "ebook", bookId: "book-1" },
  });

  assert.deepEqual(calls, [
    { query: "query", options: { k: 3, bookId: "book-1" } },
    { query: "query", options: { k: 2, bookId: "book-1" } },
  ]);
  assert.deepEqual(legacy.documents.map((document) => document.id), ["book-1-doc"]);
  assert.equal(legacy.retrieval.adapterFilteredOutCount, 1);
  assert.equal(legacy.documents[0].knowledgeBase, "ebook");
  assert.equal(legacy.documents[0].scores.vector, 0.9);
  assert.equal(legacy.documents[0].metadata.chapterNum, 1);
  assert.deepEqual(unified.map((document) => document.id), ["book-1-doc"]);
  await assert.rejects(
    adapter.search("query", {
      bookId: "book-1",
      scope: { knowledgeBase: "ebook", bookId: "book-2" },
    }),
    /\u4e0d\u4e00\u81f4/,
  );
});
