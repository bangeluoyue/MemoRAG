import { MilvusClient } from "@zilliz/milvus2-sdk-node";

const OUTPUT_FIELDS = [
  "id",
  "book_id",
  "book_name",
  "chapter_num",
  "index",
  "content",
];

function assertSuccess(response, action) {
  const status = response?.status;
  if (!status) return;

  const succeeded = status.error_code === "Success" || status.code === 0;
  if (!succeeded) {
    throw new Error(`${action}失败：${status.reason || status.error_code || "未知错误"}`);
  }
}

function safeStringLiteral(value, fieldName) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${fieldName} 不能为空`);
  if (!/^[\w.:-]+$/u.test(text)) {
    throw new Error(`${fieldName} 包含不支持的字符`);
  }
  return JSON.stringify(text);
}

export function createMilvusClient({ address, token }) {
  return new MilvusClient({
    address,
    ...(token ? { token } : {}),
  });
}

export async function inspectCollection(client, collectionName) {
  const [description, statistics, indexes, loadState] = await Promise.all([
    client.describeCollection({ collection_name: collectionName }),
    client.getCollectionStatistics({ collection_name: collectionName }),
    client.describeIndex({ collection_name: collectionName }),
    client.getLoadState({ collection_name: collectionName }),
  ]);

  assertSuccess(description, `读取 Collection ${collectionName} Schema`);
  assertSuccess(statistics, `读取 Collection ${collectionName} 统计信息`);
  assertSuccess(indexes, `读取 Collection ${collectionName} 索引`);
  assertSuccess(loadState, `读取 Collection ${collectionName} 加载状态`);

  return {
    name: collectionName,
    fields: (description.schema?.fields ?? []).map((field) => ({
      name: field.name,
      type: field.data_type,
      primaryKey: Boolean(field.is_primary_key),
      dimension: field.dim ? Number(field.dim) : undefined,
      maxLength: field.max_length ? Number(field.max_length) : undefined,
    })),
    rowCount: Number(statistics.data?.row_count ?? 0),
    loadState: loadState.state,
    indexes: (indexes.index_descriptions ?? []).map((index) => ({
      name: index.index_name,
      field: index.field_name,
      state: index.state,
      indexedRows: Number(index.indexed_rows ?? 0),
      totalRows: Number(index.total_rows ?? 0),
      params: Object.fromEntries(
        (index.params ?? []).map(({ key, value }) => [key, value]),
      ),
    })),
  };
}

export class MilvusBookRetriever {
  constructor({
    client,
    embeddings,
    collectionName,
    embeddingDimension,
    nprobe = 16,
  }) {
    this.client = client;
    this.embeddings = embeddings;
    this.collectionName = collectionName;
    this.embeddingDimension = embeddingDimension;
    this.nprobe = nprobe;
  }

  async search(query, { k = 5, bookId } = {}) {
    const result = await this.searchWithTrace(query, { k, bookId });
    return result.documents;
  }

  async searchWithTrace(query, { k = 5, bookId } = {}) {
    const text = String(query ?? "").trim();
    if (!text) {
      return {
        documents: [],
        rerank: null,
        retrieval: {
          embeddingDurationMs: 0,
          vectorSearchDurationMs: 0,
          totalDurationMs: 0,
        },
      };
    }

    const startedAt = Date.now();
    const embeddingStartedAt = Date.now();
    const vector = await this.embeddings.embedQuery(text);
    const embeddingDurationMs = Date.now() - embeddingStartedAt;
    if (vector.length !== this.embeddingDimension) {
      throw new Error(
        `Embedding 维度不匹配：模型返回 ${vector.length}，配置为 ${this.embeddingDimension}`,
      );
    }

    const vectorSearchStartedAt = Date.now();
    const response = await this.client.search({
      collection_name: this.collectionName,
      data: vector,
      anns_field: "vector",
      limit: k,
      filter: `book_id == ${safeStringLiteral(bookId, "bookId")}`,
      output_fields: OUTPUT_FIELDS,
      metric_type: "COSINE",
      params: { nprobe: this.nprobe },
    });
    const vectorSearchDurationMs = Date.now() - vectorSearchStartedAt;

    assertSuccess(response, `检索 Collection ${this.collectionName}`);

    const documents = (response.results ?? []).map((hit) => ({
      id: String(hit.id),
      score: Number(hit.score),
      bookId: String(hit.book_id),
      bookName: String(hit.book_name),
      chapterNum: Number(hit.chapter_num),
      chunkIndex: Number(hit.index),
      content: String(hit.content ?? ""),
    }));
    return {
      documents,
      rerank: null,
      retrieval: {
        embeddingDurationMs,
        vectorSearchDurationMs,
        totalDurationMs: Date.now() - startedAt,
      },
    };
  }
}
