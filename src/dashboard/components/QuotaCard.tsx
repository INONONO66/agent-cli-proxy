import type { Usage } from "../../usage";
import { Num } from "../utils/numbers";

function formatPct(n: number | null | undefined): string {
  if (n == null) return "—";
  return `${n.toFixed(1)}%`;
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

function quotaStatus(usedPct: number | null | undefined): "ok" | "warn" | "critical" | "disabled" {
  if (usedPct == null) return "disabled";
  if (usedPct > 80) return "critical";
  if (usedPct > 50) return "warn";
  return "ok";
}

interface QuotaCardProps {
  snapshot: Usage.QuotaSnapshot;
}

export function QuotaCard({ snapshot }: QuotaCardProps) {
  const status = quotaStatus(snapshot.used_pct);
  const pct = snapshot.used_pct ?? 0;

  return (
    <div className="quota-card">
      <div className="header">
        <div>
          <div className="provider">{snapshot.provider}</div>
          <div className="account">{snapshot.account}</div>
        </div>
        <span className={`status-badge ${status}`}>
          {status === "ok" && "Healthy"}
          {status === "warn" && "Warning"}
          {status === "critical" && "Critical"}
          {status === "disabled" && "Unavailable"}
        </span>
      </div>

      <div className="quota-bar-bg">
        <div
          className={`quota-bar-fill ${status}`}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>

      <div className="quota-meta">
        <span>Used: {formatPct(snapshot.used_pct)}</span>
        <span>Remaining: {snapshot.remaining != null ? <Num value={snapshot.remaining} /> : "—"}</span>
      </div>

      {snapshot.resets_at && (
        <div className="quota-meta" style={{ marginTop: 4 }}>
          <span>Type: {snapshot.quota_type}</span>
          <span>Resets in: {timeUntil(snapshot.resets_at)}</span>
        </div>
      )}
    </div>
  );
}
