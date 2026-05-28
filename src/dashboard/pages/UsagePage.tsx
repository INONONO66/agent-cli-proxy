import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";
import {
  useTodayUsage,
  useUsageRange,
  useModelBreakdown,
  useProviderBreakdown,
  useAccountSummary,
  useStats,
  useUsageTrend,
} from "../hooks/queries";
import { Num, formatCompact, formatCostCompact } from "../utils/numbers";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from "@/components/ui/chart";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatAxisTime(hours: number, timestamp: string): string {
  const d = new Date(timestamp);
  if (hours <= 24) {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

type TimeRange = 5 | 24 | 168 | 720 | "all" | "custom";

const TIME_RANGES: readonly { value: TimeRange; label: string }[] = [
  { value: 5, label: "5h" },
  { value: 24, label: "24h" },
  { value: 168, label: "7d" },
  { value: 720, label: "30d" },
  { value: "all", label: "All" },
  { value: "custom", label: "Custom" },
];

const trendChartConfig = {
  requests: { label: "Requests", color: "hsl(var(--chart-1))" },
  cost_usd: { label: "Cost ($)", color: "hsl(var(--chart-2))" },
} satisfies ChartConfig;

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
    <div className="flex-1 h-1.5 bg-secondary rounded-full overflow-hidden max-w-[120px]">
      <div className="h-full bg-primary rounded-full transition-all duration-300" style={{ width: `${pct}%` }} />
    </div>
  );
}

function TodaySummary() {
  const { data } = useTodayUsage();
  if (!data) return null;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
      <StatBox label="Today Requests"><Num value={data.requests} /></StatBox>
      <StatBox label="Today Tokens"><Num value={data.total_tokens} /></StatBox>
      <StatBox label="Today Cost"><Num value={data.cost_usd} format="cost" /></StatBox>
    </div>
  );
}

function TrendChart({
  timeRange,
  effectiveFrom,
  effectiveTo,
  displayHours,
}: {
  timeRange: TimeRange;
  effectiveFrom: string;
  effectiveTo: string;
  displayHours: number;
}) {
  const { data, isLoading, error } = useUsageTrend(
    typeof timeRange === "number" ? timeRange : undefined,
    typeof timeRange === "number" ? undefined : effectiveFrom,
    typeof timeRange === "number" ? undefined : effectiveTo,
  );

  const trendData = useMemo(() => {
    if (!data) return [];
    return data.buckets.map((b) => ({
      timestamp: b.timestamp,
      requests: b.requests,
      cost_usd: b.cost_usd,
    }));
  }, [data]);

  if (error) {
    return (
      <Alert variant="destructive" className="mt-3">
        <AlertDescription>{error instanceof Error ? error.message : "Failed to load trend"}</AlertDescription>
      </Alert>
    );
  }

  if (isLoading && !data) {
    return (
      <div className="flex justify-center py-6">
        <Spinner className="size-5" />
      </div>
    );
  }

  if (trendData.length === 0) return null;

  return (
    <Card>
      <CardContent className="p-4">
        <ChartContainer config={trendChartConfig} className="aspect-auto h-[260px] w-full">
          <BarChart data={trendData}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="timestamp"
              tickFormatter={(v: string) => formatAxisTime(displayHours, v)}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              yAxisId="left"
              tickFormatter={(v: number) => formatCompact(v)}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              tickFormatter={(v: number) => formatCostCompact(v)}
              tickLine={false}
              axisLine={false}
            />
            <ChartTooltip content={<ChartTooltipContent />} />
            <ChartLegend content={<ChartLegendContent />} />
            <Bar yAxisId="left" dataKey="requests" fill="var(--color-requests)" radius={[3, 3, 0, 0]} />
            <Line
              yAxisId="right"
              type="monotone"
              dataKey="cost_usd"
              stroke="var(--color-cost_usd)"
              strokeWidth={2}
              dot={false}
            />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

function RangeSummary({ from, to }: { from: string; to: string }) {
  const { data } = useUsageRange(from, to);

  const totals = useMemo(() => {
    if (!data) return null;
    return data.reduce(
      (acc, day) => ({
        requests: acc.requests + day.requests,
        tokens: acc.tokens + day.total_tokens,
        cost: acc.cost + day.cost_usd,
      }),
      { requests: 0, tokens: 0, cost: 0 },
    );
  }, [data]);

  if (!totals) return null;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-3 mb-6">
      <StatBox label="Requests"><Num value={totals.requests} /></StatBox>
      <StatBox label="Tokens"><Num value={totals.tokens} /></StatBox>
      <StatBox label="Cost"><Num value={totals.cost} format="cost" /></StatBox>
    </div>
  );
}

function DailyOverview({ from, to }: { from: string; to: string }) {
  const { data } = useUsageRange(from, to);
  if (!data || data.length === 0) return null;

  return (
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
              {data.slice().reverse().map((day) => (
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
  );
}

function ModelBreakdown({ from, to }: { from: string; to: string }) {
  const { data } = useModelBreakdown(from, to);
  const maxTokens = useMemo(() => Math.max(1, ...(data ?? []).map((m) => m.total_tokens)), [data]);

  if (!data || data.length === 0) return null;

  return (
    <div className="mb-6">
      <h3 className="text-sm font-semibold mb-3">
        Model Breakdown {from !== to ? `(${from} ~ ${to})` : `(${from})`}
      </h3>
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
              {data.map((row) => (
                <TableRow key={`${row.provider}-${row.model}`}>
                  <TableCell><span className="font-mono text-xs">{row.model}</span></TableCell>
                  <TableCell>{row.provider}</TableCell>
                  <TableCell className="text-right"><Num value={row.request_count} /></TableCell>
                  <TableCell className="text-right"><Num value={row.total_tokens} /></TableCell>
                  <TableCell className="text-right"><Num value={row.cost_usd} format="cost" /></TableCell>
                  <TableCell><BarTrack pct={(row.total_tokens / maxTokens) * 100} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function ProviderBreakdown({ from, to }: { from: string; to: string }) {
  const { data } = useProviderBreakdown(from, to);
  const maxTokens = useMemo(() => Math.max(1, ...(data ?? []).map((p) => p.total_tokens)), [data]);

  if (!data || data.length === 0) return null;

  return (
    <div className="mb-6">
      <h3 className="text-sm font-semibold mb-3">
        Provider Breakdown {from !== to ? `(${from} ~ ${to})` : `(${from})`}
      </h3>
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
              {data.map((row) => (
                <TableRow key={row.provider}>
                  <TableCell>{row.provider}</TableCell>
                  <TableCell className="text-right"><Num value={row.request_count} /></TableCell>
                  <TableCell className="text-right"><Num value={row.total_tokens} /></TableCell>
                  <TableCell className="text-right"><Num value={row.cost_usd} format="cost" /></TableCell>
                  <TableCell><BarTrack pct={(row.total_tokens / maxTokens) * 100} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function AccountUsage({ from, to }: { from: string; to: string }) {
  const { data } = useAccountSummary(from, to);
  if (!data || data.length === 0) return null;

  return (
    <div className="mb-6">
      <h3 className="text-sm font-semibold mb-3">Account Usage</h3>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead className="text-right">Requests</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((row) => (
                <TableRow key={`${row.cliproxy_account}-${row.provider}`}>
                  <TableCell><span className="text-xs font-mono">{row.cliproxy_account}</span></TableCell>
                  <TableCell>{row.provider}</TableCell>
                  <TableCell className="text-right"><Num value={row.request_count} /></TableCell>
                  <TableCell className="text-right"><Num value={row.total_tokens} /></TableCell>
                  <TableCell className="text-right"><Num value={row.cost_usd} format="cost" /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function AllTimeStats() {
  const { data } = useStats();
  if (!data) return null;

  return (
    <div className="mb-6">
      <h3 className="text-sm font-semibold mb-3">All-Time Statistics</h3>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatBox label="Total Requests"><Num value={data.total_requests} /></StatBox>
        <StatBox label="Total Tokens"><Num value={data.total_tokens} /></StatBox>
        <StatBox label="Total Cost"><Num value={data.total_cost_usd} format="cost" /></StatBox>
      </div>
      {data.first_request_at && (
        <div className="text-xs text-muted-foreground mt-2">
          First request: {new Date(data.first_request_at).toLocaleDateString()} · Last request:{" "}
          {data.last_request_at ? new Date(data.last_request_at).toLocaleDateString() : "—"}
        </div>
      )}
    </div>
  );
}

export function UsagePage() {
  const [customFrom, setCustomFrom] = useState(todayIso());
  const [customTo, setCustomTo] = useState(todayIso());
  const [timeRange, setTimeRange] = useState<TimeRange>(24);
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso());
  const [effectiveTo, setEffectiveTo] = useState(todayIso());
  const { data: stats } = useStats();

  const displayHours = useMemo(() => {
    if (typeof timeRange === "number") return timeRange;
    const from = new Date(effectiveFrom);
    const to = new Date(effectiveTo);
    return Math.max(1, (to.getTime() - from.getTime()) / (1000 * 60 * 60));
  }, [timeRange, effectiveFrom, effectiveTo]);

  useEffect(() => {
    if (timeRange === "custom") {
      setEffectiveFrom(customFrom);
      setEffectiveTo(customTo);
    } else if (timeRange === "all") {
      setEffectiveFrom(stats?.first_request_at?.slice(0, 10) ?? todayIso());
      setEffectiveTo(todayIso());
    } else {
      const to = todayIso();
      const from = new Date(Date.now() - timeRange * 60 * 60 * 1000).toISOString().slice(0, 10);
      setEffectiveFrom(from);
      setEffectiveTo(to);
    }
  }, [timeRange, customFrom, customTo, stats]);

  return (
    <div>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-5">
        <h2 className="text-lg font-semibold">Usage &amp; Cost</h2>
      </div>

      <TodaySummary />

      <div className="mb-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <h3 className="text-sm font-semibold">Trends</h3>
          <div className="flex gap-1.5">
            {TIME_RANGES.map(({ value, label }) => (
              <Button
                key={String(value)}
                variant={timeRange === value ? "default" : "outline"}
                size="sm"
                className="h-7 px-2.5 text-xs"
                onClick={() => setTimeRange(value)}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>

        {timeRange === "custom" && (
          <div className="flex gap-3 items-center mt-2">
            <Label className="text-xs">From</Label>
            <Input type="date" className="h-8 text-xs w-auto" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
            <Label className="text-xs">To</Label>
            <Input type="date" className="h-8 text-xs w-auto" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
          </div>
        )}

        <RangeSummary from={effectiveFrom} to={effectiveTo} />
        <TrendChart timeRange={timeRange} effectiveFrom={effectiveFrom} effectiveTo={effectiveTo} displayHours={displayHours} />
      </div>

      <Tabs defaultValue="daily" className="mb-6">
        <TabsList>
          <TabsTrigger value="daily">Daily</TabsTrigger>
          <TabsTrigger value="models">Models</TabsTrigger>
          <TabsTrigger value="providers">Providers</TabsTrigger>
          <TabsTrigger value="accounts">Accounts</TabsTrigger>
        </TabsList>
        <TabsContent value="daily">
          <DailyOverview from={effectiveFrom} to={effectiveTo} />
        </TabsContent>
        <TabsContent value="models">
          <ModelBreakdown from={effectiveFrom} to={effectiveTo} />
        </TabsContent>
        <TabsContent value="providers">
          <ProviderBreakdown from={effectiveFrom} to={effectiveTo} />
        </TabsContent>
        <TabsContent value="accounts">
          <AccountUsage from={effectiveFrom} to={effectiveTo} />
        </TabsContent>
      </Tabs>

      <AllTimeStats />
    </div>
  );
}
