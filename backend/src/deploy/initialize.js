import { readFile } from "node:fs/promises";
import { DataType } from "@zilliz/milvus2-sdk-node";

const varchar = (name, max_length, primary = false) => ({
  name, data_type: DataType.VarChar, max_length,
  ...(primary ? { is_primary_key: true, autoID: false } : {}),
});

// Field names/types come from the current writers and retrievers. EPUB lengths
// match the accepted legacy schema; notes IDs/title follow the current validator.
export function collectionSpecs(config) {
  if (config.model.embeddingDimension !== 1024) throw new Error("DEPLOY_DIMENSION_MUST_BE_1024");
  const vector = { name: "vector", data_type: DataType.FloatVector, dim: 1024 };
  const specs = [
    { name: config.milvus.collectionName, fields: [
      varchar("id", 100, true), varchar("book_id", 100), varchar("book_name", 200),
      { name: "chapter_num", data_type: DataType.Int32 },
      { name: "index", data_type: DataType.Int32 },
      varchar("content", 10000), vector,
    ] },
    { name: config.notes.milvus.collectionName, fields: [
      varchar("note_id", 128, true), varchar("user_id", 128),
      varchar("knowledge_base", 32), varchar("title", 2000),
      varchar("content", 65535), { name: "metadata", data_type: DataType.JSON }, vector,
    ] },
  ];
  if (specs[0].name === specs[1].name) throw new Error("COLLECTIONS_MUST_BE_SEPARATE");
  return specs;
}

function success(response) {
  const status = response?.status ?? response;
  if (!status || !(status.error_code === "Success" || Number(status.code) === 0)) {
    throw new Error("MILVUS_OPERATION_FAILED");
  }
  return response;
}

function typeMatches(actual, expected) {
  return Number(actual) === expected || DataType[expected] === actual;
}

function parameter(field, key) {
  return field[key] ?? field.type_params?.find(p => p.key === key)?.value;
}

export function validateCollection(description, spec) {
  success(description);
  const schema = description.schema;
  if (!schema || schema.autoID || schema.auto_id) throw new Error("COLLECTION_AUTO_ID_INCOMPATIBLE");
  const fields = schema.fields ?? [];
  for (const wanted of spec.fields) {
    const field = fields.find(f => f.name === wanted.name);
    if (!field || !typeMatches(field.data_type, wanted.data_type)
      || Boolean(field.is_primary_key) !== Boolean(wanted.is_primary_key)
      || field.autoID || field.auto_id
      || (wanted.dim && Number(parameter(field, "dim")) !== wanted.dim)
      || (wanted.max_length && !(Number(parameter(field, "max_length")) >= wanted.max_length))) {
      throw new Error(`COLLECTION_FIELD_INCOMPATIBLE:${wanted.name}`);
    }
  }
  for (const field of fields) {
    if (!spec.fields.some(f => f.name === field.name)
      && !field.is_dynamic && !field.nullable && field.default_value == null) {
      throw new Error("COLLECTION_EXTRA_REQUIRED_FIELD");
    }
  }
}

function validateIndex(response) {
  success(response);
  const indexes = response.index_descriptions ?? [];
  const index = indexes.find(i => i.field_name === "vector");
  const params = Object.fromEntries((index?.params ?? []).map(p => [p.key, p.value]));
  if (!index || params.metric_type !== "COSINE" || !params.index_type
    || !["Finished", 3, "3"].includes(index.state)) {
    throw new Error("COLLECTION_INDEX_INCOMPATIBLE_OR_NOT_READY");
  }
}

export async function initializeMilvus(client, config, { execute = false } = {}) {
  const specs = collectionSpecs(config);
  const plans = [];
  // Check BOTH collections before any write. Existing collections are never modified.
  for (const spec of specs) {
    const exists = success(await client.hasCollection({ collection_name: spec.name }));
    if (exists.value) {
      validateCollection(await client.describeCollection({ collection_name: spec.name }), spec);
      validateIndex(await client.describeIndex({ collection_name: spec.name }));
      const state = success(await client.getLoadState({ collection_name: spec.name }));
      if (!["LoadStateLoaded", "Loaded", 3, "3"].includes(state.state)) {
        throw new Error("EXISTING_COLLECTION_NOT_LOADED");
      }
    }
    plans.push({ ...spec, exists: Boolean(exists.value) });
  }
  if (execute) {
    for (const spec of plans.filter(p => !p.exists)) {
      const request = { collection_name: spec.name };
      success(await client.createCollection({
        ...request, fields: spec.fields, enable_dynamic_field: false,
        shards_num: 1, consistency_level: "Strong",
      }));
      success(await client.createIndex({
        ...request, field_name: "vector", index_name: "vector_index",
        index_type: "AUTOINDEX", metric_type: "COSINE",
      }));
      success(await client.loadCollectionSync(request));
      validateCollection(await client.describeCollection(request), spec);
      validateIndex(await client.describeIndex(request));
    }
  }
  return plans.map(p => ({ name: p.name, action: p.exists ? "reuse" : execute ? "created" : "missing" }));
}

const mappingUrl = new URL("../../../deploy/elasticsearch/life-notes-index.json", import.meta.url);
export async function initializeElasticsearch(client, index, { execute = false } = {}) {
  const expected = JSON.parse(await readFile(mappingUrl, "utf8"));
  const exists = await client.indices.exists({ index });
  if (exists) {
    const mappings = await client.indices.getMapping({ index });
    const entries = Object.values(mappings);
    if (entries.length !== 1 || !mappings[index]) throw new Error("ES_ALIAS_OR_INDEX_INCOMPATIBLE");
    const fields = mappings[index].mappings?.properties ?? {};
    for (const [name, wanted] of Object.entries(expected.mappings.properties)) {
      if (Object.entries(wanted).some(([key, value]) => fields[name]?.[key] !== value)) {
        throw new Error(`ES_MAPPING_INCOMPATIBLE:${name}`);
      }
    }
  } else if (execute) {
    await client.indices.create({ index, ...expected });
  }
  return { index, action: exists ? "reuse" : execute ? "created" : "missing" };
}

export async function migratePostgres(client) {
  // Original SQL, no rewriting. One client retains BEGIN/COMMIT on pooled connections.
  for (const name of ["001_create_life_notes.sql", "002_create_auth.sql"]) {
    const sql = await readFile(new URL(`../../sql/${name}`, import.meta.url), "utf8");
    await client.query(sql);
  }
}
