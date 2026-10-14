export class ApiError extends Error {
  constructor(message, { status = 0, code = "REQUEST_FAILED" } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function request(path, { method = "GET", body, signal } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      signal,
      ...(body === undefined ? {} : {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new ApiError("无法连接后端服务，请确认 MemoRAG API 已启动");
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError("后端返回了无法解析的响应", { status: response.status });
  }

  if (!response.ok) {
    throw new ApiError(
      payload?.error?.message || `请求失败（HTTP ${response.status}）`,
      {
        status: response.status,
        code: payload?.error?.code || "REQUEST_FAILED",
      },
    );
  }
  return payload;
}

function encoded(value) {
  return encodeURIComponent(String(value ?? "").trim());
}

export const api = {
  askEbook({ question, bookId, signal }) {
    return request("/api/qa/ebook", {
      method: "POST",
      signal,
      body: { question, bookId, knowledgeBase: "ebook" },
    });
  },

  askNotes({ question, userId, signal }) {
    return request("/api/qa/notes", {
      method: "POST",
      signal,
      body: { question, userId, knowledgeBase: "life_notes" },
    });
  },

  listNotes({ userId, limit = 100, signal }) {
    return request(`/api/notes?userId=${encoded(userId)}&limit=${limit}`, { signal });
  },

  getNote({ noteId, userId, signal }) {
    return request(`/api/notes/${encoded(noteId)}?userId=${encoded(userId)}`, { signal });
  },

  createNote({ userId, title, content }) {
    return request("/api/notes", {
      method: "POST",
      body: { userId, title, content, knowledgeBase: "life_notes" },
    });
  },

  updateNote({ noteId, userId, title, content }) {
    return request(`/api/notes/${encoded(noteId)}`, {
      method: "PATCH",
      body: { userId, title, content, knowledgeBase: "life_notes" },
    });
  },

  deleteNote({ noteId, userId }) {
    return request(`/api/notes/${encoded(noteId)}?userId=${encoded(userId)}`, {
      method: "DELETE",
    });
  },

  retryNote({ noteId, userId }) {
    return request(`/api/notes/${encoded(noteId)}/retry`, {
      method: "POST",
      body: { userId, knowledgeBase: "life_notes" },
    });
  },
};
