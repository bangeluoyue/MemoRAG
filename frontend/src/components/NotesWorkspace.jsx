import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { AnswerPanel } from "./AnswerPanel.jsx";
import { NoteEditor } from "./NoteEditor.jsx";

function syncLabel(status) {
  return {
    synced: "已同步",
    pending: "待同步",
    failed: "同步失败",
  }[status] ?? status ?? "未知";
}

function formatTime(value) {
  if (!value) return "暂无时间";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function NoteItem({ note, selected, busy, onOpen, onRetry }) {
  const retryable = ["failed", "pending"].includes(note.syncStatus);
  return (
    <article className={`note-item ${selected ? "selected" : ""}`}>
      <button className="note-open" type="button" onClick={() => onOpen(note)}>
        <span className="note-title">{note.title || "未命名笔记"}</span>
        <span className="note-preview">{note.content || "暂无正文"}</span>
        <span className="note-footer">
          <span>{formatTime(note.updatedAt || note.createdAt)}</span>
          <span className={`sync-badge sync-${note.syncStatus || "unknown"}`}>
            {syncLabel(note.syncStatus)}
          </span>
        </span>
      </button>
      {retryable && (
        <button
          className="retry-button"
          type="button"
          disabled={busy}
          onClick={() => onRetry(note.noteId)}
        >
          重试同步
        </button>
      )}
    </article>
  );
}

export function NotesWorkspace({ currentUser }) {
  const [notes, setNotes] = useState([]);
  const [listStatus, setListStatus] = useState("idle");
  const [listError, setListError] = useState("");
  const [selectedNote, setSelectedNote] = useState(null);
  const [editor, setEditor] = useState(null);
  const [action, setAction] = useState("");
  const [notice, setNotice] = useState(null);
  const [deleteRecovery, setDeleteRecovery] = useState(null);
  const [question, setQuestion] = useState("");
  const [qaStatus, setQaStatus] = useState("idle");
  const [qaError, setQaError] = useState("");
  const [qaResult, setQaResult] = useState(null);

  const loadNotes = useCallback(async () => {
    setListStatus("loading");
    setListError("");
    setSelectedNote(null);
    try {
      const result = await api.listNotes();
      setNotes(result.notes ?? []);
      setListStatus("success");
    } catch (error) {
      setNotes([]);
      setListError(error.message);
      setListStatus("error");
    }
  }, []);

  useEffect(() => {
    loadNotes();
  }, [loadNotes]);

  async function openNote(note) {
    setAction(`open:${note.noteId}`);
    setListError("");
    try {
      const result = await api.getNote({ noteId: note.noteId });
      setSelectedNote(result.note);
      setEditor(null);
    } catch (error) {
      setListError(error.message);
    } finally {
      setAction("");
    }
  }

  async function saveNote(values) {
    setAction("save");
    setListError("");
    try {
      const result = editor.mode === "create"
        ? await api.createNote(values)
        : await api.updateNote({
          noteId: editor.note.noteId,
          ...values,
        });
      setNotice({
        type: result.sync?.status === "synced" ? "success" : "warning",
        text: result.sync?.status === "synced"
          ? "笔记已保存，双索引同步完成。"
          : "笔记已保存，但索引同步尚未完成，可从笔记列表重试。",
      });
      setEditor(null);
      setSelectedNote(result.note ?? null);
      await loadNotes();
    } catch (error) {
      setListError(error.message);
    } finally {
      setAction("");
    }
  }

  async function retryNote(noteId) {
    setAction(`retry:${noteId}`);
    setListError("");
    try {
      const result = await api.retryNote({ noteId });
      const synced = result.sync?.status === "synced";
      setNotice({
        type: synced ? "success" : "warning",
        text: synced ? "索引同步重试成功。" : "同步仍未完成，请检查后端服务状态后重试。",
      });
      if (synced && deleteRecovery?.noteId === noteId) setDeleteRecovery(null);
      await loadNotes();
    } catch (error) {
      setListError(error.message);
    } finally {
      setAction("");
    }
  }

  async function deleteNote() {
    if (!selectedNote) return;
    if (!window.confirm(`确认删除“${selectedNote.title || "未命名笔记"}”吗？`)) return;
    setAction("delete");
    setListError("");
    try {
      const result = await api.deleteNote({
        noteId: selectedNote.noteId,
      });
      if (result.sync?.status !== "synced") {
        setDeleteRecovery({
          noteId: selectedNote.noteId,
          title: selectedNote.title || "未命名笔记",
        });
        setNotice({ type: "warning", text: "笔记已隐藏，但索引清理未完成，请重试同步。" });
      } else {
        setNotice({ type: "success", text: "笔记及其索引已删除。" });
      }
      setSelectedNote(null);
      await loadNotes();
    } catch (error) {
      setListError(error.message);
    } finally {
      setAction("");
    }
  }

  async function askNotes(event) {
    event.preventDefault();
    const normalizedQuestion = question.trim();
    if (!normalizedQuestion) {
      setQaError("请填写问题。");
      return;
    }
    setQaStatus("loading");
    setQaError("");
    setQaResult(null);
    try {
      const result = await api.askNotes({
        question: normalizedQuestion,
      });
      setQaResult(result);
      setQaStatus("success");
    } catch (error) {
      setQaError(error.message);
      setQaStatus("error");
    }
  }

  const currentScope = currentUser?.email ?? "当前账号";

  return (
    <div className="notes-page">
      <div className="page-heading notes-heading">
        <div>
          <span className="eyebrow">Life Notes Knowledge Base</span>
          <h1>生活笔记</h1>
          <p>管理个人笔记，并使用 ES + Milvus Hybrid RAG 从自己的记录中问答。</p>
        </div>
        <span className="knowledge-pill notes-pill">Notes · ES + Milvus</span>
      </div>

      <section className="scope-toolbar">
        <div><strong>当前个人空间</strong><p>{currentScope}</p></div>
        <button className="secondary-button" type="button" onClick={() => loadNotes()}>
          加载笔记
        </button>
        <p>笔记范围由登录会话确定，客户端不能切换其他用户。</p>
      </section>

      {notice && <div className={`alert ${notice.type}-alert`}>{notice.text}</div>}
      {deleteRecovery && (
        <div className="recovery-card" role="alert">
          <div><strong>删除同步待恢复</strong><p>{deleteRecovery.title} · {deleteRecovery.noteId}</p></div>
          <button
            className="secondary-button"
            type="button"
            disabled={action === `retry:${deleteRecovery.noteId}`}
            onClick={() => retryNote(deleteRecovery.noteId)}
          >重试清理索引</button>
        </div>
      )}

      <div className="notes-grid">
        <section className="notes-manager panel-card">
          <div className="section-heading">
            <div><span className="eyebrow">Library</span><h2>笔记列表</h2></div>
            <button
              className="primary-button small-button"
              type="button"
              onClick={() => setEditor({ mode: "create", note: null })}
            >新建笔记</button>
          </div>

          {listError && <div className="alert error-alert" role="alert">{listError}</div>}
          {listStatus === "loading" && <div className="list-loading" role="status"><span className="spinner dark" />正在加载笔记</div>}
          {listStatus === "success" && !notes.length && (
            <div className="muted-state large-state"><strong>还没有笔记</strong><p>创建第一条笔记后，内容会同步到 ES 与 Milvus。</p></div>
          )}
          <div className="note-list">
            {notes.map((note) => (
              <NoteItem
                key={note.noteId}
                note={note}
                selected={selectedNote?.noteId === note.noteId}
                busy={action === `retry:${note.noteId}`}
                onOpen={openNote}
                onRetry={retryNote}
              />
            ))}
          </div>

          {editor && (
            <NoteEditor
              mode={editor.mode}
              note={editor.note}
              busy={action === "save"}
              onCancel={() => setEditor(null)}
              onSave={saveNote}
            />
          )}

          {!editor && selectedNote && (
            <article className="note-detail">
              <div className="section-heading compact">
                <div><span className="eyebrow">Selected Note</span><h3>{selectedNote.title || "未命名笔记"}</h3></div>
                <span className={`sync-badge sync-${selectedNote.syncStatus || "unknown"}`}>
                  {syncLabel(selectedNote.syncStatus)}
                </span>
              </div>
              <p className="note-content">{selectedNote.content}</p>
              <dl className="detail-meta">
                <div><dt>noteId</dt><dd>{selectedNote.noteId}</dd></div>
                <div><dt>同步尝试</dt><dd>{selectedNote.syncAttempts ?? 0}</dd></div>
                <div><dt>更新时间</dt><dd>{formatTime(selectedNote.updatedAt)}</dd></div>
              </dl>
              {selectedNote.syncErrorCategory && (
                <p className="sync-error">错误类别：{selectedNote.syncErrorCategory}</p>
              )}
              <div className="form-actions end-actions">
                <button className="danger-button" type="button" disabled={action === "delete"} onClick={deleteNote}>删除</button>
                <button className="secondary-button" type="button" onClick={() => setEditor({ mode: "edit", note: selectedNote })}>编辑</button>
              </div>
            </article>
          )}
          {!editor && !selectedNote && notes.length > 0 && (
            <p className="selection-hint">选择一条笔记查看正文、同步状态或进行编辑。</p>
          )}
        </section>

        <section className="notes-qa panel-card">
          <div className="section-heading">
            <div><span className="eyebrow">Ask Your Notes</span><h2>笔记 AI 问答</h2></div>
            <span className="scope-chip">{currentScope}</span>
          </div>
          <form onSubmit={askNotes}>
            <div className="field-group">
              <label htmlFor="notes-question">基于笔记提问</label>
              <textarea
                id="notes-question"
                rows="4"
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder="例如：我最近安排了哪些重要事项？"
              />
            </div>
            <div className="form-actions end-actions">
              <button className="primary-button" type="submit" disabled={qaStatus === "loading"}>
                {qaStatus === "loading" ? <><span className="spinner" />正在检索笔记</> : "向笔记提问"}
              </button>
            </div>
          </form>
          {qaError && <div className="alert error-alert" role="alert">{qaError}</div>}
          {qaStatus === "loading" && (
            <div className="processing-card compact-processing" role="status">
              <span className="processing-orb" />
              <div><strong>正在处理</strong><p>ES 与 Milvus 正在召回相关笔记。</p></div>
            </div>
          )}
          {qaStatus === "idle" && !qaResult && (
            <div className="muted-state qa-empty"><p>回答会显示引用笔记、检索次数和实际检索策略。</p></div>
          )}
          <AnswerPanel result={qaResult} />
        </section>
      </div>
    </div>
  );
}
