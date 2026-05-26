import { useCallback, useContext, useState } from "react";
import { login } from "../api";
import { AuthContext } from "./Layout";

export function LoginForm() {
  const { setAuthenticated } = useContext(AuthContext);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError("");
      setSubmitting(true);
      try {
        const res = await login(password);
        if (res.ok) {
          setAuthenticated(true);
          window.location.hash = "#/quotas";
        } else {
          setError(res.error || "invalid password");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "login failed");
      } finally {
        setSubmitting(false);
      }
    },
    [password, setAuthenticated],
  );

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={handleSubmit}>
        <h2>Dashboard Login</h2>
        <p>Enter your admin password to continue.</p>
        {error && <div className="error">{error}</div>}
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
        />
        <button type="submit" className="primary" disabled={submitting || !password}>
          {submitting ? "Signing in..." : "Sign in"}
        </button>
      </form>
    </div>
  );
}
