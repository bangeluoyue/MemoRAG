import { useState } from "react";
import { EbookQa } from "./components/EbookQa.jsx";
import { NotesWorkspace } from "./components/NotesWorkspace.jsx";

const views = {
  ebook: {
    short: "EPUB",
    title: "电子书问答",
    description: "Milvus 语义检索",
  },
  notes: {
    short: "NOTES",
    title: "生活笔记",
    description: "ES + Milvus 混合检索",
  },
};

export function App() {
  const [view, setView] = useState("ebook");

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">M</div>
          <div><strong>MemoRAG</strong><span>Knowledge workspace</span></div>
        </div>

        <nav className="knowledge-nav" aria-label="知识库切换">
          <span className="nav-label">知识库</span>
          {Object.entries(views).map(([key, item]) => (
            <button
              key={key}
              className={`nav-item ${view === key ? "active" : ""}`}
              type="button"
              aria-pressed={view === key}
              onClick={() => setView(key)}
            >
              <span className="nav-monogram">{item.short.slice(0, 1)}</span>
              <span><strong>{item.title}</strong><small>{item.description}</small></span>
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <span className="status-dot" />
          <div><strong>本地演示模式</strong><span>API · 127.0.0.1:3000</span></div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="mobile-brand"><span>M</span><strong>MemoRAG</strong></div>
          <div className="mobile-switch" aria-label="知识库切换">
            {Object.entries(views).map(([key, item]) => (
              <button
                key={key}
                type="button"
                className={view === key ? "active" : ""}
                aria-pressed={view === key}
                onClick={() => setView(key)}
              >{item.short}</button>
            ))}
          </div>
          <div className="topbar-status"><span className="status-dot" />当前：{views[view].title}</div>
        </header>
        <div className="content-area">
          {view === "ebook" ? <EbookQa /> : <NotesWorkspace />}
        </div>
      </main>
    </div>
  );
}
