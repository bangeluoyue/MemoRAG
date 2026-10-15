import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createHttpHandler } from "../src/http/app.js";
import { NotesServiceError } from "../src/notes/index.js";
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

async function request(handler, path, { method = "GET", body } = {}) {
  const encodedBody = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const incoming = Readable.from(encodedBody ? [encodedBody] : []);
  incoming.method = method;
  incoming.url = path;
  incoming.headers = encodedBody ? { "content-type": "application/json" } : {};
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
    async json() { return JSON.parse(responseBody); },
  };
}

function baseDependencies(overrides = {}) {
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
    logger: { error() {} },
    ...overrides,
  };
}

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
      body: { question: "我的安排是什么？", userId: "user-1" },
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
        options: { userId: "user-1" },
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
        input: { userId: "user-1", title: "标题", content: "正文" },
      },
      { operation: "list", input: { userId: "user-1", limit: "10" } },
      { operation: "get", input: { noteId: "note-1", userId: "user-1" } },
      {
        operation: "update",
        input: { userId: "user-1", title: "新标题", noteId: "note-1" },
      },
      { operation: "delete", input: { noteId: "note-1", userId: "user-1" } },
      { operation: "retry", input: { noteId: "note-1", userId: "user-1" } },
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
