import { useMemo } from "react";
import type { Usage } from "../../usage";
import { useQuotas, useQuotaRefresh } from "../hooks/queries";
import { Num } from "../utils/numbers";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { RefreshCw } from "lucide-react";

const PROVIDER_BADGE_CLASSES: Record<string, string> = {
  claude: "border-orange-500/50 text-orange-400",
  codex: "border-emerald-500/50 text-emerald-400",
  kimi: "border-blue-500/50 text-blue-400",
  xai: "border-red-500/50 text-red-400",
  default: "border-muted-foreground/50 text-muted-foreground",
};

function providerKey(provider: string): string {
  const p = provider.toLowerCase();
  if (p.includes("claude")) return "claude";
  if (p.includes("codex")) return "codex";
  if (p.includes("kimi")) return "kimi";
  if (p.includes("xai")) return "xai";
  return "default";
}

function providerBadgeClass(provider: string): string {
  return PROVIDER_BADGE_CLASSES[providerKey(provider)] ?? PROVIDER_BADGE_CLASSES.default;
}

function thresholdClass(usedPct: number | null | undefined): string {
  if (usedPct == null) return "text-muted-foreground";
  if (usedPct > 90) return "text-red-500";
  if (usedPct > 75) return "text-orange-400";
  if (usedPct >= 50) return "text-amber-500";
  return "text-emerald-500";
}

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

function isExpired(snapshot: Usage.QuotaSnapshot): boolean {
  if (!snapshot.resets_at) return false;
  return Date.parse(snapshot.resets_at) < Date.now();
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
  if (hoursToLimit >= hoursUntilReset || hoursToLimit > 999) return "Within quota at current pace";
  return `Limit in ~${Math.round(hoursToLimit)}h at current pace`;
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

interface AccountGroup {
  provider: string;
  account: string;
  snapshots: Usage.QuotaSnapshot[];
}

function AccountQuotaCard({ provider, account, snapshots }: AccountGroup) {
  const sorted = sortSnapshots(snapshots);

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center gap-2.5">
          <Badge
            variant="outline"
            className={cn("text-[11px] font-semibold uppercase tracking-wide", providerBadgeClass(provider))}
          >
            {provider}
          </Badge>
          <span className="text-sm font-medium truncate">{account}</span>
        </div>

        <div className="flex flex-col gap-3.5">
          {sorted.map((snap) => {
            const expired = isExpired(snap);
            const colorClass = thresholdClass(snap.used_pct);
            const pace = computePace(snap);
            const pct = Math.min(snap.used_pct ?? 0, 100);

            return (
              <div key={`${snap.quota_type}-${snap.model ?? ""}`} className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-semibold text-muted-foreground capitalize">
                      {snap.quota_type.replace(/_/g, " ")}
                    </span>
                    {snap.model && (
                      <span className="text-[10px] font-mono text-muted-foreground/70">{snap.model}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {expired && (
                      <Badge variant="destructive" className="text-[10px] px-1.5 py-0">Expired</Badge>
                    )}
                    <span className={cn("text-xs font-semibold", colorClass)}>
                      {formatPct(snap.used_pct)}
                    </span>
                  </div>
                </div>

                <Progress value={pct} />

                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Remaining: {snap.remaining != null ? <Num value={snap.remaining} /> : "—"}</span>
                  <span>Resets in: {timeUntil(snap.resets_at)}</span>
                </div>

                {pace && <div className="text-xs text-muted-foreground italic">{pace}</div>}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

export function QuotasPage() {
  const { data, isLoading, error } = useQuotas();
  const refreshMutation = useQuotaRefresh();

  const groups = useMemo(() => {
    if (!data?.snapshots) return [];
    const map = new Map<string, AccountGroup>();
    for (const snap of data.snapshots) {
      const key = `${snap.provider}\u2014${snap.account}`;
      const group = map.get(key);
      if (group) {
        group.snapshots.push(snap);
      } else {
        map.set(key, { provider: snap.provider, account: snap.account, snapshots: [snap] });
      }
    }
    return Array.from(map.values()).sort((a, b) => {
      const pa = a.provider.toLowerCase();
      const pb = b.provider.toLowerCase();
      if (pa !== pb) return pa.localeCompare(pb);
      return a.account.toLowerCase().localeCompare(b.account.toLowerCase());
    });
  }, [data]);

  return (
    <div>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-5">
        <h2 className="text-lg font-semibold">Quotas</h2>
        <Button
          variant="outline"
          size="sm"
          onClick={() => refreshMutation.mutate()}
          disabled={refreshMutation.isPending}
          className="gap-1.5"
        >
          <RefreshCw className={cn("size-3.5", refreshMutation.isPending && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 text-destructive p-3 text-sm mb-4">
          {error instanceof Error ? error.message : "Failed to load quotas"}
        </div>
      )}

      {isLoading && !data && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-4">
                <Skeleton className="h-4 w-3/5 mb-3" />
                <Skeleton className="h-3 w-full mb-2" />
                <Skeleton className="h-3 w-4/5" />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {data && groups.length === 0 && (
        <div className="text-center text-muted-foreground py-12">No quota snapshots available.</div>
      )}

      {data && groups.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {groups.map((group) => (
            <AccountQuotaCard key={`${group.provider}\u2014${group.account}`} {...group} />
          ))}
        </div>
      )}
    </div>
  );
}
