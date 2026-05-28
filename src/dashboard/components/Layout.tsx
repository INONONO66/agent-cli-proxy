import React, { useCallback, useContext, useEffect, useState } from "react";
import { getSession, logout } from "../api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface AuthContextValue {
  authenticated: boolean;
  setAuthenticated: (value: boolean) => void;
  loading: boolean;
  loginConfigured: boolean;
}

export const AuthContext = React.createContext<AuthContextValue>({
  authenticated: false,
  setAuthenticated: () => {},
  loading: true,
  loginConfigured: true,
});

const NAV = [
  { path: "#/quotas", label: "Quotas" },
  { path: "#/logs", label: "Logs" },
  { path: "#/usage", label: "Usage" },
  { path: "#/api-keys", label: "API Keys" },
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
    <div className="flex h-screen overflow-hidden">
      <aside className="w-52 shrink-0 bg-sidebar border-r border-sidebar-border flex flex-col">
        <div className="px-4 py-4 border-b border-sidebar-border">
          <h1 className="text-lg font-semibold">agent-cli-proxy</h1>
          <div className="text-xs text-muted-foreground">dashboard</div>
        </div>
        <nav className="flex-1 px-3 py-3 space-y-1">
          {NAV.map((item) => (
            <a
              key={item.path}
              href={item.path}
              className={cn(
                "block px-3 py-2 rounded-md text-sm transition-colors",
                hash === item.path || hash.startsWith(item.path + "/")
                  ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                  : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
              )}
            >
              {item.label}
            </a>
          ))}
        </nav>
        <div className="px-3 py-3 border-t border-sidebar-border">
          <Button variant="outline" className="w-full" onClick={handleLogout}>
            Logout
          </Button>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto p-6 min-w-0">{children}</main>
    </div>
  );
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [authenticated, setAuthenticated] = useState(false);
  const [loginConfigured, setLoginConfigured] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getSession()
      .then((res) => {
        setAuthenticated(res.authenticated);
        setLoginConfigured(res.loginConfigured !== false);
      })
      .catch(() => setAuthenticated(false))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const onExpired = () => setAuthenticated(false);
    window.addEventListener("auth:expired", onExpired);
    return () => window.removeEventListener("auth:expired", onExpired);
  }, []);

  return (
    <AuthContext.Provider value={{ authenticated, setAuthenticated, loading, loginConfigured }}>
      {children}
    </AuthContext.Provider>
  );
}
