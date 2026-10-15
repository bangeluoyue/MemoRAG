import { AuthServiceError } from "../auth/index.js";
import { NotesServiceError } from "../notes/index.js";
import { EbookLibraryError } from "../rag/ebook/library-service.js";
import { EbookIngestionError } from "../rag/ebook/ingestion/index.js";
import { EpubInputError } from "../rag/ebook/ingestion/epub-loader.js";
import { isRagTimeoutError } from "../rag/shared/timeouts.js";

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

function writeJson(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": JSON_CONTENT_TYPE,
    "content-length": Buffer.byteLength(body),
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(body);
}

async function readBuffer(request, bodyLimit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > bodyLimit) {
      throw new HttpError(413, "BODY_TOO_LARGE", "请求体过大");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request, bodyLimit) {
  const contentType = String(request.headers["content-type"] ?? "")
    .toLowerCase();
  if (!contentType.startsWith("application/json")) {
    throw new HttpError(415, "CONTENT_TYPE_UNSUPPORTED", "请求体必须是 JSON");
  }

  const buffer = await readBuffer(request, bodyLimit);
  if (!buffer.length) return {};

  try {
    const value = JSON.parse(buffer.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("JSON object required");
    }
    return value;
  } catch {
    throw new HttpError(400, "JSON_INVALID", "请求体不是有效的 JSON 对象");
  }
}

async function readEpubUpload(request, maxFileBytes) {
  const contentType = String(request.headers["content-type"] ?? "");
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    throw new HttpError(415, "CONTENT_TYPE_UNSUPPORTED", "上传请求必须使用 multipart/form-data");
  }
  const buffer = await readBuffer(request, maxFileBytes + (256 * 1024));
  let form;
  try {
    form = await new Request("http://127.0.0.1/api/ebooks/upload", {
      method: "POST",
      headers: { "content-type": contentType },
      body: buffer,
    }).formData();
  } catch {
    throw new HttpError(400, "MULTIPART_INVALID", "上传请求无法解析");
  }
  const file = form.get("file");
  if (!file || typeof file.arrayBuffer !== "function") {
    throw new HttpError(400, "EPUB_FILE_REQUIRED", "请选择 EPUB 文件");
  }
  if (file.size > maxFileBytes) {
    throw new HttpError(413, "EPUB_FILE_TOO_LARGE", "EPUB 文件超过大小限制");
  }
  return {
    fileName: file.name,
    mimeType: file.type,
    bytes: Buffer.from(await file.arrayBuffer()),
  };
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
  if (isRagTimeoutError(error)) return 504;
  if (error instanceof AuthServiceError) {
    if (["AUTH_REQUIRED", "INVALID_CREDENTIALS"].includes(error.code)) return 401;
    if (error.code === "FORBIDDEN") return 403;
    if (error.code === "AUTH_RATE_LIMITED") return 429;
    if (error.code === "INPUT_INVALID") return 400;
    return 500;
  }
  if (error instanceof EbookLibraryError) {
    if (error.code === "EPUB_FILE_TOO_LARGE") return 413;
    if (["INPUT_INVALID", "EPUB_FILE_INVALID"].includes(error.code)) return 400;
    return 500;
  }
  if (error instanceof EpubInputError) return 400;
  if (error instanceof EbookIngestionError) {
    if (error.code === "INPUT_INVALID") return 400;
    if (["BOOK_ALREADY_EXISTS", "BOOK_VERSION_CONFLICT", "BOOK_PARTIALLY_IMPORTED"].includes(error.code)) return 409;
    return 500;
  }
  if (error instanceof NotesServiceError) {
    if (error.code === "NOTE_NOT_FOUND") return 404;
    if (error.code === "SYNC_NOT_PENDING") return 409;
    return 400;
  }
  return 500;
}

function publicError(error) {
  if (
    error instanceof HttpError
    || error instanceof AuthServiceError
    || error instanceof NotesServiceError
    || error instanceof EbookLibraryError
    || error instanceof EpubInputError
    || error instanceof EbookIngestionError
  ) {
    return { code: error.code, message: error.message };
  }
  if (isRagTimeoutError(error)) {
    return {
      code: error.code,
      message: "问答处理超时，请缩小问题范围后重试",
      stage: error.stage,
      timeoutMs: error.timeoutMs,
      timeoutSource: error.timeoutSource,
    };
  }
  return { code: "INTERNAL_ERROR", message: "服务暂时不可用" };
}

function safeTimeoutDiagnostics(error) {
  if (!isRagTimeoutError(error) || error.stage !== "evaluate") return null;
  const diagnostics = error.timeoutDiagnostics;
  if (!diagnostics || typeof diagnostics !== "object") return null;
  const nonNegativeInteger = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
  };
  const routeMode = ["direct", "single_retrieval", "multi_hop"]
    .includes(diagnostics.routeMode)
    ? diagnostics.routeMode
    : "unknown";
  return {
    routeMode,
    retrievalCount: nonNegativeInteger(diagnostics.retrievalCount),
    evaluationDocumentIds: Array.isArray(diagnostics.evaluationDocumentIds)
      ? diagnostics.evaluationDocumentIds
        .slice(0, 6)
        .map((value) => String(value).slice(0, 128))
      : [],
    evaluationDocumentCount: nonNegativeInteger(
      diagnostics.evaluationDocumentCount,
    ),
    requiredPlanItemCount: nonNegativeInteger(
      diagnostics.requiredPlanItemCount,
    ),
    inputCharacterCount: nonNegativeInteger(diagnostics.inputCharacterCount),
    modelCallStartedAtMs: nonNegativeInteger(
      diagnostics.modelCallStartedAtMs,
    ),
  };
}

function safeEmbeddingDiagnostics(error) {
  if (!(error instanceof EbookIngestionError)
    || error.code !== "EMBEDDING_BATCH_FAILED") return null;
  const details = error.details;
  if (!details || typeof details !== "object") return null;
  const nonNegativeInteger = (value) => (
    Number.isInteger(Number(value)) && Number(value) >= 0
      ? Number(value)
      : null
  );
  const diagnostics = {
    batchIndex: nonNegativeInteger(details.batchIndex),
    batchNumber: nonNegativeInteger(details.batchNumber),
    textCount: nonNegativeInteger(details.textCount),
    durationMs: nonNegativeInteger(details.durationMs),
    insertedCount: nonNegativeInteger(details.insertedCount),
  };
  const status = Number(details.upstreamHttpStatus);
  if (Number.isInteger(status) && status >= 100 && status <= 599) {
    diagnostics.upstreamHttpStatus = status;
  }
  const type = String(details.upstreamErrorType ?? "");
  if (/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u.test(type)) {
    diagnostics.upstreamErrorType = type;
  }
  return diagnostics;
}

export function createHttpHandler({
  ebookRag,
  notesRag,
  notesService,
  authService,
  ebookLibrary,
  logger = console,
  bodyLimit = DEFAULT_BODY_LIMIT,
  epubUploadMaxBytes = 25 * 1024 * 1024,
}) {
  if (!ebookRag || !notesRag || !notesService || !authService || !ebookLibrary) {
    throw new Error("HTTP API 缺少 RAG、认证或 EPUB 管理依赖");
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

      if (request.method === "POST" && url.pathname === "/api/auth/login") {
        const body = await readJson(request, bodyLimit);
        const result = await authService.login({
          email: body.email,
          password: body.password,
          clientKey: request.socket?.remoteAddress ?? "local",
        });
        writeJson(response, 200, { user: result.user }, {
          "set-cookie": authService.sessionCookie(result.token),
          "cache-control": "no-store",
        });
        return;
      }

      const currentUser = await authService.authenticate(request.headers.cookie);

      if (request.method === "GET" && url.pathname === "/api/auth/me") {
        if (!currentUser) {
          throw new AuthServiceError("AUTH_REQUIRED", "请先登录");
        }
        writeJson(response, 200, { user: authService.publicUser(currentUser) }, {
          "cache-control": "no-store",
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/auth/logout") {
        await authService.logout(request.headers.cookie);
        writeJson(response, 200, { loggedOut: true }, {
          "set-cookie": authService.clearSessionCookie(),
          "cache-control": "no-store",
        });
        return;
      }

      if (!currentUser) {
        throw new AuthServiceError("AUTH_REQUIRED", "请先登录");
      }

      if (request.method === "PATCH" && url.pathname === "/api/admin/tester-password") {
        const body = await readJson(request, bodyLimit);
        if (body.password !== body.confirmPassword) {
          throw new AuthServiceError("INPUT_INVALID", "两次输入的新密码不一致");
        }
        const result = await authService.changeTesterPassword(
          currentUser,
          body.password,
        );
        writeJson(response, 200, result);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/ebooks/upload") {
        if (currentUser.role !== "admin") {
          throw new AuthServiceError("FORBIDDEN", "仅管理员可以上传 EPUB");
        }
        const upload = await readEpubUpload(request, epubUploadMaxBytes);
        const result = await ebookLibrary.upload(upload);
        writeJson(response, 201, { book: result });
        return;
      }

      const bookMetadataMatch = url.pathname.match(/^\/api\/ebooks\/([^/]+)$/u);
      if (request.method === "GET" && bookMetadataMatch) {
        let bookId;
        try {
          bookId = decodeURIComponent(bookMetadataMatch[1]);
        } catch {
          throw new HttpError(400, "INPUT_INVALID", "bookId 无效");
        }
        const book = await ebookLibrary.getBookMetadata(bookId);
        if (!book) {
          throw new HttpError(404, "BOOK_NOT_FOUND", "未找到对应书籍");
        }
        writeJson(response, 200, { book });
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
          userId: currentUser.notesUserId,
        });
        writeJson(response, 200, result);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/notes") {
        const body = await readJson(request, bodyLimit);
        fixedKnowledgeBase(body.knowledgeBase, "life_notes");
        const result = await notesService.create({
          ...body,
          userId: currentUser.notesUserId,
        });
        writeJson(response, 201, result);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/notes") {
        const notes = await notesService.list({
          userId: currentUser.notesUserId,
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
          userId: currentUser.notesUserId,
        });
        writeJson(response, 200, result);
        return;
      }

      const noteId = noteIdFromPath(url.pathname);
      if (request.method === "GET" && noteId) {
        const note = await notesService.get({
          noteId,
          userId: currentUser.notesUserId,
        });
        if (!note) throw new NotesServiceError("NOTE_NOT_FOUND", "笔记不存在");
        writeJson(response, 200, { note });
        return;
      }
      if (request.method === "PATCH" && noteId) {
        const body = await readJson(request, bodyLimit);
        fixedKnowledgeBase(body.knowledgeBase, "life_notes");
        const result = await notesService.update({
          ...body,
          noteId,
          userId: currentUser.notesUserId,
        });
        writeJson(response, 200, result);
        return;
      }
      if (request.method === "DELETE" && noteId) {
        const result = await notesService.delete({
          noteId,
          userId: currentUser.notesUserId,
        });
        writeJson(response, 200, result);
        return;
      }

      throw new HttpError(404, "NOT_FOUND", "接口不存在");
    } catch (error) {
      const status = statusForError(error);
      if (status >= 500 && typeof logger?.error === "function") {
        try {
          const timeoutDiagnostics = safeTimeoutDiagnostics(error);
          const embeddingDiagnostics = safeEmbeddingDiagnostics(error);
          logger.error({
            event: "http_request_failed",
            errorCategory: String(error?.code ?? error?.name ?? "Error"),
            method: request.method,
            path: url?.pathname ?? "",
            ...(isRagTimeoutError(error) ? {
              stage: error.stage,
              timeoutSource: error.timeoutSource,
              ...(timeoutDiagnostics ? { timeoutDiagnostics } : {}),
            } : {}),
            ...(embeddingDiagnostics ? { embeddingDiagnostics } : {}),
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
