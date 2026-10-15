import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { AnswerPanel } from "./AnswerPanel.jsx";

export function EbookQa({ currentUser }) {
  const [bookId, setBookId] = useState("1");
  const [question, setQuestion] = useState("");
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [books, setBooks] = useState([]);
  const [bookListStatus, setBookListStatus] = useState("loading");
  const [bookListError, setBookListError] = useState("");
  const [bookStatus, setBookStatus] = useState("loading");
  const [book, setBook] = useState(null);
  const [bookError, setBookError] = useState("");
  const [uploadFile, setUploadFile] = useState(null);
  const [uploadStatus, setUploadStatus] = useState("idle");
  const [uploadMessage, setUploadMessage] = useState("");
  const controllerRef = useRef(null);

  const loadBooks = useCallback(async ({ signal, preferredBook } = {}) => {
    setBookListStatus("loading");
    setBookListError("");
    try {
      const result = await api.listEbooks({ signal });
      const nextBooks = Array.isArray(result.books)
        ? result.books.filter((item) => item?.bookId && item?.bookName)
        : [];
      if (preferredBook?.bookId
        && !nextBooks.some((item) => item.bookId === preferredBook.bookId)) {
        nextBooks.push(preferredBook);
      }
      setBooks(nextBooks);
      setBookListStatus("success");
      setBookId((current) => {
        if (preferredBook?.bookId) return preferredBook.bookId;
        if (nextBooks.some((item) => item.bookId === current)) return current;
        return nextBooks[0]?.bookId ?? current;
      });
    } catch (requestError) {
      if (requestError?.name === "AbortError") return;
      setBooks([]);
      setBookListStatus("error");
      setBookListError(requestError.message);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadBooks({ signal: controller.signal });
    return () => controller.abort();
  }, [loadBooks]);

  useEffect(() => {
    const normalizedBookId = bookId.trim();
    if (!normalizedBookId) {
      setBook(null);
      setBookStatus("idle");
      setBookError("");
      return undefined;
    }
    const listedBook = books.find((item) => item.bookId === normalizedBookId);
    if (listedBook) {
      setBook(listedBook);
      setBookStatus("success");
      setBookError("");
      return undefined;
    }
    if (bookListStatus === "loading") return undefined;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setBookStatus("loading");
      setBookError("");
      try {
        const result = await api.getBook(normalizedBookId, { signal: controller.signal });
        setBook(result.book);
        setBookStatus("success");
      } catch (requestError) {
        if (requestError?.name === "AbortError") return;
        setBook(null);
        setBookStatus(requestError.code === "BOOK_NOT_FOUND" ? "not_found" : "error");
        setBookError(requestError.message);
      }
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [bookId, bookListStatus, books]);

  async function upload(event) {
    event.preventDefault();
    if (!uploadFile) {
      setUploadStatus("error");
      setUploadMessage("请选择 EPUB 文件。");
      return;
    }
    setUploadStatus("loading");
    setUploadMessage("");
    try {
      const result = await api.uploadEpub(uploadFile);
      setUploadStatus("success");
      setUploadMessage(`入库完成：${result.book.bookName}（${result.book.bookId}）`);
      setBookId(result.book.bookId);
      setBook({ bookId: result.book.bookId, bookName: result.book.bookName });
      setBookStatus("success");
      setUploadFile(null);
      await loadBooks({ preferredBook: result.book });
    } catch (requestError) {
      setUploadStatus("error");
      setUploadMessage(requestError.message);
    }
  }

  async function submit(event) {
    event.preventDefault();
    const normalizedBookId = bookId.trim();
    const normalizedQuestion = question.trim();
    if (!normalizedBookId || !normalizedQuestion) {
      setError("请选择书籍并填写问题。");
      return;
    }

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setStatus("loading");
    setError("");
    setResult(null);
    try {
      const answer = await api.askEbook({
        bookId: normalizedBookId,
        question: normalizedQuestion,
        signal: controller.signal,
      });
      setResult(answer);
      setStatus("success");
    } catch (requestError) {
      if (requestError?.name === "AbortError") return;
      setError(requestError.message);
      setStatus("error");
    }
  }

  return (
    <div className="workspace-layout qa-layout">
      <section className="primary-panel">
        <div className="page-heading">
          <div>
            <span className="eyebrow">EPUB Knowledge Base</span>
            <h1>电子书问答</h1>
            <p>对已入库电子书进行可追溯的 Agentic RAG 问答。</p>
          </div>
          <span className="knowledge-pill ebook-pill">EPUB · Milvus</span>
        </div>

        <form className="question-card" onSubmit={submit}>
          <div className="field-group compact-field">
            <label htmlFor={bookListStatus === "loading" || books.length ? "book-select" : "book-id"}>选择电子书</label>
            {bookListStatus === "loading" && (
              <select id="book-select" aria-label="选择电子书" disabled value="">
                <option value="">正在加载书籍…</option>
              </select>
            )}
            {bookListStatus === "success" && books.length > 0 && (
              <select
                id="book-select"
                aria-label="选择电子书"
                value={bookId}
                onChange={(event) => setBookId(event.target.value)}
              >
                {books.map((item) => (
                  <option key={item.bookId} value={item.bookId}>{item.bookName}</option>
                ))}
              </select>
            )}
            {bookListStatus !== "loading" && books.length === 0 && (
              <input
                id="book-id"
                aria-label="手动输入 bookId"
                value={bookId}
                onChange={(event) => setBookId(event.target.value)}
                placeholder="手动输入 bookId，例如：1"
                autoComplete="off"
              />
            )}
            {bookListStatus === "success" && books.length > 0 && (
              <small>列表来自当前 Milvus EPUB Collection。</small>
            )}
            {bookListStatus === "success" && books.length === 0 && (
              <small>当前没有可选择的书籍，可手动输入已有 bookId。</small>
            )}
            {bookListStatus === "error" && (
              <small className="inline-error">书籍列表加载失败：{bookListError}。可手动输入 bookId。</small>
            )}
          </div>
          <div className="field-group">
            <label htmlFor="ebook-question">你想从书中了解什么？</label>
            <textarea
              id="ebook-question"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              rows="5"
              placeholder="例如：主人公做出这个决定的原因是什么？"
            />
          </div>
          <div className="form-actions">
            <span className="form-hint">回答会附带实际召回的原文片段。</span>
            <button className="primary-button" type="submit" disabled={status === "loading"}>
              {status === "loading" ? <><span className="spinner" />正在分析</> : "发送问题"}
            </button>
          </div>
        </form>

        {error && <div className="alert error-alert" role="alert">{error}</div>}
        {status === "loading" && (
          <div className="processing-card" role="status">
            <span className="processing-orb" />
            <div><strong>Agent 正在处理</strong><p>正在路由问题、检索资料并校验引用，请稍候。</p></div>
          </div>
        )}
        {status === "idle" && !result && (
          <div className="empty-hero">
            <span className="empty-icon">文</span>
            <h2>从一个具体问题开始</h2>
            <p>系统会根据问题复杂度选择直接检索或多跳推理，并展示来源与执行摘要。</p>
          </div>
        )}
        <AnswerPanel result={result} />
      </section>

      <aside className="context-panel">
        <span className="eyebrow">Scope</span>
        <h2>当前知识库</h2>
        <div className="scope-display"><span>bookId</span><strong>{bookId.trim() || "未设置"}</strong></div>
        <div className="scope-display">
          <span>书籍名称</span>
          <strong>
            {bookStatus === "loading" && "查询中…"}
            {bookStatus === "success" && book?.bookName}
            {bookStatus === "not_found" && "未找到对应书籍"}
            {bookStatus === "error" && "查询失败"}
            {bookStatus === "idle" && "未设置"}
          </strong>
        </div>
        {bookStatus === "error" && <p className="inline-error">{bookError}</p>}
        <p>查询只会在该 bookId 对应的 EPUB 文档中进行本地检索。</p>
        {currentUser?.role === "admin" && (
          <form className="boundary-note upload-form" onSubmit={upload}>
            <strong>上传 EPUB</strong>
            <p>文件会解析、生成 Embedding 并追加写入现有 Milvus Collection。</p>
            <input
              aria-label="选择 EPUB 文件"
              type="file"
              accept=".epub,application/epub+zip"
              onChange={(event) => setUploadFile(event.target.files?.[0] ?? null)}
              disabled={uploadStatus === "loading"}
            />
            <button className="secondary-button" type="submit" disabled={uploadStatus === "loading" || !uploadFile}>
              {uploadStatus === "loading" ? "上传并处理中…" : "上传并入库"}
            </button>
            {uploadMessage && <p className={uploadStatus === "error" ? "inline-error" : "inline-success"} role="status">{uploadMessage}</p>}
          </form>
        )}
        {currentUser?.role !== "admin" && (
          <div className="boundary-note"><strong>查询权限</strong><p>测试员可以查询已入库电子书。</p></div>
        )}
      </aside>
    </div>
  );
}
