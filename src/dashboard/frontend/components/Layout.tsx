import React, { ReactNode } from "react";
import { navigate } from "../lib/hooks";

interface NavItem {
  label: string;
  hash: string;
  icon: string;
}

const NAV_ITEMS: NavItem[] = [
  { label: "Overview", hash: "/", icon: "◈" },
  { label: "Logs", hash: "/logs", icon: "≡" },
  { label: "Metrics", hash: "/metrics", icon: "▲" },
  { label: "Health", hash: "/health", icon: "◎" },
];

interface LayoutProps {
  route: string;
  username: string | undefined;
  onLogout: () => Promise<void>;
  children: ReactNode;
}

export function Layout({ route, username, onLogout, children }: LayoutProps) {
  const initial = username ? username[0].toUpperCase() : "U";

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-brand">
            <div className="sidebar-brand-icon">A</div>
            <div>
              <div>agent-cli-proxy</div>
              <div className="sidebar-subtitle">Dashboard</div>
            </div>
          </div>
        </div>

        <nav className="sidebar-nav">
          <div className="nav-label">Navigation</div>
          {NAV_ITEMS.map((item) => (
            <button
              key={item.hash}
              className={`nav-link ${route === item.hash ? "active" : ""}`}
              onClick={() => navigate(item.hash)}
            >
              <span className="nav-link-icon" aria-hidden="true">
                {item.icon}
              </span>
              {item.label}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-user">
            <div className="sidebar-avatar" aria-hidden="true">
              {initial}
            </div>
            <span className="sidebar-username">{username ?? "user"}</span>
          </div>
          <button className="btn-logout" onClick={onLogout}>
            Sign out
          </button>
        </div>
      </aside>

      <main className="main-content">{children}</main>
    </div>
  );
}
