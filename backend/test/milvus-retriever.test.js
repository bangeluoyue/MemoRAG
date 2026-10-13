import test from "node:test";
import assert from "node:assert/strict";
import { MilvusBookRetriever } from "../src/rag/ebook/milvus-retriever.js";

test("MilvusBookRetriever embeds, filters and maps search results", async () => {
  let request;
  const retriever = new MilvusBookRetriever({
    client: {
      async search(value) {
        request = value;
        return {
          status: { error_code: "Success", code: 0 },
          results: [{
            id: "1_2_3",
            score: 0.88,
            book_id: "1",
            book_name: "天龙八部",
            chapter_num: 2,
            index: 3,
            content: "测试片段",
          }],
        };
      },
    },
    embeddings: { async embedQuery() { return [0.1, 0.2]; } },
    collectionName: "ebook_collection",
    embeddingDimension: 2,
    nprobe: 8,
  });

  const result = await retriever.searchWithTrace("问题", { k: 4, bookId: "1" });
  const documents = result.documents;
  assert.equal(request.filter, 'book_id == "1"');
  assert.equal(request.limit, 4);
  assert.deepEqual(request.params, { nprobe: 8 });
  assert.equal(documents[0].chapterNum, 2);
  assert.equal(documents[0].content, "测试片段");
  assert.ok(result.retrieval.embeddingDurationMs >= 0);
  assert.ok(result.retrieval.vectorSearchDurationMs >= 0);
  assert.ok(result.retrieval.totalDurationMs >= 0);
});

test("MilvusBookRetriever rejects embedding dimension mismatch", async () => {
  const retriever = new MilvusBookRetriever({
    client: { async search() { throw new Error("should not run"); } },
    embeddings: { async embedQuery() { return [0.1]; } },
    collectionName: "ebook_collection",
    embeddingDimension: 2,
  });

  await assert.rejects(
    retriever.search("问题", { bookId: "1" }),
    /Embedding 维度不匹配/,
  );
});
