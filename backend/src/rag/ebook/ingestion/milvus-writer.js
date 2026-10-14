import { Buffer } from "node:buffer";
import {
  ConsistencyLevelEnum,
  DataType,
} from "@zilliz/milvus2-sdk-node";

export const DEFAULT_EPUB_INGEST_BATCH_SIZE = 20;
export const DUPLICATE_POLICIES = Object.freeze(["skip", "error", "resume"]);

const REQUIRED_FIELDS = Object.freeze({
  id: DataType.VarChar,
  book_id: DataType.VarChar,
  book_name: DataType.VarChar,
  chapter_num: DataType.Int32,
  index: DataType.Int32,
  content: DataType.VarChar,
  vector: DataType.FloatVector,
});

export class EbookIngestionError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "EbookIngestionError";
    this.code = code;
    this.details = options.details ?? null;
  }
}

function safeStringLiteral(value, fieldName) {
  const text = String(value ?? "").trim();
  if (!text) throw new EbookIngestionError("INPUT_INVALID", `${fieldName} 不能为空`);
  if (!/^[\w.:-]+$/u.test(text)) {
    throw new EbookIngestionError("INPUT_INVALID", `${fieldName} 包含不支持的字符`);
  }
  return JSON.stringify(text);
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new EbookIngestionError("INPUT_INVALID", `${name} 必须是正整数`);
  }
  return number;
}

function assertSuccess(response, code, message) {
  const status = response?.status;
  if (!status) return;
  if (status.error_code !== "Success" && status.code !== 0) {
    throw new EbookIngestionError(code, message);
  }
}

function fieldDimension(field) {
  if (field?.dim != null) return Number(field.dim);
  const typeParams = field?.type_params ?? field?.typeParams ?? [];
  const dimension = typeParams.find((item) => item?.key === "dim")?.value;
  return dimension == null ? null : Number(dimension);
}

function fieldMaxLength(field) {
  if (field?.max_length != null) return Number(field.max_length);
  const typeParams = field?.type_params ?? field?.typeParams ?? [];
  const maximum = typeParams.find((item) => item?.key === "max_length")?.value;
  return maximum == null ? null : Number(maximum);
}

function dataTypeMatches(actual, expected) {
  if (Number(actual) === expected) return true;
  const expectedName = Object.entries(DataType)
    .find(([, value]) => value === expected)?.[0];
  return expectedName && String(actual).toLowerCase() === expectedName.toLowerCase();
}

function validateSchema(description, embeddingDimension) {
  assertSuccess(
    description,
    "COLLECTION_SCHEMA_READ_FAILED",
    "无法读取 EPUB Collection Schema",
  );
  const fields = new Map(
    (description?.schema?.fields ?? []).map((field) => [field.name, field]),
  );
  for (const [name, expectedType] of Object.entries(REQUIRED_FIELDS)) {
    const field = fields.get(name);
    if (!field || !dataTypeMatches(field.data_type, expectedType)) {
      throw new EbookIngestionError(
        "COLLECTION_SCHEMA_INCOMPATIBLE",
        `EPUB Collection 字段不兼容：${name}`,
      );
    }
  }
  if (!fields.get("id")?.is_primary_key) {
    throw new EbookIngestionError(
      "COLLECTION_SCHEMA_INCOMPATIBLE",
      "EPUB Collection 的 id 字段必须是主键",
    );
  }
  if (fieldDimension(fields.get("vector")) !== embeddingDimension) {
    throw new EbookIngestionError(
      "COLLECTION_SCHEMA_INCOMPATIBLE",
      `EPUB Collection 向量维度必须为 ${embeddingDimension}`,
    );
  }
  return {
    idMaxLength: fieldMaxLength(fields.get("id")),
    bookIdMaxLength: fieldMaxLength(fields.get("book_id")),
    bookNameMaxLength: fieldMaxLength(fields.get("book_name")),
    contentMaxLength: fieldMaxLength(fields.get("content")),
  };
}

function validateTextLength(value, maximum, fieldName) {
  if (!Number.isFinite(maximum)) return;
  if (Buffer.byteLength(String(value), "utf8") > maximum) {
    throw new EbookIngestionError(
      "FIELD_TOO_LONG",
      `${fieldName} 超过 Collection 允许的最大长度`,
    );
  }
}

function validateRecords(records, schema, bookId, bookName) {
  if (!Array.isArray(records) || !records.length) {
    throw new EbookIngestionError("INPUT_INVALID", "没有可写入的 EPUB 分块");
  }
  if (!String(bookName ?? "").trim()) {
    throw new EbookIngestionError("INPUT_INVALID", "bookName 不能为空");
  }
  validateTextLength(bookId, schema.bookIdMaxLength, "bookId");
  validateTextLength(bookName, schema.bookNameMaxLength, "bookName");
  const ids = new Set();
  for (const record of records) {
    if (String(record.bookId) !== bookId) {
      throw new EbookIngestionError("INPUT_INVALID", "分块 bookId 与入库 bookId 不一致");
    }
    if (!record.id || ids.has(record.id)) {
      throw new EbookIngestionError("INPUT_INVALID", "分块 ID 缺失或重复");
    }
    if (!String(record.content ?? "").trim()) {
      throw new EbookIngestionError("INPUT_INVALID", "分块 content 不能为空");
    }
    ids.add(record.id);
    positiveInteger(record.chapterNum, "chapterNum");
    if (!Number.isInteger(record.chunkIndex) || record.chunkIndex < 0) {
      throw new EbookIngestionError("INPUT_INVALID", "chunkIndex 必须是非负整数");
    }
    validateTextLength(record.id, schema.idMaxLength, "id");
    validateTextLength(record.content, schema.contentMaxLength, "content");
  }
}

function normalizeDuplicatePolicy(value) {
  const policy = String(value ?? "skip").trim().toLowerCase();
  if (!DUPLICATE_POLICIES.includes(policy)) {
    throw new EbookIngestionError(
      "INPUT_INVALID",
      `onDuplicate 必须是 ${DUPLICATE_POLICIES.join("、")}`,
    );
  }
  return policy;
}

export class MilvusEbookWriter {
  constructor({ client, embeddings, collectionName, embeddingDimension }) {
    this.client = client;
    this.embeddings = embeddings;
    this.collectionName = String(collectionName ?? "").trim();
    if (!this.collectionName) {
      throw new EbookIngestionError("INPUT_INVALID", "collectionName 不能为空");
    }
    this.embeddingDimension = positiveInteger(embeddingDimension, "embeddingDimension");
  }

  async #validateCollection() {
    const existence = await this.client.hasCollection({
      collection_name: this.collectionName,
    });
    assertSuccess(
      existence,
      "COLLECTION_CHECK_FAILED",
      "无法检查 EPUB Collection",
    );
    if (!existence?.value) {
      throw new EbookIngestionError(
        "COLLECTION_NOT_FOUND",
        `EPUB Collection ${this.collectionName} 不存在；入库工具不会自动创建`,
      );
    }
    const description = await this.client.describeCollection({
      collection_name: this.collectionName,
    });
    return validateSchema(description, this.embeddingDimension);
  }

  async #existingIds(bookId, expectedCount) {
    const response = await this.client.query({
      collection_name: this.collectionName,
      filter: `book_id == ${safeStringLiteral(bookId, "bookId")}`,
      output_fields: ["id"],
      limit: expectedCount + 1,
      consistency_level: ConsistencyLevelEnum.Strong,
    });
    assertSuccess(
      response,
      "DUPLICATE_CHECK_FAILED",
      "无法检查 EPUB 重复入库状态",
    );
    return new Set((response?.data ?? []).map((item) => String(item.id ?? "")).filter(Boolean));
  }

  async write({
    records,
    bookId,
    bookName,
    batchSize = DEFAULT_EPUB_INGEST_BATCH_SIZE,
    onDuplicate = "skip",
  }) {
    const normalizedBookId = String(bookId ?? "").trim();
    safeStringLiteral(normalizedBookId, "bookId");
    const normalizedBookName = String(bookName ?? "").trim();
    const size = positiveInteger(batchSize, "batchSize");
    const policy = normalizeDuplicatePolicy(onDuplicate);
    const schema = await this.#validateCollection();
    validateRecords(records, schema, normalizedBookId, normalizedBookName);

    const expectedIds = new Set(records.map((record) => record.id));
    const existingIds = await this.#existingIds(normalizedBookId, records.length);
    if (existingIds.size && policy === "error") {
      throw new EbookIngestionError(
        "BOOK_ALREADY_EXISTS",
        `bookId=${normalizedBookId} 已有入库数据`,
      );
    }
    const conflictingIds = [...existingIds].filter((id) => !expectedIds.has(id));
    if (conflictingIds.length) {
      throw new EbookIngestionError(
        "BOOK_VERSION_CONFLICT",
        `bookId=${normalizedBookId} 已存在不同内容或分块版本，不会自动覆盖`,
        { details: { existingCount: existingIds.size } },
      );
    }
    if (existingIds.size === records.length) {
      return {
        status: "skipped_existing",
        expectedCount: records.length,
        existingCount: existingIds.size,
        insertedCount: 0,
        batchCount: 0,
      };
    }
    if (existingIds.size && policy !== "resume") {
      throw new EbookIngestionError(
        "BOOK_PARTIALLY_IMPORTED",
        `bookId=${normalizedBookId} 仅部分入库；需要显式使用 resume 补齐`,
        { details: { existingCount: existingIds.size, expectedCount: records.length } },
      );
    }

    const pending = records.filter((record) => !existingIds.has(record.id));
    let insertedCount = 0;
    let batchCount = 0;
    for (let offset = 0; offset < pending.length; offset += size) {
      const batch = pending.slice(offset, offset + size);
      let vectors;
      try {
        vectors = await this.embeddings.embedDocuments(
          batch.map((record) => record.content),
        );
      } catch (error) {
        throw new EbookIngestionError(
          "EMBEDDING_BATCH_FAILED",
          `Embedding 批次失败；已写入 ${insertedCount} 条`,
          { cause: error, details: { insertedCount, batchIndex: batchCount } },
        );
      }
      if (!Array.isArray(vectors) || vectors.length !== batch.length
        || vectors.some((vector) => (
          !Array.isArray(vector)
          || vector.length !== this.embeddingDimension
          || vector.some((value) => !Number.isFinite(value))
        ))) {
        throw new EbookIngestionError(
          "EMBEDDING_DIMENSION_MISMATCH",
          `Embedding 批次维度或数量与配置 ${this.embeddingDimension} 不匹配；已写入 ${insertedCount} 条`,
          { details: { insertedCount, batchIndex: batchCount } },
        );
      }

      const data = batch.map((record, index) => ({
        id: record.id,
        book_id: normalizedBookId,
        book_name: normalizedBookName,
        chapter_num: record.chapterNum,
        index: record.chunkIndex,
        content: record.content,
        vector: vectors[index],
      }));
      let response;
      try {
        response = await this.client.insert({
          collection_name: this.collectionName,
          data,
        });
      } catch (error) {
        throw new EbookIngestionError(
          "MILVUS_BATCH_WRITE_FAILED",
          `Milvus 批次写入失败；已写入 ${insertedCount} 条`,
          { cause: error, details: { insertedCount, batchIndex: batchCount } },
        );
      }
      try {
        assertSuccess(
          response,
          "MILVUS_BATCH_WRITE_FAILED",
          `Milvus 批次写入失败；已写入 ${insertedCount} 条`,
        );
      } catch (error) {
        throw new EbookIngestionError(
          "MILVUS_BATCH_WRITE_FAILED",
          `Milvus 批次写入失败；已写入 ${insertedCount} 条`,
          { cause: error, details: { insertedCount, batchIndex: batchCount } },
        );
      }
      const count = Number(response?.insert_cnt ?? response?.insertCount ?? 0);
      if (count !== batch.length) {
        throw new EbookIngestionError(
          "MILVUS_INSERT_COUNT_MISMATCH",
          `Milvus 返回的写入数量与批次不一致；此前已写入 ${insertedCount} 条`,
          { details: { insertedCount, batchIndex: batchCount } },
        );
      }
      insertedCount += count;
      batchCount += 1;
    }

    return {
      status: existingIds.size ? "resumed" : "inserted",
      expectedCount: records.length,
      existingCount: existingIds.size,
      insertedCount,
      batchCount,
    };
  }
}
