import test from "node:test";
import assert from "node:assert/strict";
import { DataType } from "@zilliz/milvus2-sdk-node";
import {
  chunkEpubChapters,
  createEbookChunkId,
} from "../src/rag/ebook/ingestion/chunker.js";
import {
  EpubInputError,
  loadEpubChapters,
  validateEpubPath,
} from "../src/rag/ebook/ingestion/epub-loader.js";
import {
  createEbookEmbeddingClient,
  createEbookIngestion,
  prepareEpubIngestion,
} from "../src/rag/ebook/ingestion/index.js";
import {
  DEFAULT_EPUB_INGEST_BATCH_SIZE,
  EbookIngestionError,
  MAX_EPUB_EMBEDDING_BATCH_SIZE,
  MilvusEbookWriter,
} from "../src/rag/ebook/ingestion/milvus-writer.js";
import {
  main as ingestCli,
  parseIngestArgs,
} from "../src/cli/ingest-epub.js";

const successStatus = { error_code: "Success", code: 0 };

function schema(dimension = 2) {
  return {
    status: successStatus,
    schema: {
      fields: [
        { name: "id", data_type: DataType.VarChar, is_primary_key: true, max_length: 100 },
        { name: "book_id", data_type: DataType.VarChar, max_length: 100 },
        { name: "book_name", data_type: DataType.VarChar, max_length: 200 },
        { name: "chapter_num", data_type: DataType.Int32 },
        { name: "index", data_type: DataType.Int32 },
        { name: "content", data_type: DataType.VarChar, max_length: 10000 },
        { name: "vector", data_type: DataType.FloatVector, dim: dimension },
      ],
    },
  };
}

function record(chapterNum, chunkIndex, content = `content-${chapterNum}-${chunkIndex}`) {
  return {
    id: createEbookChunkId({ bookId: "book-1", chapterNum, chunkIndex, content }),
    bookId: "book-1",
    chapterNum,
    chunkIndex,
    content,
  };
}

function writerFixture({ existing = [], dimension = 2, insert } = {}) {
  const calls = { hasCollection: 0, describeCollection: 0, query: [], insert: [] };
  const client = {
    async hasCollection() {
      calls.hasCollection += 1;
      return { status: successStatus, value: true };
    },
    async describeCollection() {
      calls.describeCollection += 1;
      return schema(dimension);
    },
    async query(request) {
      calls.query.push(request);
      return { status: successStatus, data: existing.map((id) => ({ id })) };
    },
    async insert(request) {
      calls.insert.push(request);
      if (insert) return insert(request, calls.insert.length);
      return { status: successStatus, insert_cnt: request.data.length };
    },
  };
  const embeddingCalls = [];
  const embeddings = {
    async embedDocuments(texts) {
      embeddingCalls.push([...texts]);
      return texts.map((_, index) => [index + 0.1, index + 0.2]);
    },
  };
  return {
    calls,
    embeddingCalls,
    writer: new MilvusEbookWriter({
      client,
      embeddings,
      collectionName: "ebook_collection",
      embeddingDimension: 2,
    }),
  };
}

test("loadEpubChapters reads spine order, extracts text, and destroys parser", async () => {
  let openedPath;
  let destroyed = false;
  const result = await loadEpubChapters("./fixture.epub", {
    statFile: async () => ({ isFile: () => true }),
    openEpub: async (filePath) => {
      openedPath = filePath;
      return {
        getSpine: () => [{ id: "cover" }, { id: "chapter-1" }, { id: "empty" }],
        getMetadata: () => ({ title: "Mock Book" }),
        async loadChapter(id) {
          if (id === "cover") return { html: "<h1>Cover</h1>" };
          if (id === "chapter-1") return { html: "<p>Hello <b>world</b>.</p><p>Next.</p>" };
          return { html: "<img src='cover.jpg'>" };
        },
        destroy() { destroyed = true; },
      };
    },
  });

  assert.equal(openedPath.endsWith("fixture.epub"), true);
  assert.equal(result.metadata.title, "Mock Book");
  assert.equal(result.spineCount, 3);
  assert.equal(result.emptyChapterCount, 1);
  assert.deepEqual(result.chapters.map((chapter) => chapter.chapterNum), [1, 2]);
  assert.match(result.chapters[1].content, /Hello world\.\n\nNext\./);
  assert.equal(destroyed, true);
});

test("EPUB input validation rejects missing files and non-epub paths", async () => {
  await assert.rejects(
    validateEpubPath("book.txt", { statFile: async () => ({ isFile: () => true }) }),
    (error) => error instanceof EpubInputError && error.code === "EPUB_EXTENSION_INVALID",
  );
  await assert.rejects(
    validateEpubPath("missing.epub", { statFile: async () => { throw new Error("private"); } }),
    (error) => error instanceof EpubInputError
      && error.code === "EPUB_FILE_NOT_FOUND"
      && !error.message.includes("private"),
  );
});

test("chunk IDs are deterministic and change with content or position", async () => {
  const splitter = {
    async splitText(text) {
      return text === "chapter one" ? ["alpha", "beta"] : ["gamma"];
    },
  };
  const chapters = [
    { chapterNum: 1, content: "chapter one" },
    { chapterNum: 3, content: "chapter three" },
  ];
  const first = await chunkEpubChapters(chapters, {
    bookId: "book-1",
    chunkSize: 10,
    chunkOverlap: 2,
    splitter,
  });
  const second = await chunkEpubChapters(chapters, {
    bookId: "book-1",
    chunkSize: 10,
    chunkOverlap: 2,
    splitter,
  });

  assert.deepEqual(first, second);
  assert.deepEqual(first.map((item) => [item.chapterNum, item.chunkIndex]), [
    [1, 0], [1, 1], [3, 0],
  ]);
  assert.match(first[0].id, /^ebook_[a-f0-9]{64}$/);
  assert.notEqual(
    first[0].id,
    createEbookChunkId({
      bookId: "book-1",
      chapterNum: 1,
      chunkIndex: 0,
      content: "changed",
    }),
  );
});

test("default recursive splitter creates bounded overlapping EPUB chunks", async () => {
  const records = await chunkEpubChapters([{
    chapterNum: 1,
    content: "第一段文字。第二段文字。第三段文字。",
  }], {
    bookId: "book-1",
    chunkSize: 10,
    chunkOverlap: 2,
  });
  assert.ok(records.length > 1);
  assert.ok(records.every((item) => item.content.length <= 10));
});

test("prepareEpubIngestion resolves book metadata without Embedding or Milvus", async () => {
  const result = await prepareEpubIngestion({
    filePath: "book.epub",
    bookId: "book-1",
    chunkSize: 20,
    chunkOverlap: 2,
  }, {
    loadEpub: async () => ({
      filePath: "/tmp/book.epub",
      fileName: "book.epub",
      metadata: { title: "Metadata Title" },
      spineCount: 1,
      emptyChapterCount: 0,
      chapters: [{ chapterNum: 1, content: "text" }],
    }),
    splitter: { async splitText() { return ["chunk"]; } },
  });

  assert.equal(result.bookName, "Metadata Title");
  assert.equal(result.chapterCount, 1);
  assert.equal(result.chunkCount, 1);
  assert.equal(result.records[0].bookId, "book-1");
});

test("writer refuses missing or incompatible collections without creating them", async () => {
  let describeCalled = false;
  const missing = new MilvusEbookWriter({
    client: {
      async hasCollection() { return { status: successStatus, value: false }; },
      async describeCollection() { describeCalled = true; },
    },
    embeddings: { async embedDocuments() { throw new Error("should not run"); } },
    collectionName: "ebook_collection",
    embeddingDimension: 2,
  });
  await assert.rejects(
    missing.write({ records: [record(1, 0)], bookId: "book-1", bookName: "Book" }),
    (error) => error.code === "COLLECTION_NOT_FOUND",
  );
  assert.equal(describeCalled, false);

  const fixture = writerFixture({ dimension: 3 });
  await assert.rejects(
    fixture.writer.write({ records: [record(1, 0)], bookId: "book-1", bookName: "Book" }),
    (error) => error.code === "COLLECTION_SCHEMA_INCOMPATIBLE",
  );
  assert.equal(fixture.calls.query.length, 0);
  assert.equal(fixture.calls.insert.length, 0);
});

test("complete duplicate import is skipped before Embedding", async () => {
  const records = [record(1, 0), record(1, 1)];
  const fixture = writerFixture({ existing: records.map((item) => item.id) });
  const result = await fixture.writer.write({
    records,
    bookId: "book-1",
    bookName: "Book",
  });

  assert.equal(result.status, "skipped_existing");
  assert.equal(result.insertedCount, 0);
  assert.equal(fixture.embeddingCalls.length, 0);
  assert.equal(fixture.calls.insert.length, 0);
  assert.equal(fixture.calls.query[0].filter, 'book_id == "book-1"');
  assert.equal(fixture.calls.query[0].consistency_level, 0);
});

test("duplicate error policy rejects any existing book data", async () => {
  const records = [record(1, 0)];
  const fixture = writerFixture({ existing: [records[0].id] });
  await assert.rejects(
    fixture.writer.write({
      records,
      bookId: "book-1",
      bookName: "Book",
      onDuplicate: "error",
    }),
    (error) => error.code === "BOOK_ALREADY_EXISTS",
  );
  assert.equal(fixture.embeddingCalls.length, 0);
  assert.equal(fixture.calls.insert.length, 0);
});

test("changed content for an existing bookId is rejected instead of overwritten", async () => {
  const fixture = writerFixture({ existing: ["legacy-or-other-version-id"] });
  await assert.rejects(
    fixture.writer.write({
      records: [record(1, 0)],
      bookId: "book-1",
      bookName: "Book",
      onDuplicate: "resume",
    }),
    (error) => error instanceof EbookIngestionError
      && error.code === "BOOK_VERSION_CONFLICT",
  );
  assert.equal(fixture.embeddingCalls.length, 0);
  assert.equal(fixture.calls.insert.length, 0);
});

test("partial import requires explicit resume and writes only missing chunks in batches", async () => {
  const records = [record(1, 0), record(1, 1), record(2, 0)];
  const skipped = writerFixture({ existing: [records[0].id] });
  await assert.rejects(
    skipped.writer.write({ records, bookId: "book-1", bookName: "Book" }),
    (error) => error.code === "BOOK_PARTIALLY_IMPORTED",
  );
  assert.equal(skipped.embeddingCalls.length, 0);

  const resumed = writerFixture({ existing: [records[0].id] });
  const result = await resumed.writer.write({
    records,
    bookId: "book-1",
    bookName: "Book",
    onDuplicate: "resume",
    batchSize: 1,
  });
  assert.equal(result.status, "resumed");
  assert.equal(result.existingCount, 1);
  assert.equal(result.insertedCount, 2);
  assert.equal(result.batchCount, 2);
  assert.deepEqual(resumed.embeddingCalls, [[records[1].content], [records[2].content]]);
  assert.deepEqual(Object.keys(resumed.calls.insert[0].data[0]), [
    "id", "book_id", "book_name", "chapter_num", "index", "content", "vector",
  ]);
  assert.equal(resumed.calls.insert[0].data[0].book_id, "book-1");
  assert.equal(resumed.calls.insert[0].data[0].index, 1);
});

test("default EPUB Embedding batches split 20 texts into requests of at most 10", async () => {
  const records = Array.from({ length: 20 }, (_, index) => record(1, index));
  const fixture = writerFixture();
  const result = await fixture.writer.write({
    records,
    bookId: "book-1",
    bookName: "Book",
  });

  assert.equal(DEFAULT_EPUB_INGEST_BATCH_SIZE, 10);
  assert.equal(MAX_EPUB_EMBEDDING_BATCH_SIZE, 10);
  assert.deepEqual(fixture.embeddingCalls.map((texts) => texts.length), [10, 10]);
  assert.deepEqual(fixture.calls.insert.map((request) => request.data.length), [10, 10]);
  assert.equal(result.insertedCount, 20);
  assert.equal(result.batchCount, 2);
});

test("EPUB writer refuses a configured batch above the upstream limit", async () => {
  const fixture = writerFixture();
  await assert.rejects(
    fixture.writer.write({
      records: [record(1, 0)],
      bookId: "book-1",
      bookName: "Book",
      batchSize: 11,
    }),
    (error) => error.code === "INPUT_INVALID" && /10/u.test(error.message),
  );
  assert.equal(fixture.embeddingCalls.length, 0);
});

test("Embedding mismatch stops the batch before Milvus insert", async () => {
  const fixture = writerFixture();
  fixture.writer.embeddings = {
    async embedDocuments() { return [[0.1]]; },
  };
  await assert.rejects(
    fixture.writer.write({
      records: [record(1, 0)],
      bookId: "book-1",
      bookName: "Book",
    }),
    (error) => error.code === "EMBEDDING_DIMENSION_MISMATCH",
  );
  assert.equal(fixture.calls.insert.length, 0);
});

test("batch failure reports safe progress for a resumable retry", async () => {
  const records = [record(1, 0), record(1, 1), record(2, 0)];
  const fixture = writerFixture({
    insert: async (request, callNumber) => {
      if (callNumber === 2) throw new TypeError("PRIVATE_MILVUS_DETAIL");
      return { status: successStatus, insert_cnt: request.data.length };
    },
  });
  await assert.rejects(
    fixture.writer.write({
      records,
      bookId: "book-1",
      bookName: "Book",
      batchSize: 2,
    }),
    (error) => error.code === "MILVUS_BATCH_WRITE_FAILED"
      && error.details.insertedCount === 2
      && !error.message.includes("PRIVATE_MILVUS_DETAIL"),
  );
});

test("Embedding batch failure preserves safe diagnostics and confirmed progress", async () => {
  const records = Array.from({ length: 20 }, (_, index) => record(1, index));
  const fixture = writerFixture();
  const embeddingCalls = [];
  fixture.writer.embeddings = {
    async embedDocuments(texts) {
      embeddingCalls.push([...texts]);
      if (embeddingCalls.length === 2) {
        const error = new Error("PRIVATE_RESPONSE_BODY");
        error.name = "BadRequestError";
        error.status = 400;
        throw error;
      }
      return texts.map((_, index) => [index + 0.1, index + 0.2]);
    },
  };

  await assert.rejects(
    fixture.writer.write({ records, bookId: "book-1", bookName: "Book" }),
    (error) => error.code === "EMBEDDING_BATCH_FAILED"
      && error.details.insertedCount === 10
      && error.details.batchIndex === 1
      && error.details.batchNumber === 2
      && error.details.textCount === 10
      && error.details.upstreamHttpStatus === 400
      && error.details.upstreamErrorType === "BadRequestError"
      && Number.isInteger(error.details.durationMs)
      && !error.message.includes("PRIVATE_RESPONSE_BODY"),
  );
  assert.deepEqual(embeddingCalls.map((texts) => texts.length), [10, 10]);
  assert.deepEqual(fixture.calls.insert.map((request) => request.data.length), [10]);
});

test("EPUB Embedding client applies the upstream batch cap, timeout, and retry limit", () => {
  const embeddings = createEbookEmbeddingClient({
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    embeddingModel: "test-embedding",
    embeddingDimension: 2,
    requestTimeoutMs: 12345,
    maxRetries: 1,
  });

  assert.equal(embeddings.batchSize, 10);
  assert.equal(embeddings.timeout, 12345);
  assert.equal(embeddings.caller.maxRetries, 1);
});

test("createEbookIngestion keeps injected clients isolated and close-safe", async () => {
  let closed = false;
  const records = [record(1, 0)];
  const client = writerFixture().writer.client;
  client.closeConnection = async () => { closed = true; };
  const service = createEbookIngestion({
    config: {
      model: { apiKey: "test", embeddingModel: "test", embeddingDimension: 2 },
      milvus: { address: "unused", collectionName: "ebook_collection" },
    },
    client,
    embeddings: { async embedDocuments() { return [[0.1, 0.2]]; } },
  });
  const result = await service.ingestPrepared({
    records,
    bookId: "book-1",
    bookName: "Book",
    chapterCount: 1,
    chunkCount: 1,
  });
  assert.equal(result.status, "inserted");
  await service.close();
  assert.equal(closed, false);
});

test("ingest CLI defaults to dry-run and requires explicit execute", async () => {
  const parsed = parseIngestArgs(["book.epub", "--book-id", "book-1"]);
  assert.equal(parsed.execute, false);
  assert.equal(parsed.onDuplicate, "skip");
  assert.throws(
    () => parseIngestArgs([
      "book.epub", "--book-id", "book-1", "--chunk-size", "10", "--chunk-overlap", "10",
    ]),
    /--chunk-overlap/,
  );
  assert.throws(
    () => parseIngestArgs([
      "book.epub", "--book-id", "book-1", "--batch-size", "11",
    ]),
    /--batch-size 不能超过 10/u,
  );

  let ingestionCalled = false;
  const logs = [];
  const result = await ingestCli(["book.epub", "--book-id", "book-1"], {
    prepare: async () => ({
      fileName: "book.epub",
      bookId: "book-1",
      bookName: "Book",
      spineCount: 2,
      chapterCount: 2,
      chunkCount: 3,
      chunkSize: 500,
      chunkOverlap: 50,
      records: [],
    }),
    ingestion: {
      async ingestPrepared() { ingestionCalled = true; },
      async close() {},
    },
    log: (message) => logs.push(message),
  });
  assert.equal(result.status, "dry_run");
  assert.equal(ingestionCalled, false);
  assert.match(logs.at(-1), /Dry-run/);
});

test("ingest CLI executes only behind --execute and always closes the service", async () => {
  let receivedOptions;
  let closed = false;
  const result = await ingestCli([
    "book.epub",
    "--book-id", "book-1",
    "--execute",
    "--batch-size", "2",
    "--on-duplicate", "resume",
  ], {
    prepare: async () => ({
      fileName: "book.epub",
      bookId: "book-1",
      bookName: "Book",
      spineCount: 1,
      chapterCount: 1,
      chunkCount: 1,
      chunkSize: 500,
      chunkOverlap: 50,
      records: [record(1, 0)],
    }),
    ingestion: {
      async ingestPrepared(plan, options) {
        receivedOptions = { plan, options };
        return { status: "resumed", insertedCount: 1 };
      },
      async close() { closed = true; },
    },
    log() {},
  });

  assert.equal(result.status, "resumed");
  assert.deepEqual(receivedOptions.options, { batchSize: 2, onDuplicate: "resume" });
  assert.equal(closed, true);
});
