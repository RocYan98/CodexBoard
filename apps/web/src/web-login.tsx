import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { SessionView } from "@codexboard/contracts";
import { loginWeb, logout } from "./api";

export function WebLoginForm({ enabled }: { readonly enabled: boolean }) {
  const client = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    setPending(true);
    setError("");
    try {
      const session = await loginWeb(username, password);
      setPassword("");
      client.removeQueries({ predicate: (query) => query.queryKey[0] !== "session" });
      client.setQueryData(["session"], session);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "登录失败，请重试");
    } finally {
      setPassword("");
      setPending(false);
    }
  }
  return (
    <main className="session-state web-login">
      <img src="/codexboard.png" width="72" height="72" alt="CodexBoard" />
      <h1>登录 CodexBoard</h1>
      <p>使用本机应用管理员为你创建的 Web 账号。</p>
      {enabled ? (
        <form onSubmit={(event) => void submit(event)}>
          <label>
            账号
            <input
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
              maxLength={64}
              disabled={pending}
            />
          </label>
          <label>
            密码
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              maxLength={256}
              disabled={pending}
            />
          </label>
          <button className="button button--primary" type="submit" disabled={pending}>
            {pending ? "正在登录…" : "登录"}
          </button>
          {error && <p role="alert">{error}</p>}
        </form>
      ) : (
        <p>
          Web 登录尚未启用。请在本机 CodexBoard 的“应用设置 → Web 账号”中创建账号，并配置 HTTPS
          公网地址。
        </p>
      )}
      <p>不提供公开注册。忘记密码请联系本机应用管理员重置。</p>
    </main>
  );
}

export function WebLogout({ session }: { readonly session: SessionView }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function leave() {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await logout(session.csrfToken);
      window.location.reload();
    } catch {
      setError("退出失败，请重试");
      setPending(false);
    }
  }
  return (
    <div className="web-session-controls">
      <button
        className="button"
        disabled={pending}
        onClick={() => void leave()}
        title={session.actor.name}
      >
        {pending ? "正在退出…" : "退出登录"}
      </button>
      {error && <span role="alert">{error}</span>}
    </div>
  );
}
