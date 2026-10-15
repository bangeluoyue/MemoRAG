export class ApiError extends Error {
  constructor(message, { status = 0, code = "REQUEST_FAILED" } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function request(path, {
  method = "GET",
  body,
  signal,
  formData,
} = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      signal,
      credentials: "same-origin",
      ...(formData ? { body: formData } : body === undefined ? {} : {
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
  login({ email, password }) {
    return request("/api/auth/login", {
      method: "POST",
      body: { email, password },
    });
  },

  me() {
    return request("/api/auth/me");
  },

  logout() {
    return request("/api/auth/logout", { method: "POST" });
  },

  changeTesterPassword({ password, confirmPassword }) {
    return request("/api/admin/tester-password", {
      method: "PATCH",
      body: { password, confirmPassword },
    });
  },

  getBook(bookId, { signal } = {}) {
    return request(`/api/ebooks/${encoded(bookId)}`, { signal });
  },

  listEbooks({ signal } = {}) {
    return request("/api/ebooks", { signal });
  },

  uploadEpub(file) {
    const formData = new FormData();
    formData.append("file", file);
    return request("/api/ebooks/upload", {
      method: "POST",
      formData,
    });
  },

  askEbook({ question, bookId, signal }) {
    return request("/api/qa/ebook", {
      method: "POST",
      signal,
      body: { question, bookId, knowledgeBase: "ebook" },
    });
  },

  askNotes({ question, signal }) {
    return request("/api/qa/notes", {
      method: "POST",
      signal,
      body: { question, knowledgeBase: "life_notes" },
    });
  },

  listNotes({ limit = 100, signal } = {}) {
    return request(`/api/notes?limit=${limit}`, { signal });
  },

  getNote({ noteId, signal }) {
    return request(`/api/notes/${encoded(noteId)}`, { signal });
  },

  createNote({ title, content }) {
    return request("/api/notes", {
      method: "POST",
      body: { title, content, knowledgeBase: "life_notes" },
    });
  },

  updateNote({ noteId, title, content }) {
    return request(`/api/notes/${encoded(noteId)}`, {
      method: "PATCH",
      body: { title, content, knowledgeBase: "life_notes" },
    });
  },

  deleteNote({ noteId }) {
    return request(`/api/notes/${encoded(noteId)}`, {
      method: "DELETE",
    });
  },

  retryNote({ noteId }) {
    return request(`/api/notes/${encoded(noteId)}/retry`, {
      method: "POST",
      body: { knowledgeBase: "life_notes" },
    });
  },
};
