import test from "node:test";
import assert from "node:assert/strict";
import { main as notesCli, parseNotesArgs } from "../src/cli/notes.js";
import { NotesIndexSynchronizer } from "../src/notes/index-synchronizer.js";
import { createNotesService } from "../src/notes/index.js";
import { PostgresNotesRepository } from "../src/notes/repository.js";
import { NotesService, NotesServiceError } from "../src/notes/service.js";

const successStatus = { error_code: "Success", code: 0 };

function note(overrides = {}) {
  return {
    noteId: "note-1",
    userId: "user-1",
    knowledgeBase: "life_notes",
    title: "标题",
    content: "正文",
    syncStatus: "pending",
    syncOperation: "upsert",
    syncAttempts: 0,
    syncErrorCategory: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    deletedAt: null,
    syncUpdatedAt: null,
    ...overrides,
  };
}

function synchronizerFixture({ esIndex, milvusUpsert, esDelete, milvusDelete, vector } = {}) {
  const calls = { esIndex: [], milvusUpsert: [], esDelete: [], milvusDelete: [], embed: [] };
  const synchronizer = new NotesIndexSynchronizer({
    elasticsearchClient: {
      async index(request) {
        calls.esIndex.push(request);
        if (esIndex) return esIndex(request);
        return { result: "updated" };
      },
      async deleteByQuery(request) {
        calls.esDelete.push(request);
        if (esDelete) return esDelete(request);
        return { deleted: 1 };
      },
    },
    elasticsearchIndex: "life_notes",
    milvusClient: {
      async upsert(request) {
        calls.milvusUpsert.push(request);
        if (milvusUpsert) return milvusUpsert(request);
        return { status: successStatus };
      },
      async delete(request) {
        calls.milvusDelete.push(request);
        if (milvusDelete) return milvusDelete(request);
        return { status: successStatus };
      },
    },
    milvusCollection: "life_notes",
    embeddings: {
      async embedQuery(content) {
        calls.embed.push(content);
        return vector ?? [0.1, 0.2];
      },
    },
    embeddingDimension: 2,
  });
  return { synchronizer, calls };
}

function memoryRepository(initial = []) {
  const records = new Map(initial.map((value) => [value.noteId, { ...value }]));
  const calls = [];
  const repository = {
    calls,
    records,
    async create(value) {
      calls.push(["create", value]);
      const created = note({ ...value });
      records.set(created.noteId, created);
      return { ...created };
    },
    async findById(value) {
      calls.push(["findById", value]);
      const found = records.get(value.noteId);
      if (!found || found.userId !== value.userId) return null;
      if (found.deletedAt && !value.includeDeleted) return null;
      return { ...found };
    },
    async list(value) {
      calls.push(["list", value]);
      return [...records.values()]
        .filter((item) => item.userId === value.userId && !item.deletedAt)
        .slice(0, value.limit)
        .map((item) => ({ ...item }));
    },
    async update(value) {
      calls.push(["update", value]);
      const updated = {
        ...records.get(value.noteId),
        ...value,
        syncStatus: "pending",
        syncOperation: "upsert",
      };
      records.set(value.noteId, updated);
      return { ...updated };
    },
    async markForDelete(value) {
      calls.push(["markForDelete", value]);
      const found = records.get(value.noteId);
      if (!found || found.userId !== value.userId) return null;
      const deleted = {
        ...found,
        deletedAt: new Date("2026-01-02T00:00:00Z"),
        syncStatus: "pending",
        syncOperation: "delete",
      };
      records.set(value.noteId, deleted);
      return { ...deleted };
    },
    async markSyncResult(value) {
      calls.push(["markSyncResult", value]);
      const updated = {
        ...records.get(value.noteId),
        syncStatus: value.status,
        syncErrorCategory: value.errorCategory,
        syncAttempts: (records.get(value.noteId)?.syncAttempts ?? 0) + 1,
      };
      records.set(value.noteId, updated);
      return { ...updated };
    },
    async hardDelete(value) {
      calls.push(["hardDelete", value]);
      return records.delete(value.noteId);
    },
  };
  return repository;
}

test("index upsert writes the P3-4 fields and one validated vector", async () => {
  const { synchronizer, calls } = synchronizerFixture();
  const result = await synchronizer.upsert(note());

  assert.equal(result.status, "synced");
  assert.deepEqual(calls.embed, ["正文"]);
  assert.deepEqual(calls.esIndex, [{
    index: "life_notes",
    id: "note-1",
    document: {
      note_id: "note-1",
      user_id: "user-1",
      knowledge_base: "life_notes",
      title: "标题",
      content: "正文",
    },
  }]);
  assert.deepEqual(calls.milvusUpsert[0].data[0], {
    note_id: "note-1",
    user_id: "user-1",
    knowledge_base: "life_notes",
    title: "标题",
    content: "正文",
    metadata: {},
    vector: [0.1, 0.2],
  });
});

test("index upsert exposes safe partial failure diagnostics for retry", async () => {
  const { synchronizer } = synchronizerFixture({
    milvusUpsert: async () => { throw new Error("secret endpoint and payload"); },
  });
  const result = await synchronizer.upsert(note());

  assert.equal(result.status, "failed");
  assert.equal(result.targets.elasticsearch.status, "synced");
  assert.equal(result.targets.milvus.status, "failed");
  assert.deepEqual(result.errorCategories, ["MILVUS_SYNC_FAILED"]);
  assert.doesNotMatch(JSON.stringify(result), /secret|endpoint|payload/u);
});

test("invalid embedding cannot reach Milvus but ES remains independently retryable", async () => {
  const { synchronizer, calls } = synchronizerFixture({ vector: [0.1] });
  const result = await synchronizer.upsert(note());

  assert.equal(result.status, "failed");
  assert.equal(result.targets.elasticsearch.status, "synced");
  assert.equal(result.targets.milvus.status, "failed");
  assert.equal(calls.milvusUpsert.length, 0);
});

test("index delete applies note, user, and knowledge-base filters to both backends", async () => {
  const { synchronizer, calls } = synchronizerFixture();
  const result = await synchronizer.delete(note());

  assert.equal(result.status, "synced");
  assert.deepEqual(calls.esDelete[0].query.bool.filter, [
    { term: { note_id: "note-1" } },
    { term: { user_id: "user-1" } },
    { term: { knowledge_base: "life_notes" } },
  ]);
  assert.equal(
    calls.milvusDelete[0].filter,
    'note_id == "note-1" && user_id == "user-1" && knowledge_base == "life_notes"',
  );
});

test("Postgres repository parameterizes tenant-scoped CRUD queries", async () => {
  const calls = [];
  const pool = {
    async query(request) {
      calls.push(request);
      return {
        rows: [{
          note_id: "note-1",
          user_id: "user-1",
          knowledge_base: "life_notes",
          title: "标题",
          content: "正文",
          sync_status: "pending",
          sync_operation: "upsert",
          sync_attempts: 0,
        }],
        rowCount: 1,
      };
    },
  };
  const repository = new PostgresNotesRepository({ pool });
  await repository.create(note());
  await repository.findById({ noteId: "note-1", userId: "user-1" });
  await repository.list({ userId: "user-1", limit: 20 });
  await repository.update(note());
  await repository.markForDelete({ noteId: "note-1", userId: "user-1" });
  await repository.markSyncResult({
    noteId: "note-1",
    userId: "user-1",
    status: "failed",
    errorCategory: "MILVUS_SYNC_FAILED",
  });
  await repository.hardDelete({ noteId: "note-1", userId: "user-1" });

  assert.equal(calls.length, 7);
  for (const call of calls) {
    assert.match(call.text, /knowledge_base/u);
    assert.ok(call.values.includes("life_notes"));
    assert.doesNotMatch(call.text, /note-1|user-1/u);
  }
  assert.match(calls[1].text, /deleted_at IS NULL/u);
  assert.match(calls[2].text, /deleted_at IS NULL/u);
  assert.match(calls[6].text, /deleted_at IS NOT NULL/u);
});

test("create keeps one stable note ID and persists successful sync state", async () => {
  const repository = memoryRepository();
  const synchronized = [];
  const service = new NotesService({
    repository,
    synchronizer: {
      async upsert(value) {
        synchronized.push(value);
        return {
          status: "synced",
          operation: "upsert",
          targets: {},
          errorCategories: [],
        };
      },
    },
  });
  const result = await service.create({
    noteId: "stable-note",
    userId: "user-1",
    title: " 标题 ",
    content: " 正文 ",
  });

  assert.equal(result.note.noteId, "stable-note");
  assert.equal(synchronized[0].noteId, "stable-note");
  assert.equal(result.note.syncStatus, "synced");
  assert.equal(result.note.syncAttempts, 1);
});

test("create generates a UUID when noteId is omitted", async () => {
  const repository = memoryRepository();
  const service = new NotesService({
    repository,
    synchronizer: {
      async upsert() {
        return { status: "synced", operation: "upsert", targets: {}, errorCategories: [] };
      },
    },
  });
  const result = await service.create({ userId: "user-1", content: "正文" });
  assert.match(result.note.noteId, /^[0-9a-f]{8}-[0-9a-f-]{27}$/u);
});

test("update preserves note ID and untouched content before reindexing", async () => {
  const repository = memoryRepository([note()]);
  let synchronized;
  const service = new NotesService({
    repository,
    synchronizer: {
      async upsert(value) {
        synchronized = value;
        return { status: "synced", operation: "upsert", targets: {}, errorCategories: [] };
      },
    },
  });
  const result = await service.update({
    noteId: "note-1",
    userId: "user-1",
    title: "新标题",
  });

  assert.equal(synchronized.noteId, "note-1");
  assert.equal(synchronized.title, "新标题");
  assert.equal(synchronized.content, "正文");
  assert.equal(result.note.syncStatus, "synced");
});

test("successful delete tombstones first, removes both indexes, then purges PostgreSQL", async () => {
  const repository = memoryRepository([note()]);
  const service = new NotesService({
    repository,
    synchronizer: {
      async delete(value) {
        assert.ok(value.deletedAt);
        return { status: "synced", operation: "delete", targets: {}, errorCategories: [] };
      },
    },
  });
  const result = await service.delete({ noteId: "note-1", userId: "user-1" });

  assert.equal(result.deleted, true);
  assert.equal(result.purged, true);
  assert.equal(repository.records.has("note-1"), false);
  assert.deepEqual(repository.calls.map(([name]) => name), [
    "markForDelete", "markSyncResult", "hardDelete",
  ]);
});

test("partial delete failure retains a hidden tombstone with retry state", async () => {
  const repository = memoryRepository([note()]);
  const service = new NotesService({
    repository,
    synchronizer: {
      async delete() {
        return {
          status: "failed",
          operation: "delete",
          targets: {},
          errorCategories: ["ELASTICSEARCH_SYNC_FAILED"],
        };
      },
    },
  });
  const result = await service.delete({ noteId: "note-1", userId: "user-1" });

  assert.equal(result.purged, false);
  assert.equal(result.note.syncStatus, "failed");
  assert.equal(result.note.syncErrorCategory, "ELASTICSEARCH_SYNC_FAILED");
  assert.equal(await service.get({ noteId: "note-1", userId: "user-1" }), null);
  assert.ok(repository.records.get("note-1").deletedAt);
});

test("retry replays a tombstoned delete idempotently and purges on success", async () => {
  const repository = memoryRepository([note({
    syncStatus: "failed",
    syncOperation: "delete",
    deletedAt: new Date("2026-01-02T00:00:00Z"),
  })]);
  const service = new NotesService({
    repository,
    synchronizer: {
      async delete() {
        return { status: "synced", operation: "delete", targets: {}, errorCategories: [] };
      },
    },
  });
  const result = await service.retry({ noteId: "note-1", userId: "user-1" });
  assert.equal(result.purged, true);
  assert.equal(repository.records.size, 0);
});

test("retry can purge a synced tombstone left by an interrupted hard delete", async () => {
  const repository = memoryRepository([note({
    syncStatus: "synced",
    syncOperation: "delete",
    deletedAt: new Date("2026-01-02T00:00:00Z"),
  })]);
  const service = new NotesService({
    repository,
    synchronizer: {
      async delete() {
        return { status: "synced", operation: "delete", targets: {}, errorCategories: [] };
      },
    },
  });
  const result = await service.retry({ noteId: "note-1", userId: "user-1" });
  assert.equal(result.purged, true);
  assert.equal(repository.records.size, 0);
});

test("retry replays a failed upsert with the same stable note ID", async () => {
  const repository = memoryRepository([note({ syncStatus: "failed", syncAttempts: 1 })]);
  let synchronized;
  const service = new NotesService({
    repository,
    synchronizer: {
      async upsert(value) {
        synchronized = value;
        return { status: "synced", operation: "upsert", targets: {}, errorCategories: [] };
      },
    },
  });
  const result = await service.retry({ noteId: "note-1", userId: "user-1" });
  assert.equal(synchronized.noteId, "note-1");
  assert.equal(result.note.syncStatus, "synced");
  assert.equal(result.note.syncAttempts, 2);
});

test("unexpected synchronizer errors become safe persisted retry state", async () => {
  const repository = memoryRepository();
  const service = new NotesService({
    repository,
    synchronizer: {
      async upsert() { throw new Error("secret backend response"); },
    },
  });
  const result = await service.create({
    noteId: "note-1",
    userId: "user-1",
    content: "正文",
  });
  assert.equal(result.sync.status, "failed");
  assert.deepEqual(result.sync.errorCategories, ["INDEX_SYNC_UNEXPECTED_FAILURE"]);
  assert.doesNotMatch(JSON.stringify(result), /secret|backend response/u);
});

test("service validates scope, limits, and missing updates before storage calls", async () => {
  const repository = memoryRepository();
  const service = new NotesService({ repository, synchronizer: {} });

  await assert.rejects(
    service.create({ userId: "bad user", content: "正文" }),
    (error) => error instanceof NotesServiceError && error.code === "INPUT_INVALID",
  );
  await assert.rejects(service.list({ userId: "user-1", limit: 101 }), /limit/u);
  await assert.rejects(
    service.update({ noteId: "note-1", userId: "user-1" }),
    /至少需要/u,
  );
  assert.equal(repository.calls.length, 0);
});

test("notes CLI defaults to dry-run without creating a service", async () => {
  const logs = [];
  const options = parseNotesArgs([
    "create", "--user-id", "user-1", "--content", "private text",
  ]);
  assert.equal(options.execute, false);
  const result = await notesCli([
    "create", "--user-id", "user-1", "--content", "private text",
  ], {
    log: (line) => logs.push(line),
    get service() { throw new Error("service must not be read"); },
  });
  assert.equal(result.status, "dry_run");
  assert.doesNotMatch(logs.join("\n"), /private text/u);
});

test("notes CLI executes only behind --execute and always closes service", async () => {
  const calls = [];
  const result = await notesCli([
    "delete", "--user-id", "user-1", "--note-id", "note-1", "--execute",
  ], {
    log() {},
    service: {
      async delete(input) {
        calls.push(["delete", input]);
        return { deleted: true, purged: true, sync: { status: "synced" } };
      },
      async close() { calls.push(["close"]); },
    },
  });
  assert.equal(result.purged, true);
  assert.deepEqual(calls, [
    ["delete", { userId: "user-1", noteId: "note-1" }],
    ["close"],
  ]);
});

test("notes service factory accepts full Mock injection without config or ownership side effects", async () => {
  let closed = false;
  const repository = memoryRepository();
  const service = createNotesService({
    repository,
    synchronizer: {
      async upsert() {
        return { status: "synced", operation: "upsert", targets: {}, errorCategories: [] };
      },
      async close() { closed = true; },
    },
  });
  const result = await service.create({
    noteId: "note-1",
    userId: "user-1",
    content: "正文",
  });
  await service.close();

  assert.equal(result.note.syncStatus, "synced");
  assert.equal(closed, false);
});
