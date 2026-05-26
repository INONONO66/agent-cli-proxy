import { useCallback, useContext, useEffect, useState } from "react";

interface AuthContextValue {
  authenticated: boolean;
  setAuthenticated: (value: boolean) => void;
  loading: boolean;
}

export const AuthContext = React.createContext<AuthContextValue>({
  authenticated: false,
  setAuthenticated: () => {},
  loading: true,
});

import React from "react";
import { getSession, logout } from "../api";

const NAV = [
  { path: "#/quotas", label: "Quotas" },
  { path: "#/logs", label: "Logs" },
  { path: "#/usage", label: "Usage" },
  { path: "#/oauth", label: "OAuth" },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const { authenticated, setAuthenticated } = useContext(AuthContext);
  const [hash, setHash] = useState(window.location.hash);

  useEffect(() => {
    function onHashChange() {
      setHash(window.location.hash);
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const handleLogout = useCallback(async () => {
    await logout();
    setAuthenticated(false);
    window.location.hash = "#/login";
  }, [setAuthenticated]);

  return (
    <div className="dashboard-layout">
      <aside className="sidebar">
        <div className="sidebar-header">
          <h1>agent-cli-proxy</h1>
          <div className="version">dashboard</div>
        </div>
        <nav className="sidebar-nav">
          {NAV.map((item) => (
            <a
              key={item.path}
              href={item.path}
              className={hash === item.path || hash.startsWith(item.path + "/") ? "active" : ""}
            >
              {item.label}
            </a>
          ))}
        </nav>
        <div className="sidebar-footer">
          <button onClick={handleLogout}>Logout</button>
        </div>
      </aside>
      <main className="content">{children}</main>
    </div>
  );
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [authenticated, setAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getSession()
      .then((res) => setAuthenticated(res.authenticated))
      .catch(() => setAuthenticated(false))
      .finally(() => setLoading(false));
  }, []);

  return (
    <AuthContext.Provider value={{ authenticated, setAuthenticated, loading }}>
      {children}
    </AuthContext.Provider>
  );
}
