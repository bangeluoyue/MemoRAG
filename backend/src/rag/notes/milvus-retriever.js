import {
  KNOWLEDGE_BASES,
  createRetrievalDocument,
  matchesRetrievalScope,
  positiveResultLimit,
  validateRetrievalScope,
} from "../retrieval/index.js";

const OUTPUT_FIELDS = [
  "note_id",
  "user_id",
  "knowledge_base",
  "content",
  "title",
  "metadata",
];

function safeStringLiteral(value, fieldName) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${fieldName} 不能为空`);
  if (!/^[\w.:-]+$/u.test(text)) {
    throw new Error(`${fieldName} 包含不支持的字符`);
  }
  return JSON.stringify(text);
}

function assertSuccess(response) {
  const status = response?.status;
  if (!status) return;
  if (status.error_code !== "Success" && status.code !== 0) {
    throw new Error("Milvus 生活笔记检索失败");
  }
}

function normalizeMetadata(hit) {
  const metadata = hit?.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    return { ...metadata, title: hit?.title };
  }
  return { title: hit?.title };
}

function numericScore(value) {
  if (value == null || value === "") return null;
  const score = Number(value);
  return Number.isFinite(score) ? score : null;
}

export class MilvusNotesRetriever {
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

  async search(query, options = {}) {
    const result = await this.searchWithTrace(query, options);
    return result.documents;
  }

  async searchWithTrace(query, { k = 20, scope } = {}) {
    const resolvedScope = validateRetrievalScope(
      scope,
      KNOWLEDGE_BASES.LIFE_NOTES,
    );
    const rawQuery = String(query ?? "");
    if (!rawQuery.trim()) {
      return {
        documents: [],
        diagnostics: { returnedCount: 0, missingLogicalIdCount: 0, scopeFilteredCount: 0 },
      };
    }

    const vector = await this.embeddings.embedQuery(rawQuery);
    if (vector.length !== this.embeddingDimension) {
      throw new Error(
        `Embedding 维度不匹配：模型返回 ${vector.length}，配置为 ${this.embeddingDimension}`,
      );
    }

    const limit = positiveResultLimit(k, 20);
    const response = await this.client.search({
      collection_name: this.collectionName,
      data: vector,
      anns_field: "vector",
      limit,
      filter: [
        `knowledge_base == ${safeStringLiteral(resolvedScope.knowledgeBase, "knowledgeBase")}`,
        `user_id == ${safeStringLiteral(resolvedScope.userId, "userId")}`,
      ].join(" && "),
      output_fields: OUTPUT_FIELDS,
      metric_type: "COSINE",
      params: { nprobe: this.nprobe },
    });
    assertSuccess(response);

    let missingLogicalIdCount = 0;
    let scopeFilteredCount = 0;
    const documents = [];
    for (const hit of response?.results ?? []) {
      const id = String(hit?.note_id ?? "").trim();
      if (!id) {
        missingLogicalIdCount += 1;
        continue;
      }
      const document = createRetrievalDocument({
        id,
        knowledgeBase: String(hit?.knowledge_base ?? ""),
        userId: String(hit?.user_id ?? ""),
        content: hit?.content,
        metadata: normalizeMetadata(hit),
        scores: { vector: hit?.score },
        provenance: [{
          source: "milvus",
          score: numericScore(hit?.score),
        }],
      });
      if (!matchesRetrievalScope(document, resolvedScope)) {
        scopeFilteredCount += 1;
        continue;
      }
      documents.push(document);
    }

    return {
      documents,
      diagnostics: {
        returnedCount: documents.length,
        missingLogicalIdCount,
        scopeFilteredCount,
      },
    };
  }
}
