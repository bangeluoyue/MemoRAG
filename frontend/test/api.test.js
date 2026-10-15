import { afterEach, describe, expect, test, vi } from "vitest";
import { api, ApiError } from "../src/api.js";

function response(payload, { ok = true, status = 200 } = {}) {
  return { ok, status, async json() { return payload; } };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("API client", () => {
  test("uses the frozen knowledge-base contracts for both QA endpoints", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ answer: "ok" }));
    vi.stubGlobal("fetch", fetchMock);

    await api.askEbook({ question: "书中发生了什么？", bookId: "book-1" });
    await api.askNotes({ question: "我的安排是什么？" });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/qa/ebook", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        question: "书中发生了什么？",
        bookId: "book-1",
        knowledgeBase: "ebook",
      }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/qa/notes", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        question: "我的安排是什么？",
        knowledgeBase: "life_notes",
      }),
    }));
  });

  test("maps note CRUD and retry to the existing HTTP paths", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({}));
    vi.stubGlobal("fetch", fetchMock);

    await api.listNotes({ limit: 20 });
    await api.getNote({ noteId: "note/1" });
    await api.createNote({ title: "标题", content: "正文" });
    await api.updateNote({ noteId: "note-1", title: "新标题", content: "新正文" });
    await api.deleteNote({ noteId: "note-1" });
    await api.retryNote({ noteId: "note-1" });

    expect(fetchMock.mock.calls.map(([path, options]) => [path, options?.method ?? "GET"])).toEqual([
      ["/api/notes?limit=20", "GET"],
      ["/api/notes/note%2F1", "GET"],
      ["/api/notes", "POST"],
      ["/api/notes/note-1", "PATCH"],
      ["/api/notes/note-1", "DELETE"],
      ["/api/notes/note-1/retry", "POST"],
    ]);
  });

  test("maps authentication, book metadata, and EPUB upload without storing a token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ user: { role: "admin" } }));
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["epub"], "demo.epub", { type: "application/epub+zip" });

    await api.login({ email: "admin@example.com", password: "secret" });
    await api.me();
    await api.logout();
    await api.changeTesterPassword({ password: "new-password", confirmPassword: "new-password" });
    await api.getBook("book/1");
    await api.uploadEpub(file);

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/auth/login",
      "/api/auth/me",
      "/api/auth/logout",
      "/api/admin/tester-password",
      "/api/ebooks/book%2F1",
      "/api/ebooks/upload",
    ]);
    for (const [, options] of fetchMock.mock.calls) {
      expect(options.credentials).toBe("same-origin");
    }
    const uploadOptions = fetchMock.mock.calls[5][1];
    expect(uploadOptions.body).toBeInstanceOf(FormData);
    expect(uploadOptions.headers).toBeUndefined();
  });

  test("surfaces safe backend errors and connection failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
      error: { code: "INPUT_INVALID", message: "参数无效" },
    }, { ok: false, status: 400 })));
    await expect(api.listNotes()).rejects.toMatchObject({
      name: "ApiError",
      code: "INPUT_INVALID",
      status: 400,
      message: "参数无效",
    });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network")));
    await expect(api.listNotes()).rejects.toBeInstanceOf(ApiError);
    await expect(api.listNotes()).rejects.toThrow("无法连接后端服务");
  });
});
