import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BarChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import {
  getCostSummary,
  getModelBreakdown,
  getProviderBreakdown,
  getStats,
  getTodayUsage,
  getUsageRange,
  fetchUsageTrend,
} from "../api";
import { usePolling } from "../hooks/usePolling";
import { UsageSummary } from "../components/UsageSummary";
import { Num, formatCompact, formatCostCompact } from "../utils/numbers";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function formatAxisTime(hours: number, timestamp: string): string {
  const d = new Date(timestamp);
  if (hours <= 24) {
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    return `${h}:${m}`;
  }
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${mo}-${da}`;
}

const CHART_AXIS_COLOR = "hsl(var(--muted-foreground))";
const CHART_GRID_COLOR = "hsl(var(--border))";

type TimeRange = 5 | 24 | 168 | 720 | "all" | "custom";

const TIME_RANGES: readonly { value: TimeRange; label: string }[] = [
  { value: 5, label: "5h" },
  { value: 24, label: "24h" },
  { value: 168, label: "7d" },
  { value: 720, label: "30d" },
  { value: "all", label: "All" },
  { value: "custom", label: "Custom" },
] as const;

function StatBox({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">{label}</div>
        <div className="font-mono text-xl font-semibold">{children}</div>
      </CardContent>
    </Card>
  );
}

function BarTrack({ pct }: { pct: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-secondary rounded-full overflow-hidden max-w-[120px]">
        <div className="h-full bg-primary rounded-full transition-all duration-300" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function UsagePage() {
  const [customFrom, setCustomFrom] = useState(todayIso());
  const [customTo, setCustomTo] = useState(todayIso());
  const [month, setMonth] = useState(currentMonth());
  const [timeRange, setTimeRange] = useState<TimeRange>(24);

  const [effectiveFrom, setEffectiveFrom] = useState(todayIso());
  const [effectiveTo, setEffectiveTo] = useState(todayIso());

  const displayHours = useMemo(() => {
    if (typeof timeRange === "number") return timeRange;
    const from = new Date(effectiveFrom);
    const to = new Date(effectiveTo);
    return Math.max(1, (to.getTime() - from.getTime()) / (1000 * 60 * 60));
  }, [timeRange, effectiveFrom, effectiveTo]);

  const fetchRange = useCallback(() => getUsageRange(effectiveFrom, effectiveTo), [effectiveFrom, effectiveTo]);
  const fetchModels = useCallback(() => getModelBreakdown(undefined, effectiveFrom, effectiveTo), [effectiveFrom, effectiveTo]);
  const fetchProviders = useCallback(() => getProviderBreakdown(undefined, effectiveFrom, effectiveTo), [effectiveFrom, effectiveTo]);
  const fetchCost = useCallback(() => getCostSummary(month), [month]);
  const fetchTrend = useCallback(
    () => fetchUsageTrend(
      typeof timeRange === "number" ? timeRange : undefined,
      typeof timeRange === "number" ? undefined : effectiveFrom,
      typeof timeRange === "number" ? undefined : effectiveTo,
    ),
    [timeRange, effectiveFrom, effectiveTo],
  );

  const { data: today } = usePolling(getTodayUsage, 30000);
  const { data: range } = usePolling(fetchRange, 30000);
  const { data: modelBreakdown } = usePolling(fetchModels, 30000);
  const { data: providerBreakdown } = usePolling(fetchProviders, 30000);
  const { data: stats } = usePolling(getStats, 30000);
  const { data: costSummary } = usePolling(fetchCost, 30000);
  const { data: usageTrend, loading: usageTrendLoading, error: usageTrendError } = usePolling(fetchTrend, 30000);

  const maxModelTokens = useMemo(
    () => Math.max(1, ...(modelBreakdown ?? []).map((m) => m.total_tokens)),
    [modelBreakdown],
  );
  const maxProviderTokens = useMemo(
    () => Math.max(1, ...(providerBreakdown ?? []).map((p) => p.total_tokens)),
    [providerBreakdown],
  );

  useEffect(() => {
    if (timeRange === "custom") {
      setEffectiveFrom(customFrom);
      setEffectiveTo(customTo);
    } else if (timeRange === "all") {
      const from = stats?.first_request_at?.slice(0, 10) ?? todayIso();
      setEffectiveFrom(from);
      setEffectiveTo(todayIso());
    } else {
      const to = todayIso();
      const from = new Date(Date.now() - timeRange * 60 * 60 * 1000).toISOString().slice(0, 10);
      setEffectiveFrom(from);
      setEffectiveTo(to);
    }
  }, [timeRange, customFrom, customTo, stats]);

  const totalSummary = useMemo(() => {
    if (!range) return null;
    return range.reduce(
      (acc, day) => ({
        requests: acc.requests + day.requests,
        tokens: acc.tokens + day.total_tokens,
        cost: acc.cost + day.cost_usd,
      }),
      { requests: 0, tokens: 0, cost: 0 },
    );
  }, [range]);

  const trendData = useMemo(() => {
    if (!usageTrend) return [];
    return usageTrend.buckets.map((b) => ({
      timestamp: b.timestamp,
      requests: b.requests,
      tokens: b.tokens,
      cost_usd: b.cost_usd,
    }));
  }, [usageTrend]);

  const tooltipStyle = {
    backgroundColor: "hsl(var(--popover))",
    border: "1px solid hsl(var(--border))",
    borderRadius: 6,
    color: "hsl(var(--popover-foreground))",
    fontSize: 12,
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-5">
        <h2 className="text-lg font-semibold">Usage &amp; Cost</h2>
      </div>

      {today && <UsageSummary summary={today} />}

      <div className="mb-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <h3 className="text-sm font-semibold">Trends</h3>
          <div className="flex gap-1.5">
            {TIME_RANGES.map(({ value, label }) => (
              <Button
                key={String(value)}
                variant={timeRange === value ? "default" : "outline"}
                size="xs"
                onClick={() => setTimeRange(value)}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>

        {timeRange === "custom" && (
          <div className="flex gap-3 items-center mt-2">
            <label className="text-xs text-muted-foreground">From</label>
            <Input type="date" className="h-8 text-xs w-auto" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
            <label className="text-xs text-muted-foreground">To</label>
            <Input type="date" className="h-8 text-xs w-auto" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
          </div>
        )}

        {totalSummary && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-3 mb-6">
            <StatBox label="Requests"><Num value={totalSummary.requests} /></StatBox>
            <StatBox label="Tokens"><Num value={totalSummary.tokens} /></StatBox>
            <StatBox label="Cost"><Num value={totalSummary.cost} format="cost" /></StatBox>
          </div>
        )}

        {usageTrendError && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 text-destructive p-3 text-sm mt-3">
            {usageTrendError}
          </div>
        )}

        {usageTrendLoading && !usageTrend && (
          <div className="flex justify-center py-6">
            <div className="w-5 h-5 border-2 border-border border-t-primary rounded-full animate-spin" />
          </div>
        )}

        {trendData.length > 0 && (
          <Card>
            <CardContent className="p-4">
              <div className="text-xs text-muted-foreground mb-2 font-semibold">Requests &amp; Cost</div>
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={trendData}>
                  <CartesianGrid stroke={CHART_GRID_COLOR} strokeDasharray="3 3" />
                  <XAxis
                    dataKey="timestamp"
                    tick={{ fill: CHART_AXIS_COLOR, fontSize: 11 }}
                    tickFormatter={(v: string) => formatAxisTime(displayHours, v)}
                    stroke={CHART_AXIS_COLOR}
                  />
                  <YAxis
                    yAxisId="left"
                    tick={{ fill: CHART_AXIS_COLOR, fontSize: 11 }}
                    stroke={CHART_AXIS_COLOR}
                    tickFormatter={(v: number) => formatCompact(v)}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tick={{ fill: CHART_AXIS_COLOR, fontSize: 11 }}
                    stroke={CHART_AXIS_COLOR}
                    tickFormatter={(v: number) => formatCostCompact(v)}
                  />
                  <Tooltip contentStyle={tooltipStyle} itemStyle={{ fontSize: 12 }} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar yAxisId="left" dataKey="requests" fill="hsl(var(--chart-1))" radius={[2, 2, 0, 0]} />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="cost_usd"
                    stroke="hsl(var(--chart-2))"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4 }}
                  />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        )}
      </div>

      {range && range.length > 0 && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold mb-3">Daily Overview</h3>
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Requests</TableHead>
                    <TableHead className="text-right">Tokens</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {range.slice().reverse().map((day) => (
                    <TableRow key={day.date}>
                      <TableCell>{day.date}</TableCell>
                      <TableCell className="text-right"><Num value={day.requests} /></TableCell>
                      <TableCell className="text-right"><Num value={day.total_tokens} /></TableCell>
                      <TableCell className="text-right"><Num value={day.cost_usd} format="cost" /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      )}

      {modelBreakdown && modelBreakdown.length > 0 && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold mb-3">Model Breakdown{effectiveFrom !== effectiveTo ? ` (${effectiveFrom} ~ ${effectiveTo})` : ` (${effectiveFrom})`}</h3>
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Model</TableHead>
                    <TableHead>Provider</TableHead>
                    <TableHead className="text-right">Requests</TableHead>
                    <TableHead className="text-right">Tokens</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                    <TableHead className="w-[140px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {modelBreakdown.map((row) => (
                    <TableRow key={`${row.provider}-${row.model}`}>
                      <TableCell><span className="font-mono text-xs">{row.model}</span></TableCell>
                      <TableCell>{row.provider}</TableCell>
                      <TableCell className="text-right"><Num value={row.request_count} /></TableCell>
                      <TableCell className="text-right"><Num value={row.total_tokens} /></TableCell>
                      <TableCell className="text-right"><Num value={row.cost_usd} format="cost" /></TableCell>
                      <TableCell><BarTrack pct={(row.total_tokens / maxModelTokens) * 100} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      )}

      {providerBreakdown && providerBreakdown.length > 0 && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold mb-3">Provider Breakdown{effectiveFrom !== effectiveTo ? ` (${effectiveFrom} ~ ${effectiveTo})` : ` (${effectiveFrom})`}</h3>
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Provider</TableHead>
                    <TableHead className="text-right">Requests</TableHead>
                    <TableHead className="text-right">Tokens</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                    <TableHead className="w-[140px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {providerBreakdown.map((row) => (
                    <TableRow key={row.provider}>
                      <TableCell>{row.provider}</TableCell>
                      <TableCell className="text-right"><Num value={row.request_count} /></TableCell>
                      <TableCell className="text-right"><Num value={row.total_tokens} /></TableCell>
                      <TableCell className="text-right"><Num value={row.cost_usd} format="cost" /></TableCell>
                      <TableCell><BarTrack pct={(row.total_tokens / maxProviderTokens) * 100} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      )}

      <div className="mb-6">
        <h3 className="text-sm font-semibold mb-3">Monthly Cost Summary</h3>
        <div className="flex gap-2 items-center flex-wrap">
          <label className="text-xs text-muted-foreground">Month</label>
          <Input type="month" className="h-8 text-xs w-auto" value={month} onChange={(e) => setMonth(e.target.value)} />
        </div>
      </div>

      {costSummary && (
        <div className="mb-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
            <StatBox label="Accounts"><Num value={costSummary.totals.accounts} /></StatBox>
            <StatBox label="Requests"><Num value={costSummary.totals.total_requests} /></StatBox>
            <StatBox label="Total Cost"><Num value={costSummary.totals.total_cost_usd} format="cost" /></StatBox>
            <Card>
              <CardContent className="p-4">
                <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">Overage</div>
                <div className={`font-mono text-xl font-semibold ${costSummary.totals.total_overage_usd > 0 ? "text-destructive" : ""}`}>
                  <Num value={costSummary.totals.total_overage_usd} format="cost" />
                </div>
              </CardContent>
            </Card>
          </div>

          {costSummary.rows.length > 0 && (
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Account</TableHead>
                      <TableHead>Plan</TableHead>
                      <TableHead className="text-right">Monthly Price</TableHead>
                      <TableHead className="text-right">Requests</TableHead>
                      <TableHead className="text-right">Cost</TableHead>
                      <TableHead className="text-right">Overage</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {costSummary.rows.map((row) => (
                      <TableRow key={row.cliproxy_account}>
                        <TableCell>{row.cliproxy_account}</TableCell>
                        <TableCell>{row.subscription_code ?? "—"}</TableCell>
                        <TableCell className="text-right"><Num value={row.monthly_price_usd} format="cost" /></TableCell>
                        <TableCell className="text-right"><Num value={row.total_requests} /></TableCell>
                        <TableCell className="text-right"><Num value={row.total_cost_usd} format="cost" /></TableCell>
                        <TableCell className={`text-right ${row.computed_overage_usd > 0 ? "text-destructive" : ""}`}>
                          <Num value={row.computed_overage_usd} format="cost" />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {stats && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold mb-3">All-Time Statistics</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <StatBox label="Total Requests"><Num value={stats.total_requests} /></StatBox>
            <StatBox label="Total Tokens"><Num value={stats.total_tokens} /></StatBox>
            <StatBox label="Total Cost"><Num value={stats.total_cost_usd} format="cost" /></StatBox>
          </div>
          {stats.first_request_at && (
            <div className="text-xs text-muted-foreground mt-2">
              First request: {new Date(stats.first_request_at).toLocaleDateString()} · Last request:{" "}
              {stats.last_request_at ? new Date(stats.last_request_at).toLocaleDateString() : "—"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
