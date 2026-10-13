import test from "node:test";
import assert from "node:assert/strict";
import { RerankingBookRetriever } from "../src/rag/ebook/reranking-retriever.js";
import { RerankError } from "../src/rag/shared/dashscope-reranker.js";

function document(id, bookId, score) {
  return {
    id,
    bookId,
    bookName: "天龙八部",
    chapterNum: 7,
    chunkIndex: 3,
    score,
    content: `片段 ${id}`,
  };
}

test("RerankingBookRetriever expands recall, keeps the book filter and preserves scores", async () => {
  const searchCalls = [];
  const rerankCalls = [];
  const retriever = new RerankingBookRetriever({
    candidateK: 20,
    retriever: {
      async search(query, options) {
        searchCalls.push({ query, options });
        return [
          document("a", "book-1", 0.91),
          document("other", "book-2", 0.99),
          document("b", "book-1", 0.82),
        ];
      },
    },
    reranker: {
      async rerank(query, documents, options) {
        rerankCalls.push({ query, documents, options });
        return [
          { index: 1, score: 0.97, rank: 1 },
          { index: 0, score: 0.64, rank: 2 },
        ];
      },
    },
  });

  const result = await retriever.searchWithTrace("改写后的查询", {
    k: 2,
    bookId: "book-1",
  });

  assert.deepEqual(searchCalls, [{
    query: "改写后的查询",
    options: { k: 20, bookId: "book-1" },
  }]);
  assert.equal(rerankCalls[0].query, "改写后的查询");
  assert.deepEqual(rerankCalls[0].documents.map((item) => item.id), ["a", "b"]);
  assert.deepEqual(rerankCalls[0].options, { topN: 2 });
  assert.deepEqual(result.documents.map((item) => item.id), ["b", "a"]);
  assert.equal(result.documents[0].score, 0.82);
  assert.equal(result.documents[0].rerankScore, 0.97);
  assert.equal(result.documents[0].originalRank, 2);
  assert.equal(result.documents[0].rerankRank, 1);
  assert.equal(result.documents[0].bookId, "book-1");
  assert.equal(result.documents[0].bookName, "天龙八部");
  assert.equal(result.documents[0].chapterNum, 7);
  assert.equal(result.documents[0].chunkIndex, 3);
  assert.equal(result.documents[0].content, "片段 b");
  assert.equal(result.rerank.filteredOutCount, 1);
  assert.equal(result.rerank.status, "success");
  assert.ok(result.retrieval.rerankDurationMs >= 0);
  assert.ok(result.retrieval.totalDurationMs >= 0);
});

test("RerankingBookRetriever skips rerank when same-book candidates are empty", async () => {
  let rerankCalls = 0;
  const retriever = new RerankingBookRetriever({
    retriever: {
      async search() { return [document("other", "book-2", 0.9)]; },
    },
    reranker: {
      async rerank() { rerankCalls += 1; },
    },
  });

  const result = await retriever.searchWithTrace("query", { k: 3, bookId: "book-1" });

  assert.deepEqual(result.documents, []);
  assert.equal(result.rerank.status, "skipped_empty");
  assert.equal(result.rerank.filteredOutCount, 1);
  assert.equal(rerankCalls, 0);
});

test("RerankingBookRetriever safely falls back to Milvus order", async () => {
  const retriever = new RerankingBookRetriever({
    failureMode: "fallback",
    retriever: {
      async search() {
        return [document("a", "1", 0.8), document("b", "1", 0.7)];
      },
    },
    reranker: {
      async rerank() {
        throw new RerankError("RERANK_TIMEOUT", "timeout");
      },
    },
  });

  const result = await retriever.searchWithTrace("query", { k: 1, bookId: "1" });

  assert.deepEqual(result.documents.map((item) => item.id), ["a"]);
  assert.equal(result.documents[0].score, 0.8);
  assert.equal(result.documents[0].rerankStatus, "fallback");
  assert.equal(result.rerank.status, "fallback");
  assert.equal(result.rerank.failureCategory, "RERANK_TIMEOUT");
  assert.doesNotMatch(JSON.stringify(result.rerank), /片段 a|timeout/);
});

test("RerankingBookRetriever propagates failures in error mode", async () => {
  const retriever = new RerankingBookRetriever({
    failureMode: "error",
    retriever: {
      async search() { return [document("a", "1", 0.8)]; },
    },
    reranker: {
      async rerank() { throw new Error("mock failure"); },
    },
  });

  await assert.rejects(
    retriever.searchWithTrace("query", { k: 1, bookId: "1" }),
    /mock failure/,
  );
});
