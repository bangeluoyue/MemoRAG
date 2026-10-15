import { useEffect, useState } from "react";
import { api } from "./api.js";
import { AdminSettings } from "./components/AdminSettings.jsx";
import { EbookQa } from "./components/EbookQa.jsx";
import { LoginPage } from "./components/LoginPage.jsx";
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
  settings: {
    short: "ADMIN",
    title: "管理员设置",
    description: "测试员密码",
  },
};

export function App() {
  const [view, setView] = useState("ebook");
  const [authStatus, setAuthStatus] = useState("loading");
  const [currentUser, setCurrentUser] = useState(null);

  useEffect(() => {
    let active = true;
    api.me().then(({ user }) => {
      if (!active) return;
      setCurrentUser(user);
      setAuthStatus("ready");
    }).catch(() => {
      if (!active) return;
      setCurrentUser(null);
      setAuthStatus("ready");
    });
    return () => { active = false; };
  }, []);

  async function logout() {
    try {
      await api.logout();
    } finally {
      setCurrentUser(null);
      setView("ebook");
    }
  }

  if (authStatus === "loading") {
    return <main className="session-loading" role="status"><span className="spinner dark" />正在恢复登录状态</main>;
  }
  if (!currentUser) {
    return <LoginPage onLogin={(user) => setCurrentUser(user)} />;
  }

  const visibleViews = currentUser.role === "admin"
    ? views
    : Object.fromEntries(Object.entries(views).filter(([key]) => key !== "settings"));

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">M</div>
          <div><strong>MemoRAG</strong><span>Knowledge workspace</span></div>
        </div>

        <nav className="knowledge-nav" aria-label="知识库切换">
          <span className="nav-label">知识库</span>
          {Object.entries(visibleViews).map(([key, item]) => (
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
          <div><strong>{currentUser.role === "admin" ? "管理员" : "测试员"}</strong><span>{currentUser.email}</span></div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="mobile-brand"><span>M</span><strong>MemoRAG</strong></div>
          <div className="mobile-switch" aria-label="知识库切换">
            {Object.entries(visibleViews).map(([key, item]) => (
              <button
                key={key}
                type="button"
                className={view === key ? "active" : ""}
                aria-pressed={view === key}
                onClick={() => setView(key)}
              >{item.short}</button>
            ))}
          </div>
          <div className="topbar-account">
            <div className="topbar-status"><span className="status-dot" />当前：{views[view].title}</div>
            <span className="account-identity">{currentUser.role === "admin" ? "管理员" : "测试员"} · {currentUser.email}</span>
            <button className="text-button" type="button" onClick={logout}>退出登录</button>
          </div>
        </header>
        <div className="content-area">
          {view === "ebook" && <EbookQa currentUser={currentUser} />}
          {view === "notes" && <NotesWorkspace currentUser={currentUser} />}
          {view === "settings" && currentUser.role === "admin" && <AdminSettings />}
        </div>
      </main>
    </div>
  );
}
