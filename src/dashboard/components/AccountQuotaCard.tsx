import type { Usage } from "../../usage";

const PROVIDER_COLORS: Record<string, { bg: string; color: string }> = {
  claude: { bg: "rgba(208,126,60,0.15)", color: "#d07e3c" },
  codex: { bg: "rgba(63,185,80,0.15)", color: "#3fb950" },
  kimi: { bg: "rgba(88,166,255,0.15)", color: "#58a6ff" },
  xai: { bg: "rgba(248,81,73,0.15)", color: "#f85149" },
};

function providerKey(provider: string): string {
  const p = provider.toLowerCase();
  if (p.includes("claude")) return "claude";
  if (p.includes("codex")) return "codex";
  if (p.includes("kimi")) return "kimi";
  if (p.includes("xai")) return "xai";
  return "default";
}

function providerColor(provider: string) {
  return PROVIDER_COLORS[providerKey(provider)] ?? {
    bg: "rgba(110,118,129,0.15)",
    color: "#6e7681",
  };
}

function thresholdColor(usedPct: number | null | undefined): string {
  if (usedPct == null) return "var(--text-muted)";
  if (usedPct > 90) return "var(--accent-red)";
  if (usedPct > 75) return "var(--accent-orange)";
  if (usedPct >= 50) return "var(--accent-yellow)";
  return "var(--accent-green)";
}

function formatPct(n: number | null | undefined): string {
  if (n == null) return "—";
  return `${n.toFixed(1)}%`;
}

function formatNumber(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString();
}

function timeUntil(iso: string | null | undefined): string {
  if (!iso) return "—";
  const diff = Date.parse(iso) - Date.now();
  if (diff <= 0) return "expired";
  const hours = Math.floor(diff / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function estimateWindowHours(quotaType: string): number | null {
  if (quotaType === "5h") return 5;
  if (quotaType.startsWith("week")) return 168;
  if (quotaType === "exhausted") return null;
  if (quotaType.endsWith("h")) {
    const n = parseInt(quotaType, 10);
    if (!Number.isNaN(n)) return n;
  }
  if (quotaType.endsWith("d")) {
    const n = parseInt(quotaType, 10);
    if (!Number.isNaN(n)) return n * 24;
  }
  return null;
}

function computePace(snapshot: Usage.QuotaSnapshot): string | null {
  const used = snapshot.used_pct;
  if (!used || used <= 0 || !snapshot.resets_at) return null;
  const windowHours = estimateWindowHours(snapshot.quota_type);
  if (!windowHours) return null;
  const resetMs = Date.parse(snapshot.resets_at);
  if (!Number.isFinite(resetMs)) return null;
  const hoursUntilReset = (resetMs - Date.now()) / 3600000;
  if (hoursUntilReset < 0) return null;
  const elapsedHours = Math.max(0, windowHours - hoursUntilReset);
  if (elapsedHours <= 0) return null;
  const hoursToLimit = ((100 - used) / used) * elapsedHours;
  if (!Number.isFinite(hoursToLimit) || hoursToLimit < 0) return null;
  if (hoursToLimit >= hoursUntilReset || hoursToLimit > 999) {
    return "At current pace, within quota";
  }
  return `At current pace, limit in ~${Math.round(hoursToLimit)}h`;
}

function isExpired(snapshot: Usage.QuotaSnapshot): boolean {
  if (!snapshot.resets_at) return false;
  return Date.parse(snapshot.resets_at) < Date.now();
}

const TYPE_ORDER = new Map<string, number>([
  ["5h", 0],
  ["session", 0],
  ["week", 1],
  ["week_sonnet", 2],
  ["week_opus", 2],
]);

function sortSnapshots(snapshots: Usage.QuotaSnapshot[]): Usage.QuotaSnapshot[] {
  return [...snapshots].sort((a, b) => {
    const oa = TYPE_ORDER.get(a.quota_type) ?? 99;
    const ob = TYPE_ORDER.get(b.quota_type) ?? 99;
    if (oa !== ob) return oa - ob;
    return a.quota_type.localeCompare(b.quota_type);
  });
}

interface AccountQuotaCardProps {
  provider: string;
  account: string;
  snapshots: Usage.QuotaSnapshot[];
}

export function AccountQuotaCard({ provider, account, snapshots }: AccountQuotaCardProps) {
  const pColor = providerColor(provider);
  const sorted = sortSnapshots(snapshots);

  return (
    <div className="quota-card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="header" style={{ marginBottom: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            style={{
              display: "inline-block",
              padding: "2px 8px",
              borderRadius: "var(--radius)",
              fontSize: 11,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.3px",
              background: pColor.bg,
              color: pColor.color,
            }}
          >
            {provider}
          </span>
          <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)" }}>
            {account}
          </span>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {sorted.map((snap) => {
          const expired = isExpired(snap);
          const color = thresholdColor(snap.used_pct);
          const pace = computePace(snap);
          const pct = Math.min(snap.used_pct ?? 0, 100);

          return (
            <div
              key={snap.quota_type}
              style={{ display: "flex", flexDirection: "column", gap: 6 }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: "var(--text-secondary)",
                    textTransform: "capitalize",
                  }}
                >
                  {snap.quota_type.replace(/_/g, " ")}
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {expired && (
                    <span
                      className="status-badge critical"
                      style={{ fontSize: 10, padding: "1px 6px" }}
                    >
                      Expired
                    </span>
                  )}
                  <span style={{ fontSize: 12, fontWeight: 600, color }}>
                    {formatPct(snap.used_pct)}
                  </span>
                </div>
              </div>

              <div className="quota-bar-bg" style={{ marginBottom: 0 }}>
                <div
                  style={{
                    height: "100%",
                    borderRadius: 3,
                    transition: "width 0.3s ease",
                    width: `${pct}%`,
                    background: color,
                  }}
                />
              </div>

              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 11,
                  color: "var(--text-secondary)",
                }}
              >
                <span>Remaining: {formatNumber(snap.remaining)}</span>
                <span>Resets in: {timeUntil(snap.resets_at)}</span>
              </div>

              {pace && (
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--text-muted)",
                    fontStyle: "italic",
                  }}
                >
                  {pace}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
