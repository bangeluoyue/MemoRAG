import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DataType } from "@zilliz/milvus2-sdk-node";
import { collectionSpecs, initializeMilvus, initializeElasticsearch, migratePostgres } from "../src/deploy/initialize.js";
import { main } from "../src/cli/init-deployment.js";

const config = { model: { embeddingDimension: 1024 }, milvus: { collectionName: "ebook_collection" }, notes: { milvus: { collectionName: "life_notes" } } };
const ok = { error_code: "Success" };

test("explicit missing private environment file fails without development fallback", async () => {
  const original = process.env.MEMORAG_ENV_FILE;
  process.env.MEMORAG_ENV_FILE = "/nonexistent/memorag-test-private-env";
  try {
    await assert.rejects(import("../src/config.js?deployment-missing-private-env"), /无法读取 MEMORAG_ENV_FILE/u);
  } finally {
    if (original === undefined) delete process.env.MEMORAG_ENV_FILE;
    else process.env.MEMORAG_ENV_FILE = original;
  }
});
function fakeMilvus(existing = [], incompatible = false) {
  const specs = collectionSpecs(config);
  const calls = [];
  const present = new Set(existing);
  const client = {
    calls,
    async hasCollection({ collection_name }) { return { status: ok, value: present.has(collection_name) }; },
    async describeCollection({ collection_name }) {
      const spec = specs.find(s => s.name === collection_name);
      return { status: ok, schema: { fields: spec.fields.map(f => ({ ...f, dim: incompatible && f.name === "vector" ? 768 : f.dim })) } };
    },
    async describeIndex() { return { status: ok, index_descriptions: [{ field_name: "vector", state: "Finished", params: [{ key: "metric_type", value: "COSINE" }, { key: "index_type", value: "AUTOINDEX" }] }] }; },
    async getLoadState() { return { status: ok, state: "LoadStateLoaded" }; },
    async createCollection(req) { calls.push(["create", req]); present.add(req.collection_name); return ok; },
    async createIndex(req) { calls.push(["index", req]); return ok; },
    async loadCollectionSync(req) { calls.push(["load", req]); return ok; },
  };
  return client;
}

test("deployment CLI defaults do not construct any service client", async () => {
  for (const target of ["postgres", "milvus", "elasticsearch", "accounts"]) await main([target]);
  await assert.rejects(main(["milvus", "--check", "--execute"]));
});

test("Milvus initialization reuses both compatible collections without mutation", async () => {
  const client = fakeMilvus(["ebook_collection", "life_notes"]);
  const result = await initializeMilvus(client, config, { execute: true });
  assert.deepEqual(result.map(r => r.action), ["reuse", "reuse"]);
  assert.deepEqual(client.calls, []);
});

test("Milvus preflights both collections before creating anything", async () => {
  const client = fakeMilvus(["life_notes"], true);
  await assert.rejects(initializeMilvus(client, config, { execute: true }), /INCOMPATIBLE/u);
  assert.deepEqual(client.calls, []);
});

test("Milvus missing collections check is read-only; explicit execute uses real 1024 field contracts", async () => {
  const client = fakeMilvus();
  await initializeMilvus(client, config);
  assert.deepEqual(client.calls, []);
  await initializeMilvus(client, config, { execute: true });
  assert.deepEqual(client.calls.map(c => c[0]), ["create", "index", "load", "create", "index", "load"]);
  const notes = client.calls[3][1];
  assert.equal(notes.fields.find(f => f.name === "note_id").is_primary_key, true);
  assert.equal(notes.fields.find(f => f.name === "metadata").data_type, DataType.JSON);
  assert.equal(notes.fields.find(f => f.name === "vector").dim, 1024);
  assert.throws(() => collectionSpecs({ ...config, model: { embeddingDimension: 768 } }));
});

test("Milvus failure stops immediately without deleting or repairing existing resources", async () => {
  const client = fakeMilvus();
  client.createIndex = async () => { throw new Error("failure"); };
  await assert.rejects(initializeMilvus(client, config, { execute: true }));
  assert.equal(client.calls.length, 1);
});

test("Milvus refuses existing missing indexes, auto IDs, and undersized strings without any writes", async () => {
  for (const alteration of [
    client => { client.describeIndex = async () => ({ status: ok, index_descriptions: [] }); },
    client => { const describe = client.describeCollection; client.describeCollection = async req => { const d = await describe(req); d.schema.autoID = true; return d; }; },
    client => { const describe = client.describeCollection; client.describeCollection = async req => { const d = await describe(req); d.schema.fields[0].max_length = 1; return d; }; },
  ]) {
    const client = fakeMilvus(["ebook_collection", "life_notes"]);
    alteration(client);
    await assert.rejects(initializeMilvus(client, config, { execute: true }), /INCOMPATIBLE/u);
    assert.deepEqual(client.calls, []);
  }
});

test("Elasticsearch preserves compatible mapping and rejects incompatible mapping", async () => {
  const expected = JSON.parse(await readFile(new URL("../../deploy/elasticsearch/life-notes-index.json", import.meta.url), "utf8"));
  const client = { indices: {
    exists: async () => true,
    getMapping: async () => ({ life_notes: { mappings: expected.mappings } }),
    create: async () => assert.fail("must never overwrite"),
  } };
  assert.equal((await initializeElasticsearch(client, "life_notes", { execute: true })).action, "reuse");
  client.indices.getMapping = async () => ({ life_notes: { mappings: { properties: {} } } });
  await assert.rejects(initializeElasticsearch(client, "life_notes", { execute: true }), /INCOMPATIBLE/u);
});

test("migrations execute original SQL in order and stop on first failure", async () => {
  const queries = [];
  await migratePostgres({ query: async sql => queries.push(sql) });
  assert.equal(queries[0], await readFile(new URL("../sql/001_create_life_notes.sql", import.meta.url), "utf8"));
  assert.match(queries[1], /^BEGIN;/u);
  let count = 0;
  await assert.rejects(migratePostgres({ query: async () => { count += 1; throw new Error("failure"); } }));
  assert.equal(count, 1);
});
