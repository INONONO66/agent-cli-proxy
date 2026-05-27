import type { Usage } from "../../usage";
import { Num } from "../utils/numbers";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

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
    <Card>
      <CardContent>
        <div className="flex items-start justify-between mb-3">
          <div>
            <div className="text-sm font-semibold">{snapshot.provider}</div>
            <div className="text-xs text-muted-foreground">{snapshot.account}</div>
          </div>
          <Badge
            variant="outline"
            className={cn(
              status === "ok" && "border-emerald-500/50 text-emerald-500",
              status === "warn" && "border-amber-500/50 text-amber-500",
              status === "critical" && "border-red-500/50 text-red-500",
              status === "disabled" && "border-muted-foreground/50 text-muted-foreground",
            )}
          >
            {status === "ok" && "Healthy"}
            {status === "warn" && "Warning"}
            {status === "critical" && "Critical"}
            {status === "disabled" && "Unavailable"}
          </Badge>
        </div>

        <Progress value={Math.min(pct, 100)} className="mb-3" />

        <div className="flex justify-between text-xs text-muted-foreground">
          <span>Used: {formatPct(snapshot.used_pct)}</span>
          <span>Remaining: {snapshot.remaining != null ? <Num value={snapshot.remaining} /> : "—"}</span>
        </div>

        {snapshot.resets_at && (
          <div className="flex justify-between text-xs text-muted-foreground mt-1">
            <span>Type: {snapshot.quota_type}</span>
            <span>Resets in: {timeUntil(snapshot.resets_at)}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
