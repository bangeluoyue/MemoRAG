import { OpenAIEmbeddings } from "@langchain/openai";
import { getConfig } from "../../config.js";
import { createLangSmithObservability } from "../../observability/langsmith.js";
import { createMilvusClient } from "../ebook/milvus-retriever.js";
import { DashScopeReranker } from "../shared/dashscope-reranker.js";
import {
  createElasticsearchClient,
  ElasticsearchNotesRetriever,
} from "./elasticsearch-retriever.js";
import { HybridNotesRetriever } from "./hybrid-retriever.js";
import { MilvusNotesRetriever } from "./milvus-retriever.js";

export function createNotesRetriever(options = {}) {
  const config = options.config ?? getConfig();
  const observability = options.observability ?? createLangSmithObservability(
    config.langsmith,
    { client: options.langsmithClient },
  );
  const embeddings = options.embeddings ?? (options.milvusRetriever
    ? null
    : new OpenAIEmbeddings({
      model: config.model.embeddingModel,
      apiKey: config.model.apiKey,
      dimensions: config.model.embeddingDimension,
      configuration: config.model.baseUrl
        ? { baseURL: config.model.baseUrl }
        : undefined,
    }));
  const elasticsearchClient = options.elasticsearchClient
    ?? (options.elasticsearchRetriever
      ? null
      : createElasticsearchClient(config.notes.elasticsearch));
  const milvusClient = options.milvusClient
    ?? (options.milvusRetriever ? null : createMilvusClient(config.milvus));
  const elasticsearchRetriever = options.elasticsearchRetriever
    ?? new ElasticsearchNotesRetriever({
      client: elasticsearchClient,
      indexName: config.notes.elasticsearch.indexName,
    });
  const milvusRetriever = options.milvusRetriever ?? new MilvusNotesRetriever({
    client: milvusClient,
    embeddings,
    collectionName: config.notes.milvus.collectionName,
    embeddingDimension: config.model.embeddingDimension,
    nprobe: config.milvus.nprobe,
  });
  const reranker = config.notes.rerankEnabled
    ? (options.reranker ?? new DashScopeReranker({
      apiKey: config.rerank.apiKey,
      model: config.rerank.model,
      baseUrl: config.rerank.url,
      timeoutMs: config.rerank.timeoutMs,
    }))
    : null;

  return new HybridNotesRetriever({
    elasticsearchRetriever,
    milvusRetriever,
    reranker,
    keywordK: config.notes.keywordK,
    vectorK: config.notes.vectorK,
    rerankFailureMode: config.rerank.failureMode,
    observability,
    async closeResources() {
      try {
        if (!options.elasticsearchClient
          && typeof elasticsearchClient?.close === "function") {
          await elasticsearchClient.close();
        }
        if (!options.milvusClient
          && typeof milvusClient?.closeConnection === "function") {
          await milvusClient.closeConnection();
        }
      } finally {
        if (!options.observability) await observability.close();
      }
    },
  });
}

export {
  createElasticsearchClient,
  ElasticsearchNotesRetriever,
  HybridNotesRetriever,
  MilvusNotesRetriever,
};
export { AgentNotesRetriever } from "./agent-retriever.js";
