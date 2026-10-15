import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { AuthServiceError } from "../src/auth/index.js";
import { createHttpHandler } from "../src/http/app.js";
import { NotesServiceError } from "../src/notes/index.js";
import { EbookIngestionError } from "../src/rag/ebook/ingestion/index.js";
import {
  invokeModelWithTimeout,
  ModelInvocationTimeoutError,
} from "../src/rag/shared/timeouts.js";

function answer(label) {
  const notes = label === "notes";
  return {
    answer: `${label} answer`,
    sources: [{ reference: "本地1", id: `${label}-source` }],
    webSources: [],
    route: {
      strategy: notes ? "hybrid" : "complex",
      mode: "single_retrieval",
      reason: "test",
    },
    trace: {
      execution: { llmCallCount: notes ? 1 : 3, localRetrievalCount: 1 },
    },
  };
}

async function withApi(dependencies, run) {
  const handler = createHttpHandler(dependencies);
  await run((path, options) => request(handler, path, options));
}

async function request(handler, path, {
  method = "GET",
  body,
  rawBody,
  contentType,
  cookie = "memorag_session=admin",
} = {}) {
  const encodedBody = rawBody ?? (body === undefined ? null : Buffer.from(JSON.stringify(body)));
  const incoming = Readable.from(encodedBody ? [encodedBody] : []);
  incoming.method = method;
  incoming.url = path;
  incoming.headers = {
    ...(encodedBody ? { "content-type": contentType ?? "application/json" } : {}),
    ...(cookie ? { cookie } : {}),
  };
  incoming.socket = { remoteAddress: "127.0.0.1" };
  const response = {
    statusCode: null,
    headers: null,
    headersSent: false,
    chunks: [],
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
      this.headersSent = true;
    },
    end(chunk) {
      if (chunk) this.chunks.push(Buffer.from(chunk));
    },
  };
  await handler(incoming, response);
  const responseBody = Buffer.concat(response.chunks).toString("utf8");
  return {
    status: response.statusCode,
    headers: response.headers,
    async json() { return JSON.parse(responseBody); },
  };
}

function baseDependencies(overrides = {}) {
  const users = {
    admin: {
      email: "18296262260@163.com",
      role: "admin",
      notesUserId: "account-admin",
    },
    tester: {
      email: "test@123.com",
      role: "tester",
      notesUserId: "account-tester",
    },
  };
  return {
    ebookRag: { async ask() { return answer("ebook"); } },
    notesRag: { async ask() { return answer("notes"); } },
    notesService: {
      async create(input) { return { note: input, sync: { status: "synced" } }; },
      async get(input) { return { ...input, content: "正文" }; },
      async list(input) { return [{ ...input, noteId: "note-1" }]; },
      async update(input) { return { note: input, sync: { status: "synced" } }; },
      async delete(input) { return { ...input, deleted: true }; },
      async retry(input) { return { ...input, sync: { status: "synced" } }; },
    },
    authService: {
      async authenticate(cookie) {
        if (String(cookie).includes("tester")) return users.tester;
        if (String(cookie).includes("admin")) return users.admin;
        return null;
      },
      async login({ email, password }) {
        const user = email === users.admin.email && password === "admin-password"
          ? users.admin
          : email === users.tester.email && password === "123456"
            ? users.tester
            : null;
        if (!user) throw new AuthServiceError("INVALID_CREDENTIALS", "账号或密码错误");
        return { token: user.role, user: { email: user.email, role: user.role } };
      },
      async logout() {},
      async changeTesterPassword(actor) {
        if (actor.role !== "admin") throw new AuthServiceError("FORBIDDEN", "仅管理员可以修改测试员密码");
        return { user: { email: users.tester.email, role: users.tester.role } };
      },
      sessionCookie(token) { return `memorag_session=${token}; Path=/; HttpOnly; SameSite=Lax`; },
      clearSessionCookie() { return "memorag_session=; Path=/; HttpOnly; Max-Age=0"; },
      publicUser(user) { return { email: user.email, role: user.role }; },
    },
    ebookLibrary: {
      async getBookMetadata(bookId) { return { bookId, bookName: "测试书" }; },
      async upload() {
        return { status: "inserted", bookId: "epub-hash", bookName: "上传书籍" };
      },
    },
    logger: { error() {} },
    ...overrides,
  };
}

function multipartEpub(name = "demo.epub") {
  const boundary = "----memorag-test-boundary";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/epub+zip\r\n\r\n`,
  );
  const file = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    rawBody: Buffer.concat([head, file, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

test("HTTP auth login, session restore, logout, and protected-route checks are enforced", async () => {
  await withApi(baseDependencies(), async (requestApi) => {
    const unauthenticated = await requestApi("/api/qa/ebook", {
      method: "POST",
      body: { question: "测试", bookId: "book-1" },
      cookie: "",
    });
    assert.equal(unauthenticated.status, 401);
    assert.equal((await unauthenticated.json()).error.code, "AUTH_REQUIRED");

    const badLogin = await requestApi("/api/auth/login", {
      method: "POST",
      body: { email: "test@123.com", password: "wrong" },
      cookie: "",
    });
    assert.equal(badLogin.status, 401);
    assert.equal((await badLogin.json()).error.code, "INVALID_CREDENTIALS");

    const login = await requestApi("/api/auth/login", {
      method: "POST",
      body: { email: "test@123.com", password: "123456" },
      cookie: "",
    });
    assert.equal(login.status, 200);
    assert.match(login.headers["set-cookie"], /HttpOnly/u);
    assert.doesNotMatch(JSON.stringify(await login.json()), /123456/u);

    const me = await requestApi("/api/auth/me", { cookie: "memorag_session=tester" });
    assert.deepEqual(await me.json(), {
      user: { email: "test@123.com", role: "tester" },
    });
    const logout = await requestApi("/api/auth/logout", {
      method: "POST",
      cookie: "memorag_session=tester",
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers["set-cookie"], /Max-Age=0/u);
  });
});

test("HTTP derives note tenancy from the session and protects admin actions", async () => {
  const calls = [];
  await withApi(baseDependencies({
    notesService: {
      ...baseDependencies().notesService,
      async list(input) { calls.push(input); return []; },
    },
  }), async (requestApi) => {
    const testerNotes = await requestApi("/api/notes?userId=account-admin", {
      cookie: "memorag_session=tester",
    });
    assert.equal(testerNotes.status, 200);
    const adminNotes = await requestApi("/api/notes?userId=account-tester", {
      cookie: "memorag_session=admin",
    });
    assert.equal(adminNotes.status, 200);
    assert.deepEqual(calls, [
      { userId: "account-tester", limit: undefined },
      { userId: "account-admin", limit: undefined },
    ]);

    const forbidden = await requestApi("/api/admin/tester-password", {
      method: "PATCH",
      cookie: "memorag_session=tester",
      body: { password: "new-password", confirmPassword: "new-password" },
    });
    assert.equal(forbidden.status, 403);
    assert.equal((await forbidden.json()).error.code, "FORBIDDEN");

    const updated = await requestApi("/api/admin/tester-password", {
      method: "PATCH",
      body: { password: "new-password", confirmPassword: "new-password" },
    });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).user.email, "test@123.com");
  });
});

test("HTTP reads book names and restricts EPUB upload to administrators", async () => {
  const uploads = [];
  await withApi(baseDependencies({
    ebookLibrary: {
      async getBookMetadata(bookId) {
        return bookId === "book-1" ? { bookId, bookName: "Milvus 书名" } : null;
      },
      async upload(file) {
        uploads.push(file);
        return { status: "inserted", bookId: "epub-hash", bookName: "上传书籍" };
      },
    },
  }), async (requestApi) => {
    const metadata = await requestApi("/api/ebooks/book-1");
    assert.deepEqual(await metadata.json(), {
      book: { bookId: "book-1", bookName: "Milvus 书名" },
    });
    assert.equal((await requestApi("/api/ebooks/missing")).status, 404);

    const testerUpload = await requestApi("/api/ebooks/upload", {
      method: "POST",
      cookie: "memorag_session=tester",
      ...multipartEpub(),
    });
    assert.equal(testerUpload.status, 403);
    assert.equal(uploads.length, 0);

    const adminUpload = await requestApi("/api/ebooks/upload", {
      method: "POST",
      ...multipartEpub(),
    });
    assert.equal(adminUpload.status, 201);
    assert.equal((await adminUpload.json()).book.bookId, "epub-hash");
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].fileName, "demo.epub");
    assert.deepEqual([...uploads[0].bytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  });
});

test("HTTP reports an EPUB version conflict without presenting a partial upload as success", async () => {
  await withApi(baseDependencies({
    ebookLibrary: {
      async getBookMetadata() { return null; },
      async upload() {
        throw new EbookIngestionError(
          "BOOK_VERSION_CONFLICT",
          "bookId 已存在不同内容，不会自动覆盖",
        );
      },
    },
  }), async (requestApi) => {
    const response = await requestApi("/api/ebooks/upload", {
      method: "POST",
      ...multipartEpub("conflict.epub"),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: {
        code: "BOOK_VERSION_CONFLICT",
        message: "bookId 已存在不同内容，不会自动覆盖",
      },
    });
  });
});

test("HTTP API exposes health and isolated EPUB/notes RAG answers", async () => {
  const calls = [];
  await withApi(baseDependencies({
    ebookRag: {
      async ask(question, options) {
        calls.push({ target: "ebook", question, options });
        return answer("ebook");
      },
    },
    notesRag: {
      async ask(question, options) {
        calls.push({ target: "notes", question, options });
        return answer("notes");
      },
    },
  }), async (requestApi) => {
    const healthResponse = await requestApi("/health");
    assert.equal(healthResponse.status, 200);
    assert.deepEqual(await healthResponse.json(), {
      status: "ok",
      service: "memorag",
      dependencies: "not_checked",
    });

    const ebookResponse = await requestApi("/api/qa/ebook", {
      method: "POST",
      body: { question: "书里发生了什么？", bookId: "book-1" },
    });
    assert.equal(ebookResponse.status, 200);
    const ebook = await ebookResponse.json();
    assert.equal(ebook.answer, "ebook answer");
    assert.equal(ebook.route.mode, "single_retrieval");
    assert.equal(ebook.trace.execution.localRetrievalCount, 1);

    const notesResponse = await requestApi("/api/qa/notes", {
      method: "POST",
      body: { question: "我的安排是什么？", userId: "untrusted-client-value" },
    });
    assert.equal(notesResponse.status, 200);
    assert.equal((await notesResponse.json()).answer, "notes answer");
    assert.deepEqual(calls, [
      {
        target: "ebook",
        question: "书里发生了什么？",
        options: { bookId: "book-1" },
      },
      {
        target: "notes",
        question: "我的安排是什么？",
        options: { userId: "account-admin" },
      },
    ]);
  });
});

test("HTTP API maps note CRUD and retry without losing tenant scope", async () => {
  const calls = [];
  const notesService = Object.fromEntries(
    ["create", "get", "list", "update", "delete", "retry"].map((operation) => [
      operation,
      async (input) => {
        calls.push({ operation, input });
        if (operation === "list") return [{ noteId: "note-1" }];
        if (operation === "get") return { noteId: input.noteId, userId: input.userId };
        return { operation, ...input };
      },
    ]),
  );

  await withApi(baseDependencies({ notesService }), async (requestApi) => {
    assert.equal((await requestApi("/api/notes", {
      method: "POST",
      body: { userId: "user-1", title: "标题", content: "正文" },
    })).status, 201);
    assert.equal((await requestApi("/api/notes?userId=user-1&limit=10")).status, 200);
    assert.equal((await requestApi("/api/notes/note-1?userId=user-1")).status, 200);
    assert.equal((await requestApi("/api/notes/note-1", {
      method: "PATCH",
      body: { userId: "user-1", title: "新标题" },
    })).status, 200);
    assert.equal((await requestApi("/api/notes/note-1?userId=user-1", {
      method: "DELETE",
    })).status, 200);
    assert.equal((await requestApi("/api/notes/note-1/retry", {
      method: "POST",
      body: { userId: "user-1" },
    })).status, 200);

    assert.deepEqual(calls, [
      {
        operation: "create",
        input: { userId: "account-admin", title: "标题", content: "正文" },
      },
      { operation: "list", input: { userId: "account-admin", limit: "10" } },
      { operation: "get", input: { noteId: "note-1", userId: "account-admin" } },
      {
        operation: "update",
        input: { userId: "account-admin", title: "新标题", noteId: "note-1" },
      },
      { operation: "delete", input: { noteId: "note-1", userId: "account-admin" } },
      { operation: "retry", input: { noteId: "note-1", userId: "account-admin" } },
    ]);
  });
});

test("HTTP API rejects cross-knowledge-base input and hides internal errors", async () => {
  const logged = [];
  await withApi(baseDependencies({
    notesRag: {
      async ask() {
        throw new Error("secret backend response");
      },
    },
    notesService: {
      ...baseDependencies().notesService,
      async get() {
        throw new NotesServiceError("NOTE_NOT_FOUND", "笔记不存在");
      },
    },
    logger: { error(event) { logged.push(event); } },
  }), async (requestApi) => {
    const mismatch = await requestApi("/api/qa/ebook", {
      method: "POST",
      body: {
        question: "测试",
        bookId: "book-1",
        knowledgeBase: "life_notes",
      },
    });
    assert.equal(mismatch.status, 400);
    assert.equal((await mismatch.json()).error.code, "KNOWLEDGE_BASE_MISMATCH");

    const missing = await requestApi("/api/notes/note-1?userId=user-1");
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, "NOTE_NOT_FOUND");

    const failure = await requestApi("/api/qa/notes", {
      method: "POST",
      body: { question: "测试", userId: "user-1" },
    });
    assert.equal(failure.status, 500);
    const payload = await failure.json();
    assert.deepEqual(payload, {
      error: { code: "INTERNAL_ERROR", message: "服务暂时不可用" },
    });
    assert.doesNotMatch(JSON.stringify(payload), /secret backend/u);
    assert.deepEqual(logged, [{
      event: "http_request_failed",
      errorCategory: "Error",
      method: "POST",
      path: "/api/qa/notes",
    }]);
  });
});

test("HTTP API returns a safe 504 with the timed-out Agent stage", async () => {
  const logged = [];
  await withApi(baseDependencies({
    ebookRag: {
      async ask() {
        throw new ModelInvocationTimeoutError("evaluate", 60000, {
          timeoutDiagnostics: {
            routeMode: "single_retrieval",
            retrievalCount: 1,
            evaluationDocumentIds: ["doc-1", "doc-2"],
            evaluationDocumentCount: 2,
            requiredPlanItemCount: 1,
            inputCharacterCount: 4321,
            modelCallStartedAtMs: 123456789,
            prompt: "sensitive prompt must not be logged",
          },
        });
      },
    },
    logger: { error(event) { logged.push(event); } },
  }), async (requestApi) => {
    const response = await requestApi("/api/qa/ebook", {
      method: "POST",
      body: { question: "复杂问题", bookId: "book-1" },
    });
    assert.equal(response.status, 504);
    assert.deepEqual(await response.json(), {
      error: {
        code: "MODEL_TIMEOUT",
        message: "问答处理超时，请缩小问题范围后重试",
        stage: "evaluate",
        timeoutMs: 60000,
        timeoutSource: "application",
      },
    });
    assert.deepEqual(logged, [{
      event: "http_request_failed",
      errorCategory: "MODEL_TIMEOUT",
      method: "POST",
      path: "/api/qa/ebook",
      stage: "evaluate",
      timeoutSource: "application",
      timeoutDiagnostics: {
        routeMode: "single_retrieval",
        retrievalCount: 1,
        evaluationDocumentIds: ["doc-1", "doc-2"],
        evaluationDocumentCount: 2,
        requiredPlanItemCount: 1,
        inputCharacterCount: 4321,
        modelCallStartedAtMs: 123456789,
      },
    }]);
    assert.doesNotMatch(JSON.stringify(logged), /sensitive prompt/u);
  });
});

test("HTTP API returns a safe 504 for an SDK/upstream model timeout", async () => {
  const logged = [];
  await withApi(baseDependencies({
    ebookRag: {
      async ask() {
        return invokeModelWithTimeout({
          async invoke() {
            const error = new Error(
              "sensitive upstream URL, credential, and response",
            );
            error.name = "TimeoutError";
            throw error;
          },
        }, "input", { stage: "generate", timeoutMs: 60000 });
      },
    },
    logger: { error(event) { logged.push(event); } },
  }), async (requestApi) => {
    const response = await requestApi("/api/qa/ebook", {
      method: "POST",
      body: { question: "复杂问题", bookId: "book-1" },
    });
    assert.equal(response.status, 504);
    const payload = await response.json();
    assert.deepEqual(payload, {
      error: {
        code: "MODEL_TIMEOUT",
        message: "问答处理超时，请缩小问题范围后重试",
        stage: "generate",
        timeoutMs: 60000,
        timeoutSource: "sdk_or_upstream",
      },
    });
    assert.doesNotMatch(JSON.stringify(payload), /sensitive|credential|URL/u);
    assert.deepEqual(logged, [{
      event: "http_request_failed",
      errorCategory: "MODEL_TIMEOUT",
      method: "POST",
      path: "/api/qa/ebook",
      stage: "generate",
      timeoutSource: "sdk_or_upstream",
    }]);
  });
});
