import { useMemo } from "react";
import { useReady, useTodayUsage, useQuotas, useBreakers, useStats } from "../hooks/queries";
import { Num } from "../utils/numbers";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { navigate } from "../hooks/useRoute";
import {
  Activity,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Zap,
  DollarSign,
  Hash,
  ArrowRight,
} from "lucide-react";
import type { Usage } from "../../usage";

function StatusDot({ status }: { status: string }) {
  if (status === "pass") return <CheckCircle2 className="size-4 text-emerald-500" />;
  if (status === "warn") return <AlertTriangle className="size-4 text-amber-500" />;
  return <XCircle className="size-4 text-red-500" />;
}

function HealthCard() {
  const { data, isLoading, error } = useReady();

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-4">
          <Skeleton className="h-4 w-24 mb-3" />
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-3 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error || !data) {
    return (
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <Activity className="size-4 text-muted-foreground" />
            <span className="text-sm font-semibold">System Health</span>
          </div>
          <div className="flex items-center gap-2 text-sm text-red-500">
            <XCircle className="size-4" />
            <span>Unreachable</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  const checks = Object.entries(data.checks);

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Activity className="size-4 text-muted-foreground" />
            <span className="text-sm font-semibold">System Health</span>
          </div>
          <Badge
            variant={data.status === "pass" ? "default" : "destructive"}
            className="text-[10px]"
          >
            {data.status}
          </Badge>
        </div>
        <div className="space-y-2">
          {checks.map(([name, check]) => (
            <div key={name} className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-2">
                <StatusDot status={check.status} />
                <span className="capitalize">{name}</span>
              </div>
              <span className="text-xs text-muted-foreground">
                {check.responseTime !== undefined && `${check.responseTime}ms`}
                {check.ageMs !== undefined && `${Math.round(check.ageMs / 60_000)}m old`}
                {check.loops && check.loops.join(", ")}
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function TodaySummaryCard() {
  const { data, isLoading } = useTodayUsage();

  if (isLoading || !data) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="p-4">
              <Skeleton className="h-3 w-16 mb-2" />
              <Skeleton className="h-6 w-24" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  const items = [
    { label: "Requests Today", value: data.requests, icon: Hash, format: "number" as const },
    { label: "Tokens Today", value: data.total_tokens, icon: Zap, format: "tokens" as const },
    { label: "Cost Today", value: data.cost_usd, icon: DollarSign, format: "cost" as const },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      {items.map((item) => (
        <Card key={item.label}>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1.5">
              <item.icon className="size-3.5" />
              {item.label}
            </div>
            <div className="text-2xl font-bold font-mono">
              <Num value={item.value} format={item.format} />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function QuotaAlertsCard() {
  const { data, isLoading } = useQuotas();

  const alerts = useMemo(() => {
    if (!data?.snapshots) return [];
    return data.snapshots
      .filter((s: Usage.QuotaSnapshot) => s.used_pct != null && s.used_pct > 75)
      .sort((a: Usage.QuotaSnapshot, b: Usage.QuotaSnapshot) => (b.used_pct ?? 0) - (a.used_pct ?? 0));
  }, [data]);

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-4">
          <Skeleton className="h-4 w-24 mb-3" />
          <Skeleton className="h-3 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-muted-foreground" />
            <span className="text-sm font-semibold">Quota Alerts</span>
          </div>
          <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={() => navigate("#/quotas")}>
            View all <ArrowRight className="size-3" />
          </Button>
        </div>
        {alerts.length === 0 ? (
          <p className="text-sm text-muted-foreground">All quotas within normal range.</p>
        ) : (
          <div className="space-y-3">
            {alerts.slice(0, 5).map((s: Usage.QuotaSnapshot) => {
              const pct = Math.min(s.used_pct ?? 0, 100);
              return (
                <div key={`${s.provider}-${s.account}-${s.quota_type}`}>
                  <div className="flex items-center justify-between text-sm mb-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <Badge variant="outline" className="text-[10px] shrink-0">{s.provider}</Badge>
                      <span className="truncate text-xs">{s.account}</span>
                      <span className="text-xs text-muted-foreground">{s.quota_type}</span>
                    </div>
                    <span className={`text-xs font-semibold ${pct > 90 ? "text-red-500" : "text-amber-500"}`}>
                      {pct.toFixed(1)}%
                    </span>
                  </div>
                  <Progress value={pct} />
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function BreakersCard() {
  const { data, isLoading } = useBreakers();

  const openBreakers = useMemo(() => {
    if (!data?.breakers) return [];
    return data.breakers.filter((b) => b.state !== "closed");
  }, [data]);

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-4">
          <Skeleton className="h-4 w-32 mb-3" />
          <Skeleton className="h-3 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Zap className="size-4 text-muted-foreground" />
          <span className="text-sm font-semibold">Circuit Breakers</span>
        </div>
        {openBreakers.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-emerald-500">
            <CheckCircle2 className="size-4" />
            All circuits closed
          </div>
        ) : (
          <div className="space-y-2">
            {openBreakers.map((b) => (
              <div key={b.providerId} className="flex items-center justify-between text-sm">
                <span className="font-mono text-xs">{b.providerId}</span>
                <Badge variant={b.state === "open" ? "destructive" : "secondary"} className="text-[10px]">
                  {b.state} ({b.failures} failures)
                </Badge>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AllTimeCard() {
  const { data, isLoading } = useStats();

  if (isLoading || !data) {
    return (
      <Card>
        <CardContent className="p-4">
          <Skeleton className="h-4 w-28 mb-3" />
          <Skeleton className="h-3 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-sm font-semibold mb-3">All-Time</div>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <div className="text-[11px] text-muted-foreground uppercase tracking-wider">Requests</div>
            <div className="font-mono text-lg font-semibold"><Num value={data.total_requests} /></div>
          </div>
          <div>
            <div className="text-[11px] text-muted-foreground uppercase tracking-wider">Tokens</div>
            <div className="font-mono text-lg font-semibold"><Num value={data.total_tokens} /></div>
          </div>
          <div>
            <div className="text-[11px] text-muted-foreground uppercase tracking-wider">Cost</div>
            <div className="font-mono text-lg font-semibold"><Num value={data.total_cost_usd} format="cost" /></div>
          </div>
        </div>
        {data.first_request_at && (
          <div className="text-xs text-muted-foreground mt-2">
            Since {new Date(data.first_request_at).toLocaleDateString()}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function OverviewPage() {
  return (
    <div>
      <h2 className="text-lg font-semibold mb-5">Overview</h2>
      <div className="space-y-6">
        <TodaySummaryCard />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <HealthCard />
          <BreakersCard />
        </div>
        <QuotaAlertsCard />
        <AllTimeCard />
      </div>
    </div>
  );
}
