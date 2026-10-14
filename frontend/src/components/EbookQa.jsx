import { useRef, useState } from "react";
import { api } from "../api.js";
import { AnswerPanel } from "./AnswerPanel.jsx";

export function EbookQa() {
  const [bookId, setBookId] = useState("1");
  const [question, setQuestion] = useState("");
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const controllerRef = useRef(null);

  async function submit(event) {
    event.preventDefault();
    const normalizedBookId = bookId.trim();
    const normalizedQuestion = question.trim();
    if (!normalizedBookId || !normalizedQuestion) {
      setError("请填写 bookId 和问题。");
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
            <label htmlFor="book-id">当前书籍 ID</label>
            <input
              id="book-id"
              list="known-book-ids"
              value={bookId}
              onChange={(event) => setBookId(event.target.value)}
              placeholder="例如：1"
              autoComplete="off"
            />
            <datalist id="known-book-ids">
              <option value="1" />
              <option value="demo-book" />
            </datalist>
            <small>当前没有图书列表 API，请输入已经存在的 bookId。</small>
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
        <p>查询只会在该 bookId 对应的 EPUB 文档中进行本地检索。</p>
        <div className="boundary-note">
          <strong>入库边界</strong>
          <p>本阶段不提供 EPUB 上传。请使用后端入库 CLI 准备书籍数据。</p>
        </div>
      </aside>
    </div>
  );
}
