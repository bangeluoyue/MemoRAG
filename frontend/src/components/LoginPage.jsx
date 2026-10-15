import { useState } from "react";
import { api } from "../api.js";

export function LoginPage({ onLogin }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");

  async function submit(event) {
    event.preventDefault();
    if (!email.trim() || !password) {
      setError("请输入账号和密码。");
      return;
    }
    setStatus("loading");
    setError("");
    try {
      const result = await api.login({ email: email.trim(), password });
      onLogin(result.user);
    } catch (requestError) {
      setError(requestError.message);
      setStatus("error");
    }
  }

  return (
    <main className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="brand login-brand">
          <div className="brand-mark">M</div>
          <div><strong>MemoRAG</strong><span>Knowledge workspace</span></div>
        </div>
        <div>
          <span className="eyebrow">Sign in</span>
          <h1>登录 MemoRAG</h1>
          <p>使用已配置的管理员或测试员账号进入。</p>
        </div>
        <div className="field-group">
          <label htmlFor="login-email">账号</label>
          <input
            id="login-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="username"
          />
        </div>
        <div className="field-group">
          <label htmlFor="login-password">密码</label>
          <input
            id="login-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
          />
        </div>
        {error && <div className="alert error-alert" role="alert">{error}</div>}
        <button className="primary-button login-button" type="submit" disabled={status === "loading"}>
          {status === "loading" ? <><span className="spinner" />正在登录</> : "登录"}
        </button>
      </form>
    </main>
  );
}
