import { basename, extname } from "node:path";
import { OpenAIEmbeddings } from "@langchain/openai";
import { createMilvusClient } from "../milvus-retriever.js";
import {
  DEFAULT_EPUB_CHUNK_OVERLAP,
  DEFAULT_EPUB_CHUNK_SIZE,
  chunkEpubChapters,
} from "./chunker.js";
import { loadEpubChapters } from "./epub-loader.js";
import {
  DEFAULT_EPUB_INGEST_BATCH_SIZE,
  DUPLICATE_POLICIES,
  EbookIngestionError,
  MAX_EPUB_EMBEDDING_BATCH_SIZE,
  MilvusEbookWriter,
} from "./milvus-writer.js";
import { DEFAULT_LLM_TIMEOUT_MS } from "../../shared/timeouts.js";

function fallbackBookName(filePath) {
  return basename(String(filePath ?? ""), extname(String(filePath ?? ""))).trim();
}

export async function prepareEpubIngestion({
  filePath,
  bookId,
  bookName,
  chunkSize = DEFAULT_EPUB_CHUNK_SIZE,
  chunkOverlap = DEFAULT_EPUB_CHUNK_OVERLAP,
}, {
  loadEpub = loadEpubChapters,
  splitter,
} = {}) {
  const normalizedBookId = String(bookId ?? "").trim();
  if (!normalizedBookId) throw new Error("bookId 不能为空");
  if (!/^[\w.:-]+$/u.test(normalizedBookId)) {
    throw new Error("bookId 包含与现有 Retriever 不兼容的字符");
  }
  const parsed = await loadEpub(filePath);
  const resolvedBookName = String(bookName ?? "").trim()
    || String(parsed.metadata?.title ?? "").trim()
    || fallbackBookName(parsed.filePath ?? filePath);
  if (!resolvedBookName) throw new Error("bookName 不能为空");
  const records = await chunkEpubChapters(parsed.chapters, {
    bookId: normalizedBookId,
    chunkSize,
    chunkOverlap,
    splitter,
  });

  return {
    filePath: parsed.filePath,
    fileName: parsed.fileName,
    bookId: normalizedBookId,
    bookName: resolvedBookName,
    spineCount: parsed.spineCount,
    chapterCount: parsed.chapters.length,
    emptyChapterCount: parsed.emptyChapterCount,
    chunkSize: Number(chunkSize),
    chunkOverlap: Number(chunkOverlap),
    chunkCount: records.length,
    records,
  };
}

export function createEbookEmbeddingClient(modelConfig) {
  return new OpenAIEmbeddings({
    model: modelConfig.embeddingModel,
    apiKey: modelConfig.apiKey,
    dimensions: modelConfig.embeddingDimension,
    batchSize: MAX_EPUB_EMBEDDING_BATCH_SIZE,
    timeout: modelConfig.requestTimeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
    maxRetries: modelConfig.maxRetries ?? 0,
    configuration: modelConfig.baseUrl
      ? { baseURL: modelConfig.baseUrl }
      : undefined,
  });
}

export function createEbookIngestion({
  config,
  client,
  embeddings,
  loadEpub = loadEpubChapters,
  splitter,
} = {}) {
  if (!config?.model || !config?.milvus) {
    throw new Error("createEbookIngestion 缺少 model/milvus 配置");
  }
  const ownedClient = !client;
  const milvusClient = client ?? createMilvusClient(config.milvus);
  const embeddingClient = embeddings ?? createEbookEmbeddingClient(config.model);
  const writer = new MilvusEbookWriter({
    client: milvusClient,
    embeddings: embeddingClient,
    collectionName: config.milvus.collectionName,
    embeddingDimension: config.model.embeddingDimension,
  });

  return {
    async prepare(options) {
      return prepareEpubIngestion(options, { loadEpub, splitter });
    },

    async ingestPrepared(prepared, options = {}) {
      const result = await writer.write({
        records: prepared.records,
        bookId: prepared.bookId,
        bookName: prepared.bookName,
        batchSize: options.batchSize ?? DEFAULT_EPUB_INGEST_BATCH_SIZE,
        onDuplicate: options.onDuplicate ?? "skip",
      });
      return {
        ...result,
        bookId: prepared.bookId,
        bookName: prepared.bookName,
        collectionName: config.milvus.collectionName,
        chapterCount: prepared.chapterCount,
        chunkCount: prepared.chunkCount,
      };
    },

    async ingest(options) {
      const prepared = await this.prepare(options);
      return this.ingestPrepared(prepared, options);
    },

    async close() {
      if (ownedClient && typeof milvusClient.closeConnection === "function") {
        await milvusClient.closeConnection();
      }
    },
  };
}

export {
  DEFAULT_EPUB_CHUNK_OVERLAP,
  DEFAULT_EPUB_CHUNK_SIZE,
  DEFAULT_EPUB_INGEST_BATCH_SIZE,
  MAX_EPUB_EMBEDDING_BATCH_SIZE,
  DUPLICATE_POLICIES,
  EbookIngestionError,
  MilvusEbookWriter,
  chunkEpubChapters,
  loadEpubChapters,
};
