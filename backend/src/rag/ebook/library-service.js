import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ConsistencyLevelEnum } from "@zilliz/milvus2-sdk-node";
import { createEbookIngestion, EbookIngestionError } from "./ingestion/index.js";
import { EpubInputError } from "./ingestion/epub-loader.js";
import { createMilvusClient } from "./milvus-retriever.js";

const SAFE_BOOK_ID = /^[\w.:-]+$/u;
const BOOK_LIST_BATCH_SIZE = 1000;
const ALLOWED_MIME_TYPES = new Set([
  "",
  "application/epub+zip",
  "application/octet-stream",
  "application/zip",
]);

export class EbookLibraryError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "EbookLibraryError";
    this.code = code;
  }
}

function assertMilvusSuccess(response, message) {
  const status = response?.status;
  if (!status) return;
  if (status.error_code !== "Success" && status.code !== 0) {
    throw new EbookLibraryError("BOOK_METADATA_READ_FAILED", message);
  }
}

function bookIdLiteral(value) {
  const bookId = String(value ?? "").trim();
  if (!bookId || bookId.length > 128 || !SAFE_BOOK_ID.test(bookId)) {
    throw new EbookLibraryError("INPUT_INVALID", "bookId 无效");
  }
  return { bookId, literal: JSON.stringify(bookId) };
}

function validateUpload({ fileName, mimeType, bytes, maxBytes }) {
  const safeName = basename(String(fileName ?? "").trim());
  if (!safeName || !safeName.toLowerCase().endsWith(".epub")) {
    throw new EbookLibraryError("EPUB_FILE_INVALID", "只允许上传 .epub 文件");
  }
  const normalizedMime = String(mimeType ?? "").split(";", 1)[0].trim().toLowerCase();
  if (!ALLOWED_MIME_TYPES.has(normalizedMime)) {
    throw new EbookLibraryError("EPUB_FILE_INVALID", "上传文件类型不是 EPUB");
  }
  if (!Buffer.isBuffer(bytes) || !bytes.length) {
    throw new EbookLibraryError("EPUB_FILE_INVALID", "EPUB 文件不能为空");
  }
  if (bytes.length > maxBytes) {
    throw new EbookLibraryError("EPUB_FILE_TOO_LARGE", "EPUB 文件超过大小限制");
  }
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new EbookLibraryError("EPUB_FILE_INVALID", "EPUB 文件内容无效");
  }
  return safeName;
}

export function createEbookLibrary(options = {}) {
  const config = options.config;
  if (!config?.milvus || !config?.model) {
    throw new Error("createEbookLibrary 缺少 model/milvus 配置");
  }
  const ownedClient = !options.client;
  const client = options.client ?? createMilvusClient(config.milvus);
  const ingestion = options.ingestion ?? createEbookIngestion({ config, client });
  const maxBytes = Number(options.maxBytes ?? config.uploads?.epubMaxBytes ?? 25 * 1024 * 1024);

  return {
    async listBooks() {
      const books = new Map();
      try {
        const iterator = await client.queryIterator({
          collection_name: config.milvus.collectionName,
          filter: 'book_id != ""',
          output_fields: ["id", "book_id", "book_name"],
          batchSize: BOOK_LIST_BATCH_SIZE,
          consistency_level: ConsistencyLevelEnum.Strong,
        });
        for await (const batch of iterator) {
          for (const row of batch ?? []) {
            const bookId = String(row?.book_id ?? "").trim();
            const bookName = String(row?.book_name ?? "").trim();
            if (!bookId || !bookName) continue;
            const existing = books.get(bookId);
            if (existing && existing.bookName !== bookName) {
              throw new EbookLibraryError(
                "BOOK_METADATA_INVALID",
                "同一 bookId 存在不一致的书籍名称",
              );
            }
            books.set(bookId, { bookId, bookName });
          }
        }
      } catch (error) {
        if (error instanceof EbookLibraryError) throw error;
        throw new EbookLibraryError(
          "BOOK_LIST_READ_FAILED",
          "无法读取 EPUB 书籍列表",
          { cause: error },
        );
      }
      return [...books.values()].sort((left, right) => (
        left.bookId.localeCompare(right.bookId, "zh-CN", { numeric: true })
      ));
    },

    async getBookMetadata(value) {
      const { bookId, literal } = bookIdLiteral(value);
      const response = await client.query({
        collection_name: config.milvus.collectionName,
        filter: `book_id == ${literal}`,
        output_fields: ["book_id", "book_name"],
        limit: 16,
        consistency_level: ConsistencyLevelEnum.Strong,
      });
      assertMilvusSuccess(response, "无法读取 EPUB 书籍信息");
      const rows = (response?.data ?? []).filter(
        (row) => String(row.book_id ?? "") === bookId,
      );
      if (!rows.length) return null;
      const names = [...new Set(rows
        .map((row) => String(row.book_name ?? "").trim())
        .filter(Boolean))];
      if (!names.length) {
        throw new EbookLibraryError("BOOK_METADATA_INVALID", "EPUB 书籍名称缺失");
      }
      if (names.length > 1) {
        throw new EbookLibraryError("BOOK_METADATA_INVALID", "同一 bookId 存在不一致的书籍名称");
      }
      return { bookId, bookName: names[0] };
    },

    async upload({ fileName, mimeType, bytes }) {
      const safeName = validateUpload({ fileName, mimeType, bytes, maxBytes });
      const digest = createHash("sha256").update(bytes).digest("hex");
      const bookId = `epub-${digest.slice(0, 24)}`;
      const directory = await mkdtemp(join(tmpdir(), "memorag-epub-"));
      const filePath = join(directory, safeName);
      try {
        await writeFile(filePath, bytes, { flag: "wx", mode: 0o600 });
        const result = await ingestion.ingest({
          filePath,
          bookId,
          onDuplicate: "resume",
        });
        return {
          status: result.status,
          bookId: result.bookId,
          bookName: result.bookName,
          chapterCount: result.chapterCount,
          chunkCount: result.chunkCount,
          insertedCount: result.insertedCount,
          existingCount: result.existingCount,
        };
      } catch (error) {
        if (error instanceof EbookIngestionError || error instanceof EpubInputError) {
          throw error;
        }
        throw new EbookLibraryError(
          "EPUB_UPLOAD_FAILED",
          "EPUB 解析或入库失败",
          { cause: error },
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },

    async close() {
      await ingestion.close?.();
      if (ownedClient && typeof client.closeConnection === "function") {
        await client.closeConnection();
      }
    },
  };
}
