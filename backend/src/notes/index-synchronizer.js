import { NOTE_KNOWLEDGE_BASE } from "./repository.js";

function safeStringLiteral(value, fieldName) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${fieldName} 不能为空`);
  if (!/^[\w.:-]+$/u.test(text)) {
    throw new Error(`${fieldName} 包含不支持的字符`);
  }
  return JSON.stringify(text);
}

function assertMilvusSuccess(response) {
  const status = response?.status;
  if (!status) return;
  if (status.error_code !== "Success" && status.code !== 0) {
    throw new Error("Milvus 笔记索引同步失败");
  }
}

async function settleTarget(target, operation) {
  try {
    await operation();
    return [target, { status: "synced", errorCategory: null }];
  } catch {
    return [target, {
      status: "failed",
      errorCategory: `${target.toUpperCase()}_SYNC_FAILED`,
    }];
  }
}

function summarize(operation, entries) {
  const targets = Object.fromEntries(entries);
  const errorCategories = entries
    .map(([, result]) => result.errorCategory)
    .filter(Boolean);
  return {
    status: errorCategories.length ? "failed" : "synced",
    operation,
    targets,
    errorCategories,
  };
}

export class NotesIndexSynchronizer {
  constructor({
    elasticsearchClient,
    elasticsearchIndex,
    milvusClient,
    milvusCollection,
    embeddings,
    embeddingDimension,
  }) {
    if (!elasticsearchClient || !milvusClient || !embeddings) {
      throw new Error("NotesIndexSynchronizer 缺少索引或 Embedding 客户端");
    }
    this.elasticsearchClient = elasticsearchClient;
    this.elasticsearchIndex = elasticsearchIndex;
    this.milvusClient = milvusClient;
    this.milvusCollection = milvusCollection;
    this.embeddings = embeddings;
    this.embeddingDimension = embeddingDimension;
  }

  async upsert(note) {
    const document = {
      note_id: note.noteId,
      user_id: note.userId,
      knowledge_base: NOTE_KNOWLEDGE_BASE,
      title: note.title,
      content: note.content,
    };
    const entries = await Promise.all([
      settleTarget("elasticsearch", async () => {
        await this.elasticsearchClient.index({
          index: this.elasticsearchIndex,
          id: note.noteId,
          document,
        });
      }),
      settleTarget("milvus", async () => {
        const vector = await this.embeddings.embedQuery(note.content);
        if (!Array.isArray(vector)
          || vector.length !== this.embeddingDimension
          || vector.some((value) => !Number.isFinite(value))) {
          throw new Error("Embedding 向量不合法");
        }
        const response = await this.milvusClient.upsert({
          collection_name: this.milvusCollection,
          data: [{ ...document, metadata: {}, vector }],
        });
        assertMilvusSuccess(response);
      }),
    ]);
    return summarize("upsert", entries);
  }

  async delete(note) {
    const filter = [
      `note_id == ${safeStringLiteral(note.noteId, "noteId")}`,
      `user_id == ${safeStringLiteral(note.userId, "userId")}`,
      `knowledge_base == ${safeStringLiteral(NOTE_KNOWLEDGE_BASE, "knowledgeBase")}`,
    ].join(" && ");
    const entries = await Promise.all([
      settleTarget("elasticsearch", async () => {
        const response = await this.elasticsearchClient.deleteByQuery({
          index: this.elasticsearchIndex,
          query: {
            bool: {
              filter: [
                { term: { note_id: note.noteId } },
                { term: { user_id: note.userId } },
                { term: { knowledge_base: NOTE_KNOWLEDGE_BASE } },
              ],
            },
          },
        });
        if (response?.failures?.length) {
          throw new Error("Elasticsearch 笔记索引删除不完整");
        }
      }),
      settleTarget("milvus", async () => {
        const response = await this.milvusClient.delete({
          collection_name: this.milvusCollection,
          filter,
        });
        assertMilvusSuccess(response);
      }),
    ]);
    return summarize("delete", entries);
  }
}
