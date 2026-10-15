import { afterEach, expect, test, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../src/App.jsx";

function response(payload, { ok = true, status = 200 } = {}) {
  return { ok, status, async json() { return payload; } };
}

function answer({ notes = false } = {}) {
  return {
    answer: notes ? "体检安排在周五上午 [本地1]。" : "人物做出决定是为了保护朋友 [本地1]。",
    route: {
      strategy: notes ? "hybrid" : "complex",
      mode: "single_retrieval",
      reason: notes ? "ES + Milvus + RRF" : "一个问题即可检索",
    },
    sources: [{
      id: notes ? "note-1" : "doc-1",
      ...(notes
        ? {
          noteId: "note-1",
          knowledgeBase: "life_notes",
          userId: "demo-user",
          title: "体检安排",
          metadata: { title: "体检安排" },
        }
        : { bookName: "演示书籍", chapterNum: 4, chunkIndex: 2 }),
      reference: "本地1",
      score: 0.92,
      content: notes ? "周五上午九点去医院体检。" : "这是电子书中的原文证据。",
    }],
    webSources: [],
    trace: {
      retrievalCount: 1,
      execution: {
        totalDurationMs: 1250,
        llmCallCount: notes ? 1 : 3,
        localRetrievalCount: 1,
        rerankRequestCount: 0,
        webSearchCount: 0,
      },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("unauthenticated users see login errors, can sign in, restore the workspace, and log out", async () => {
  const user = userEvent.setup();
  let loginCount = 0;
  const fetchMock = vi.fn(async (path, options = {}) => {
    if (path === "/api/auth/me") {
      return response({ error: { code: "AUTH_REQUIRED", message: "请先登录" } }, { ok: false, status: 401 });
    }
    if (path === "/api/auth/login") {
      loginCount += 1;
      if (loginCount === 1) {
        return response({ error: { code: "INVALID_CREDENTIALS", message: "账号或密码错误" } }, { ok: false, status: 401 });
      }
      return response({ user: { email: "test@123.com", role: "tester" } });
    }
    if (path === "/api/auth/logout") return response({ loggedOut: true });
    if (path === "/api/ebooks") return response({ books: [] });
    if (path === "/api/ebooks/1") {
      return response({ error: { code: "BOOK_NOT_FOUND", message: "未找到对应书籍" } }, { ok: false, status: 404 });
    }
    throw new Error(`unexpected request: ${options.method || "GET"} ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);

  await user.type(await screen.findByLabelText("账号"), "test@123.com");
  await user.type(screen.getByLabelText("密码"), "wrong");
  await user.click(screen.getByRole("button", { name: "登录" }));
  expect(await screen.findByText("账号或密码错误")).toBeTruthy();
  await user.clear(screen.getByLabelText("密码"));
  await user.type(screen.getByLabelText("密码"), "123456");
  await user.click(screen.getByRole("button", { name: "登录" }));
  expect(await screen.findByLabelText("你想从书中了解什么？")).toBeTruthy();
  expect(await screen.findByText("未找到对应书籍")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /管理员设置/u })).toBeNull();
  await user.click(screen.getByRole("button", { name: "退出登录" }));
  expect(await screen.findByRole("heading", { name: "登录 MemoRAG" })).toBeTruthy();
});

test("administrator can reset the tester password and upload an EPUB", async () => {
  const user = userEvent.setup();
  let bookListCount = 0;
  const fetchMock = vi.fn(async (path, options = {}) => {
    if (path === "/api/auth/me") {
      return response({ user: { email: "18296262260@163.com", role: "admin" } });
    }
    if (path === "/api/ebooks") {
      bookListCount += 1;
      return response({
        books: bookListCount > 1
          ? [
            { bookId: "1", bookName: "天龙八部" },
            { bookId: "epub-hash", bookName: "上传书籍" },
          ]
          : [{ bookId: "1", bookName: "天龙八部" }],
      });
    }
    if (path === "/api/admin/tester-password" && options.method === "PATCH") {
      return response({ user: { email: "test@123.com", role: "tester" } });
    }
    if (path === "/api/ebooks/upload" && options.method === "POST") {
      return response({ book: { bookId: "epub-hash", bookName: "上传书籍", status: "inserted" } }, { status: 201 });
    }
    throw new Error(`unexpected request: ${options.method || "GET"} ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);

  await user.click(await screen.findByRole("button", { name: /管理员设置/u }));
  await user.type(screen.getByLabelText("新密码"), "new-password");
  await user.type(screen.getByLabelText("确认新密码"), "new-password");
  await user.click(screen.getByRole("button", { name: "保存新密码" }));
  expect(await screen.findByText(/测试员密码已更新/u)).toBeTruthy();

  await user.click(screen.getByRole("button", { name: /电子书问答/u }));
  const bookListCountBeforeUpload = bookListCount;
  const file = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], "demo.epub", {
    type: "application/epub+zip",
  });
  await user.upload(await screen.findByLabelText("选择 EPUB 文件"), file);
  await user.click(screen.getByRole("button", { name: "上传并入库" }));
  expect(await screen.findByText(/入库完成：上传书籍/u)).toBeTruthy();
  expect(screen.getByLabelText("选择电子书").value).toBe("epub-hash");
  expect(bookListCount).toBe(bookListCountBeforeUpload + 1);
});

test("electronic-book QA shows processing, execution metrics, and expandable source text", async () => {
  const user = userEvent.setup();
  let resolveQa;
  const fetchMock = vi.fn((path) => {
    if (path === "/api/auth/me") {
      return Promise.resolve(response({ user: { email: "test@123.com", role: "tester" } }));
    }
    if (path === "/api/ebooks") {
      return Promise.resolve(response({ books: [
        { bookId: "1", bookName: "演示书籍" },
        { bookId: "epub-hash", bookName: "第二本书" },
      ] }));
    }
    if (path === "/api/qa/ebook") {
      return new Promise((resolve) => { resolveQa = resolve; });
    }
    throw new Error(`unexpected request: ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);

  expect(screen.queryByRole("button", { name: /上传/u })).toBeNull();
  await screen.findByRole("option", { name: "第二本书" });
  await user.selectOptions(screen.getByLabelText("选择电子书"), "epub-hash");
  expect(screen.getByText("epub-hash")).toBeTruthy();
  await user.type(await screen.findByLabelText("你想从书中了解什么？"), "人物为什么这样做？");
  await user.click(screen.getByRole("button", { name: "发送问题" }));
  expect(screen.getByText("Agent 正在处理")).toBeTruthy();

  await act(async () => {
    resolveQa(response(answer()));
  });
  expect(await screen.findByText(/为了保护朋友/u)).toBeTruthy();
  expect(screen.getByText("3")).toBeTruthy();
  const sourceTitle = screen.getAllByText("演示书籍")
    .find((element) => element.closest("details"));
  const details = sourceTitle.closest("details");
  expect(details.open).toBe(false);
  await user.click(sourceTitle);
  expect(details.open).toBe(true);
  expect(screen.getByText("这是电子书中的原文证据。")).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledWith("/api/qa/ebook", expect.objectContaining({ method: "POST" }));
  const qaCall = fetchMock.mock.calls.find(([path]) => path === "/api/qa/ebook");
  expect(JSON.parse(qaCall[1].body).bookId).toBe("epub-hash");
});

test("ebook list failures keep a manual bookId fallback", async () => {
  const fetchMock = vi.fn(async (path) => {
    if (path === "/api/auth/me") {
      return response({ user: { email: "test@123.com", role: "tester" } });
    }
    if (path === "/api/ebooks") {
      return response({ error: { code: "BOOK_LIST_READ_FAILED", message: "无法读取 EPUB 书籍列表" } }, { ok: false, status: 500 });
    }
    if (path === "/api/ebooks/1") {
      return response({ book: { bookId: "1", bookName: "备用书籍" } });
    }
    throw new Error(`unexpected request: ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);

  expect(await screen.findByText(/书籍列表加载失败/u)).toBeTruthy();
  expect(screen.getByLabelText("手动输入 bookId").value).toBe("1");
  expect(await screen.findByText("备用书籍")).toBeTruthy();
});

test("life-notes page loads scoped notes, opens details, and retries failed sync", async () => {
  const user = userEvent.setup();
  const failedNote = {
    noteId: "note-1",
    userId: "demo-user",
    title: "体检安排",
    content: "周五上午体检",
    syncStatus: "failed",
    syncAttempts: 1,
    syncErrorCategory: "MILVUS_SYNC_FAILED",
    updatedAt: "2026-10-14T08:00:00.000Z",
  };
  const fetchMock = vi.fn(async (path, options = {}) => {
    if (path === "/api/auth/me") {
      return response({ user: { email: "test@123.com", role: "tester" } });
    }
    if (path === "/api/ebooks") {
      return response({ books: [{ bookId: "1", bookName: "演示书籍" }] });
    }
    if (path === "/api/notes?limit=100") {
      return response({ notes: [failedNote] });
    }
    if (path === "/api/notes/note-1" && options.method === "GET") {
      return response({ note: failedNote });
    }
    if (path === "/api/notes/note-1/retry") {
      return response({ note: { ...failedNote, syncStatus: "synced" }, sync: { status: "synced" } });
    }
    throw new Error(`unexpected request: ${options.method || "GET"} ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);

  await user.click(await screen.findByRole("button", { name: /生活笔记/u }));
  expect(await screen.findByText("体检安排")).toBeTruthy();
  expect(screen.getByText("同步失败")).toBeTruthy();
  await user.click(screen.getByText("体检安排").closest("button"));
  expect(await screen.findByText(/MILVUS_SYNC_FAILED/u)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "重试同步" }));
  expect(await screen.findByText("索引同步重试成功。")).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledWith("/api/notes/note-1/retry", expect.objectContaining({ method: "POST" }));
});

test("life-notes page creates a note and exposes notes AI answers with source content", async () => {
  const user = userEvent.setup();
  const created = {
    noteId: "note-new",
    userId: "demo-user",
    title: "旅行计划",
    content: "周六去杭州",
    syncStatus: "synced",
  };
  let listCount = 0;
  const fetchMock = vi.fn(async (path, options = {}) => {
    if (path === "/api/auth/me") {
      return response({ user: { email: "test@123.com", role: "tester" } });
    }
    if (path === "/api/ebooks") {
      return response({ books: [{ bookId: "1", bookName: "演示书籍" }] });
    }
    if (path === "/api/notes?limit=100") {
      listCount += 1;
      return response({ notes: listCount > 1 ? [created] : [] });
    }
    if (path === "/api/notes" && options.method === "POST") {
      return response({ note: created, sync: { status: "synced" } }, { status: 201 });
    }
    if (path === "/api/qa/notes" && options.method === "POST") {
      return response(answer({ notes: true }));
    }
    throw new Error(`unexpected request: ${options.method || "GET"} ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);

  await user.click(await screen.findByRole("button", { name: /生活笔记/u }));
  expect(await screen.findByText("还没有笔记")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "新建笔记" }));
  await user.type(screen.getByLabelText("标题"), "旅行计划");
  await user.type(screen.getByLabelText("正文"), "周六去杭州");
  await user.click(screen.getByRole("button", { name: "保存并同步索引" }));
  expect(await screen.findByText("笔记已保存，双索引同步完成。")).toBeTruthy();

  await user.type(screen.getByLabelText("基于笔记提问"), "我的体检是什么时候？");
  await user.click(screen.getByRole("button", { name: "向笔记提问" }));
  expect(await screen.findByText(/体检安排在周五上午/u)).toBeTruthy();
  await user.click(screen.getByText("体检安排"));
  expect(screen.getByText("周五上午九点去医院体检。")).toBeTruthy();
});
