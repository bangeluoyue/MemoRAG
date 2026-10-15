import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { createEbookLibrary, EbookLibraryError } from "../src/rag/ebook/library-service.js";

const config = {
  model: { embeddingDimension: 3 },
  milvus: { collectionName: "ebook_collection" },
  uploads: { epubMaxBytes: 1024 },
};

test("book list uses the Milvus query iterator, deduplicates book IDs, and reads no content", async () => {
  const calls = [];
  const client = {
    async queryIterator(input) {
      calls.push(input);
      return (async function* pages() {
        yield [
          { id: "chunk-1", book_id: "book-2", book_name: "第二本书" },
          { id: "chunk-2", book_id: "1", book_name: "第一本书" },
        ];
        yield [
          { id: "chunk-3", book_id: "1", book_name: "第一本书" },
          { id: "chunk-4", book_id: "", book_name: "忽略" },
        ];
      }());
    },
  };
  const library = createEbookLibrary({
    config,
    client,
    ingestion: { async close() {} },
  });

  assert.deepEqual(await library.listBooks(), [
    { bookId: "1", bookName: "第一本书" },
    { bookId: "book-2", bookName: "第二本书" },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].collection_name, "ebook_collection");
  assert.equal(calls[0].batchSize, 1000);
  assert.equal(calls[0].filter, 'book_id != ""');
  assert.deepEqual(calls[0].output_fields, ["id", "book_id", "book_name"]);
  assert.equal(calls[0].output_fields.includes("content"), false);
  assert.equal(calls[0].output_fields.includes("vector"), false);
});

test("book list rejects inconsistent names for the same book ID", async () => {
  const library = createEbookLibrary({
    config,
    client: {
      async queryIterator() {
        return (async function* pages() {
          yield [
            { id: "chunk-1", book_id: "1", book_name: "第一版" },
            { id: "chunk-2", book_id: "1", book_name: "冲突版" },
          ];
        }());
      },
    },
    ingestion: { async close() {} },
  });

  await assert.rejects(
    library.listBooks(),
    (error) => error instanceof EbookLibraryError
      && error.code === "BOOK_METADATA_INVALID",
  );
});

test("book metadata uses an exact scoped Milvus query and reports missing books", async () => {
  const calls = [];
  const client = {
    async query(input) {
      calls.push(input);
      return input.filter.includes('"book-1"')
        ? { data: [{ book_id: "book-1", book_name: "测试书" }] }
        : { data: [] };
    },
  };
  const library = createEbookLibrary({
    config,
    client,
    ingestion: { async close() {} },
  });
  assert.deepEqual(await library.getBookMetadata("book-1"), {
    bookId: "book-1",
    bookName: "测试书",
  });
  assert.equal(await library.getBookMetadata("book-2"), null);
  assert.deepEqual(calls[0].output_fields, ["book_id", "book_name"]);
  assert.equal(calls[0].collection_name, "ebook_collection");
  assert.match(calls[0].filter, /^book_id == /u);
  assert.equal("search" in client, false);
});

test("EPUB upload generates a stable bookId and delegates append-only resume ingestion", async () => {
  let captured;
  const ingestion = {
    async ingest(input) {
      captured = { ...input, bytes: await readFile(input.filePath) };
      return {
        status: "inserted",
        bookId: input.bookId,
        bookName: "EPUB 元数据书名",
        chapterCount: 2,
        chunkCount: 4,
        insertedCount: 4,
        existingCount: 0,
      };
    },
    async close() {},
  };
  const library = createEbookLibrary({ config, client: { query() {} }, ingestion });
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
  const result = await library.upload({
    fileName: "demo.epub",
    mimeType: "application/epub+zip",
    bytes,
  });
  assert.match(result.bookId, /^epub-[a-f0-9]{24}$/u);
  assert.equal(result.bookName, "EPUB 元数据书名");
  assert.equal(captured.bookId, result.bookId);
  assert.equal(captured.onDuplicate, "resume");
  assert.deepEqual(captured.bytes, bytes);
  await assert.rejects(access(captured.filePath));
  assert.equal("bookName" in captured, false);
});

test("EPUB upload rejects invalid files before ingestion and cleans temporary files on failure", async () => {
  let calls = 0;
  let failedPath;
  const library = createEbookLibrary({
    config,
    client: { query() {} },
    ingestion: {
      async ingest(input) {
        calls += 1;
        failedPath = input.filePath;
        throw new Error("parser detail");
      },
      async close() {},
    },
  });
  await assert.rejects(
    library.upload({ fileName: "bad.txt", mimeType: "text/plain", bytes: Buffer.from("x") }),
    (error) => error instanceof EbookLibraryError && error.code === "EPUB_FILE_INVALID",
  );
  await assert.rejects(
    library.upload({ fileName: "bad.epub", mimeType: "application/epub+zip", bytes: Buffer.from("not zip") }),
    (error) => error.code === "EPUB_FILE_INVALID",
  );
  await assert.rejects(
    library.upload({
      fileName: "broken.epub",
      mimeType: "application/epub+zip",
      bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    }),
    (error) => error.code === "EPUB_UPLOAD_FAILED" && !error.message.includes("parser detail"),
  );
  assert.equal(calls, 1);
  await assert.rejects(access(failedPath));
});
