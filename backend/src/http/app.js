import { NotesServiceError, validateNotesCommandInput } from "../notes/index.js";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const DEFAULT_BODY_LIMIT = 256 * 1024;
const SAFE_ID = /^[\w.:-]+$/u;

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

function writeJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": JSON_CONTENT_TYPE,
    "content-length": Buffer.byteLength(body),
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

async function readJson(request, bodyLimit) {
  const contentType = String(request.headers["content-type"] ?? "")
    .toLowerCase();
  if (!contentType.startsWith("application/json")) {
    throw new HttpError(415, "CONTENT_TYPE_UNSUPPORTED", "请求体必须是 JSON");
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > bodyLimit) {
      throw new HttpError(413, "BODY_TOO_LARGE", "请求体过大");
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};

  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("JSON object required");
    }
    return value;
  } catch {
    throw new HttpError(400, "JSON_INVALID", "请求体不是有效的 JSON 对象");
  }
}

function question(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new HttpError(400, "INPUT_INVALID", "question 不能为空");
  }
  if (normalized.length > 4000) {
    throw new HttpError(400, "INPUT_INVALID", "question 不能超过 4000 个字符");
  }
  return normalized;
}

function identifier(value, name) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > 128 || !SAFE_ID.test(normalized)) {
    throw new HttpError(400, "INPUT_INVALID", `${name} 无效`);
  }
  return normalized;
}

function fixedKnowledgeBase(value, expected) {
  if (value !== undefined && String(value).trim() !== expected) {
    throw new HttpError(400, "KNOWLEDGE_BASE_MISMATCH", "知识库范围与接口不匹配");
  }
}

function noteIdFromPath(pathname, suffix = "") {
  const pattern = suffix
    ? new RegExp(`^/api/notes/([^/]+)/${suffix}$`, "u")
    : /^\/api\/notes\/([^/]+)$/u;
  const match = pathname.match(pattern);
  if (!match) return null;
  try {
    return identifier(decodeURIComponent(match[1]), "noteId");
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "INPUT_INVALID", "noteId 无效");
  }
}

function statusForError(error) {
  if (error instanceof HttpError) return error.status;
  if (error instanceof NotesServiceError) {
    if (error.code === "NOTE_NOT_FOUND") return 404;
    if (error.code === "SYNC_NOT_PENDING") return 409;
    return 400;
  }
  return 500;
}

function publicError(error) {
  if (error instanceof HttpError || error instanceof NotesServiceError) {
    return { code: error.code, message: error.message };
  }
  return { code: "INTERNAL_ERROR", message: "服务暂时不可用" };
}

function validatedUserId(value) {
  return validateNotesCommandInput("list", { userId: value, limit: 1 }).userId;
}

export function createHttpHandler({
  ebookRag,
  notesRag,
  notesService,
  logger = console,
  bodyLimit = DEFAULT_BODY_LIMIT,
}) {
  if (!ebookRag || !notesRag || !notesService) {
    throw new Error("HTTP API 缺少 ebookRag、notesRag 或 notesService");
  }

  return async function handleRequest(request, response) {
    let url;

    try {
      try {
        url = new URL(request.url ?? "/", "http://127.0.0.1");
      } catch {
        throw new HttpError(400, "URL_INVALID", "请求 URL 无效");
      }
      if (request.method === "GET" && url.pathname === "/health") {
        writeJson(response, 200, {
          status: "ok",
          service: "memorag",
          dependencies: "not_checked",
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/qa/ebook") {
        const body = await readJson(request, bodyLimit);
        fixedKnowledgeBase(body.knowledgeBase, "ebook");
        const result = await ebookRag.ask(question(body.question), {
          bookId: identifier(body.bookId, "bookId"),
        });
        writeJson(response, 200, result);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/qa/notes") {
        const body = await readJson(request, bodyLimit);
        fixedKnowledgeBase(body.knowledgeBase, "life_notes");
        const result = await notesRag.ask(question(body.question), {
          userId: validatedUserId(body.userId),
        });
        writeJson(response, 200, result);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/notes") {
        const body = await readJson(request, bodyLimit);
        fixedKnowledgeBase(body.knowledgeBase, "life_notes");
        const result = await notesService.create(body);
        writeJson(response, 201, result);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/notes") {
        const notes = await notesService.list({
          userId: url.searchParams.get("userId"),
          limit: url.searchParams.get("limit") ?? undefined,
        });
        writeJson(response, 200, { notes });
        return;
      }

      const retryNoteId = noteIdFromPath(url.pathname, "retry");
      if (request.method === "POST" && retryNoteId) {
        const body = await readJson(request, bodyLimit);
        fixedKnowledgeBase(body.knowledgeBase, "life_notes");
        const result = await notesService.retry({
          noteId: retryNoteId,
          userId: body.userId,
        });
        writeJson(response, 200, result);
        return;
      }

      const noteId = noteIdFromPath(url.pathname);
      if (request.method === "GET" && noteId) {
        const note = await notesService.get({
          noteId,
          userId: url.searchParams.get("userId"),
        });
        if (!note) throw new NotesServiceError("NOTE_NOT_FOUND", "笔记不存在");
        writeJson(response, 200, { note });
        return;
      }
      if (request.method === "PATCH" && noteId) {
        const body = await readJson(request, bodyLimit);
        fixedKnowledgeBase(body.knowledgeBase, "life_notes");
        const result = await notesService.update({ ...body, noteId });
        writeJson(response, 200, result);
        return;
      }
      if (request.method === "DELETE" && noteId) {
        const result = await notesService.delete({
          noteId,
          userId: url.searchParams.get("userId"),
        });
        writeJson(response, 200, result);
        return;
      }

      throw new HttpError(404, "NOT_FOUND", "接口不存在");
    } catch (error) {
      const status = statusForError(error);
      if (status === 500 && typeof logger?.error === "function") {
        try {
          logger.error({
            event: "http_request_failed",
            errorCategory: String(error?.name ?? "Error"),
            method: request.method,
            path: url?.pathname ?? "",
          });
        } catch {
          // Logging must not replace the safe HTTP response.
        }
      }
      if (!response.headersSent) {
        writeJson(response, status, { error: publicError(error) });
      } else {
        response.end();
      }
    }
  };
}
