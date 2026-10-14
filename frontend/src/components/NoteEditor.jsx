import { useEffect, useState } from "react";

export function NoteEditor({ mode, note, busy, onCancel, onSave }) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setTitle(note?.title ?? "");
    setContent(note?.content ?? "");
    setError("");
  }, [note, mode]);

  function submit(event) {
    event.preventDefault();
    if (!content.trim()) {
      setError("笔记正文不能为空。");
      return;
    }
    onSave({ title: title.trim(), content: content.trim() });
  }

  return (
    <form className="note-editor" onSubmit={submit}>
      <div className="section-heading compact">
        <div>
          <span className="eyebrow">{mode === "create" ? "New Note" : "Edit Note"}</span>
          <h3>{mode === "create" ? "创建笔记" : "修改笔记"}</h3>
        </div>
        <button className="icon-button" type="button" onClick={onCancel} aria-label="关闭编辑器">×</button>
      </div>
      <div className="field-group">
        <label htmlFor="note-title">标题</label>
        <input
          id="note-title"
          value={title}
          maxLength="500"
          onChange={(event) => setTitle(event.target.value)}
          placeholder="可选标题"
        />
      </div>
      <div className="field-group">
        <label htmlFor="note-content">正文</label>
        <textarea
          id="note-content"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          rows="8"
          placeholder="记录值得检索的信息……"
        />
      </div>
      {error && <div className="inline-error" role="alert">{error}</div>}
      <div className="form-actions end-actions">
        <button className="secondary-button" type="button" onClick={onCancel}>取消</button>
        <button className="primary-button" type="submit" disabled={busy}>
          {busy ? <><span className="spinner" />正在保存</> : "保存并同步索引"}
        </button>
      </div>
    </form>
  );
}
