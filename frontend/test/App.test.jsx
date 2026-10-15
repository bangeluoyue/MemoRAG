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

test("electronic-book QA shows processing, execution metrics, and expandable source text", async () => {
  const user = userEvent.setup();
  let resolveFetch;
  const fetchMock = vi.fn().mockReturnValue(new Promise((resolve) => {
    resolveFetch = resolve;
  }));
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);

  expect(screen.queryByRole("button", { name: /上传/u })).toBeNull();
  await user.type(screen.getByLabelText("你想从书中了解什么？"), "人物为什么这样做？");
  await user.click(screen.getByRole("button", { name: "发送问题" }));
  expect(screen.getByText("Agent 正在处理")).toBeTruthy();

  await act(async () => {
    resolveFetch(response(answer()));
  });
  expect(await screen.findByText(/为了保护朋友/u)).toBeTruthy();
  expect(screen.getByText("3")).toBeTruthy();
  const details = screen.getByText("演示书籍").closest("details");
  expect(details.open).toBe(false);
  await user.click(screen.getByText("演示书籍"));
  expect(details.open).toBe(true);
  expect(screen.getByText("这是电子书中的原文证据。")).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledWith("/api/qa/ebook", expect.objectContaining({ method: "POST" }));
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
    if (path === "/api/notes?userId=demo-user&limit=100") {
      return response({ notes: [failedNote] });
    }
    if (path === "/api/notes/note-1?userId=demo-user" && options.method === "GET") {
      return response({ note: failedNote });
    }
    if (path === "/api/notes/note-1/retry") {
      return response({ note: { ...failedNote, syncStatus: "synced" }, sync: { status: "synced" } });
    }
    throw new Error(`unexpected request: ${options.method || "GET"} ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);

  await user.click(screen.getByRole("button", { name: /生活笔记/u }));
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
    if (path === "/api/notes?userId=demo-user&limit=100") {
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

  await user.click(screen.getByRole("button", { name: /生活笔记/u }));
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
