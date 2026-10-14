import { randomUUID } from "node:crypto";
import { NOTE_KNOWLEDGE_BASE } from "./repository.js";

const SAFE_ID = /^[\w.:-]+$/u;

export class NotesServiceError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "NotesServiceError";
    this.code = code;
  }
}

function identifier(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw new NotesServiceError("INPUT_INVALID", `${name} 不能为空`);
  if (text.length > 128 || !SAFE_ID.test(text)) {
    throw new NotesServiceError("INPUT_INVALID", `${name} 包含不支持的字符或过长`);
  }
  return text;
}

function normalizeTitle(value) {
  const title = String(value ?? "").trim();
  if (title.length > 500) {
    throw new NotesServiceError("INPUT_INVALID", "title 不能超过 500 个字符");
  }
  return title;
}

function normalizeContent(value) {
  const content = String(value ?? "").trim();
  if (!content) throw new NotesServiceError("INPUT_INVALID", "content 不能为空");
  return content;
}

export function validateNotesCommandInput(command, input = {}) {
  const common = { userId: identifier(input.userId, "userId") };
  if (["get", "update", "delete", "retry"].includes(command)) {
    common.noteId = identifier(input.noteId, "noteId");
  }
  if (command === "create") {
    return {
      ...common,
      ...(input.noteId === undefined
        ? {}
        : { noteId: identifier(input.noteId, "noteId") }),
      title: normalizeTitle(input.title),
      content: normalizeContent(input.content),
    };
  }
  if (command === "update") {
    if (input.title === undefined && input.content === undefined) {
      throw new NotesServiceError("INPUT_INVALID", "update 至少需要 title 或 content");
    }
    return {
      ...common,
      ...(input.title === undefined ? {} : { title: normalizeTitle(input.title) }),
      ...(input.content === undefined ? {} : { content: normalizeContent(input.content) }),
    };
  }
  if (command === "list") {
    const limit = Number(input.limit ?? 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new NotesServiceError("INPUT_INVALID", "limit 必须是 1 到 100 的整数");
    }
    return { ...common, limit };
  }
  return common;
}

function resultErrorCategory(result) {
  return result.errorCategories.length ? result.errorCategories.join(",") : null;
}

function unexpectedSyncResult(operation) {
  return {
    status: "failed",
    operation,
    targets: {
      elasticsearch: { status: "unknown", errorCategory: null },
      milvus: { status: "unknown", errorCategory: null },
    },
    errorCategories: ["INDEX_SYNC_UNEXPECTED_FAILURE"],
  };
}

export class NotesService {
  constructor({ repository, synchronizer, closeResources = async () => {} }) {
    if (!repository || !synchronizer) {
      throw new Error("NotesService 缺少 repository 或 synchronizer");
    }
    this.repository = repository;
    this.synchronizer = synchronizer;
    this.closeResources = closeResources;
  }

  async #synchronize(note, operation) {
    let sync;
    try {
      sync = await this.synchronizer[operation](note);
    } catch {
      sync = unexpectedSyncResult(operation);
    }
    const persisted = await this.repository.markSyncResult({
      noteId: note.noteId,
      userId: note.userId,
      status: sync.status,
      errorCategory: resultErrorCategory(sync),
    });
    return { sync, persisted };
  }

  async create(input) {
    const validated = validateNotesCommandInput("create", input);
    const note = await this.repository.create({
      ...validated,
      noteId: validated.noteId ?? randomUUID(),
    });
    const { sync, persisted } = await this.#synchronize(note, "upsert");
    return { note: persisted, sync };
  }

  async get(input) {
    return this.repository.findById(validateNotesCommandInput("get", input));
  }

  async list(input) {
    return this.repository.list(validateNotesCommandInput("list", input));
  }

  async update(input) {
    const validated = validateNotesCommandInput("update", input);
    const identity = { noteId: validated.noteId, userId: validated.userId };
    const current = await this.repository.findById(identity);
    if (!current) throw new NotesServiceError("NOTE_NOT_FOUND", "笔记不存在");
    const note = await this.repository.update({
      ...identity,
      title: validated.title === undefined ? current.title : validated.title,
      content: validated.content === undefined ? current.content : validated.content,
    });
    const { sync, persisted } = await this.#synchronize(note, "upsert");
    return { note: persisted, sync };
  }

  async delete(input) {
    const identity = validateNotesCommandInput("delete", input);
    const note = await this.repository.markForDelete(identity);
    if (!note) throw new NotesServiceError("NOTE_NOT_FOUND", "笔记不存在");
    const { sync, persisted } = await this.#synchronize(note, "delete");
    if (sync.status === "synced") {
      const purged = await this.repository.hardDelete(identity);
      return { noteId: note.noteId, deleted: true, purged, sync };
    }
    return { note: persisted, deleted: true, purged: false, sync };
  }

  async retry(input) {
    const identity = validateNotesCommandInput("retry", input);
    const note = await this.repository.findById({ ...identity, includeDeleted: true });
    if (!note) throw new NotesServiceError("NOTE_NOT_FOUND", "笔记不存在");
    if (!note.deletedAt && !["pending", "failed"].includes(note.syncStatus)) {
      throw new NotesServiceError("SYNC_NOT_PENDING", "笔记没有待重试的同步任务");
    }
    const operation = note.deletedAt || note.syncOperation === "delete"
      ? "delete"
      : "upsert";
    const { sync, persisted } = await this.#synchronize(note, operation);
    if (operation === "delete" && sync.status === "synced") {
      const purged = await this.repository.hardDelete(identity);
      return { noteId: note.noteId, deleted: true, purged, sync };
    }
    return { note: persisted, sync };
  }

  async close() {
    await this.closeResources();
  }
}

export { NOTE_KNOWLEDGE_BASE };
