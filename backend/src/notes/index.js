import { Pool } from "pg";
import { OpenAIEmbeddings } from "@langchain/openai";
import { getConfig } from "../config.js";
import { createMilvusClient } from "../rag/ebook/milvus-retriever.js";
import { createElasticsearchClient } from "../rag/notes/elasticsearch-retriever.js";
import { NotesIndexSynchronizer } from "./index-synchronizer.js";
import { PostgresNotesRepository } from "./repository.js";
import { NotesService } from "./service.js";

export function createNotesService(options = {}) {
  const needsRepository = !options.repository;
  const needsSynchronizer = !options.synchronizer;
  const config = options.config
    ?? (needsRepository || needsSynchronizer ? getConfig() : null);
  const ownsPool = needsRepository && !options.pool;
  const ownsElasticsearchClient = needsSynchronizer && !options.elasticsearchClient;
  const ownsMilvusClient = needsSynchronizer && !options.milvusClient;
  if (ownsPool && !config.notes.postgres.connectionString) {
    throw new Error("生活笔记存储缺少必要环境变量：DATABASE_URL");
  }

  const pool = options.pool ?? (needsRepository
    ? new Pool({
      connectionString: config.notes.postgres.connectionString,
      ssl: config.notes.postgres.ssl || undefined,
    })
    : null);
  const elasticsearchClient = options.elasticsearchClient ?? (needsSynchronizer
    ? createElasticsearchClient(config.notes.elasticsearch)
    : null);
  const milvusClient = options.milvusClient ?? (needsSynchronizer
    ? createMilvusClient(config.milvus)
    : null);
  const embeddings = options.embeddings ?? (needsSynchronizer
    ? new OpenAIEmbeddings({
      model: config.model.embeddingModel,
      apiKey: config.model.apiKey,
      dimensions: config.model.embeddingDimension,
      configuration: config.model.baseUrl
        ? { baseURL: config.model.baseUrl }
        : undefined,
    })
    : null);
  const repository = options.repository ?? new PostgresNotesRepository({ pool });
  const synchronizer = options.synchronizer ?? new NotesIndexSynchronizer({
    elasticsearchClient,
    elasticsearchIndex: config.notes.elasticsearch.indexName,
    milvusClient,
    milvusCollection: config.notes.milvus.collectionName,
    embeddings,
    embeddingDimension: config.model.embeddingDimension,
  });

  return new NotesService({
    repository,
    synchronizer,
    async closeResources() {
      const closers = [];
      if (ownsPool && typeof pool?.end === "function") closers.push(pool.end());
      if (ownsElasticsearchClient && typeof elasticsearchClient?.close === "function") {
        closers.push(elasticsearchClient.close());
      }
      if (ownsMilvusClient && typeof milvusClient?.closeConnection === "function") {
        closers.push(milvusClient.closeConnection());
      }
      await Promise.allSettled(closers);
    },
  });
}

export { NotesIndexSynchronizer, NotesService, PostgresNotesRepository };
export {
  NOTE_KNOWLEDGE_BASE,
  NotesServiceError,
  validateNotesCommandInput,
} from "./service.js";
