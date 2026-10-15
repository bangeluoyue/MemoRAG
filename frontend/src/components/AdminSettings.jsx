import { useState } from "react";
import { api } from "../api.js";

export function AdminSettings() {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [status, setStatus] = useState("idle");
  const [message, setMessage] = useState("");

  async function submit(event) {
    event.preventDefault();
    if (password !== confirmPassword) {
      setStatus("error");
      setMessage("两次输入的新密码不一致。");
      return;
    }
    setStatus("loading");
    setMessage("");
    try {
      await api.changeTesterPassword({ password, confirmPassword });
      setPassword("");
      setConfirmPassword("");
      setStatus("success");
      setMessage("测试员密码已更新，已有测试员会话已失效。");
    } catch (error) {
      setStatus("error");
      setMessage(error.message);
    }
  }

  return (
    <section className="admin-settings panel-card">
      <div className="page-heading">
        <div><span className="eyebrow">Admin</span><h1>管理员设置</h1></div>
      </div>
      <form className="settings-form" onSubmit={submit}>
        <div className="field-group">
          <label>测试员账号</label>
          <input value="test@123.com" disabled />
        </div>
        <div className="field-group">
          <label htmlFor="tester-password">新密码</label>
          <input id="tester-password" type="password" minLength="8" maxLength="128" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" />
        </div>
        <div className="field-group">
          <label htmlFor="tester-password-confirm">确认新密码</label>
          <input id="tester-password-confirm" type="password" minLength="8" maxLength="128" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" />
        </div>
        {message && <div className={`alert ${status === "success" ? "success-alert" : "error-alert"}`} role="status">{message}</div>}
        <button className="primary-button" type="submit" disabled={status === "loading" || !password}>
          {status === "loading" ? "正在保存" : "保存新密码"}
        </button>
      </form>
    </section>
  );
}
