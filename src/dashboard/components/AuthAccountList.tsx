import type { AuthAccount } from "../api";

function providerClass(provider: string): string {
  const p = provider.toLowerCase();
  if (p.includes("claude")) return "claude";
  if (p.includes("codex")) return "codex";
  if (p.includes("kimi")) return "kimi";
  if (p.includes("xai")) return "xai";
  if (p.includes("google")) return "google";
  if (p.includes("antigravity")) return "antigravity";
  return "default";
}

function expiryStatus(account: AuthAccount): { label: string; className: string } {
  if (account.is_expired) return { label: "Expired", className: "critical" };

  const raw = account.expired ?? account.expires_at;
  if (!raw) return { label: "Active", className: "ok" };

  const ms = Date.parse(String(raw));
  if (!Number.isFinite(ms)) return { label: "Active", className: "ok" };

  const diff = ms - Date.now();
  if (diff <= 0) return { label: "Expired", className: "critical" };
  if (diff < 3600000) return { label: "Expiring Soon", className: "warn" };
  return { label: "Active", className: "ok" };
}

function formatDate(iso: string | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface AuthAccountListProps {
  accounts: AuthAccount[];
  onRefresh: (provider: string) => void;
}

export function AuthAccountList({ accounts, onRefresh }: AuthAccountListProps) {
  if (accounts.length === 0) {
    return (
      <div className="empty-state">No OAuth accounts configured.</div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {accounts.map((account, i) => {
        const status = expiryStatus(account);
        const email = account.email ?? "Unknown";
        return (
          <div key={i} className="oauth-account">
            <div className="info">
              <div className={`provider-badge ${providerClass(account.provider)}`}>
                {account.provider}
              </div>
              <div className="email">{email}</div>
              <div className="meta">
                <span className={`status-badge ${status.className}`}>{status.label}</span>
                {account.refreshed_at && (
                  <span style={{ marginLeft: 8 }}>
                    Refreshed: {formatDate(account.refreshed_at)}
                  </span>
                )}
              </div>
            </div>
            <button onClick={() => onRefresh(account.provider)}>
              Refresh Login
            </button>
          </div>
        );
      })}
    </div>
  );
}
