import type { AuthAccount } from "../api";

const PROVIDER_COLORS: Record<string, string> = {
  claude: "purple",
  codex: "green",
  kimi: "blue",
  xai: "gray",
};

function resolveProvider(account: AuthAccount): string {
  return account.type ?? account.provider ?? "unknown";
}

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

function formatRelativeTime(iso: string | undefined): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const diff = Date.now() - ms;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
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

  const grouped = new Map<string, AuthAccount[]>();
  for (const account of accounts) {
    const provider = resolveProvider(account);
    const list = grouped.get(provider) ?? [];
    list.push(account);
    grouped.set(provider, list);
  }

  const providers = Array.from(grouped.keys()).sort();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {providers.map((provider) => {
        const color = PROVIDER_COLORS[provider.toLowerCase()] ?? "default";
        return (
          <div key={provider}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 12,
                fontSize: 13,
                fontWeight: 600,
                color: "var(--text-primary)",
                textTransform: "uppercase",
                letterSpacing: "0.5px",
              }}
            >
              <span
                className={`provider-badge ${providerClass(provider)}`}
                style={{ marginBottom: 0 }}
              >
                {provider}
              </span>
              <span style={{ color: "var(--text-muted)", fontSize: 11, fontWeight: 400 }}>
                {grouped.get(provider)?.length} account(s)
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {grouped.get(provider)?.map((account, i) => {
                const status = expiryStatus(account);
                const email = account.email ?? "Unknown";
                const lastRefresh = account.last_refresh ?? account.refreshed_at;
                return (
                  <div key={i} className="oauth-account">
                    <div className="info">
                      <div className="email">{email}</div>
                      <div className="meta">
                        <span className={`status-badge ${status.className}`}>{status.label}</span>
                        {lastRefresh && (
                          <span style={{ marginLeft: 8 }}>
                            Last Refreshed: {formatRelativeTime(lastRefresh)}
                          </span>
                        )}
                      </div>
                    </div>
                    <button onClick={() => onRefresh(provider)}>
                      Refresh Login
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
