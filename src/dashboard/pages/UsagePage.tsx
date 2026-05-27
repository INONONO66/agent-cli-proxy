import { useCallback, useEffect, useMemo, useState } from "react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import {
  getAccountSummary,
  getCostSummary,
  getModelBreakdown,
  getProviderBreakdown,
  getStats,
  getTodayUsage,
  getUsageRange,
  fetchQuotaHistory,
  fetchUsageTrend,
} from "../api";
import { usePolling } from "../hooks/usePolling";
import { UsageSummary } from "../components/UsageSummary";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function formatCost(n: number): string {
  return `$${n.toFixed(4)}`;
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

const LINE_COLORS = [
  "#58a6ff",
  "#3fb950",
  "#d29922",
  "#f85149",
  "#e3b341",
  "#a371f7",
  "#56d364",
  "#79c0ff",
  "#ff7b72",
  "#ffa657",
];

const CHART_AXIS_COLOR = "#6e7681";
const CHART_GRID_COLOR = "#30363d";
const CHART_TOOLTIP_BG = "#161b22";
const CHART_TOOLTIP_BORDER = "#30363d";

type TimeRange = 5 | 24 | 168 | 720 | "all" | "custom";

const TIME_RANGES: readonly { value: TimeRange; label: string }[] = [
  { value: 5, label: "5h" },
  { value: 24, label: "24h" },
  { value: 168, label: "7d" },
  { value: 720, label: "30d" },
  { value: "all", label: "All" },
  { value: "custom", label: "Custom" },
] as const;

interface QuotaChartPoint {
  timestamp: string;
  [key: string]: number | string;
}

function transformQuotaHistory(
  buckets: { timestamp: string; snapshots: { provider: string; account: string; used_pct: number | null }[] }[],
): { data: QuotaChartPoint[]; lines: string[] } {
  const allKeys = new Set<string>();
  for (const bucket of buckets) {
    for (const snap of bucket.snapshots) {
      allKeys.add(`${snap.provider} — ${snap.account}`);
    }
  }
  const lines = Array.from(allKeys);
  const data = buckets.map((bucket) => {
    const point: QuotaChartPoint = { timestamp: bucket.timestamp };
    for (const key of lines) {
      point[key] = 0;
    }
    for (const snap of bucket.snapshots) {
      const key = `${snap.provider} — ${snap.account}`;
      const current = (point[key] as number) ?? 0;
      point[key] = Math.max(current, snap.used_pct ?? 0);
    }
    return point;
  });
  return { data, lines };
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

  const { data: today } = usePolling(getTodayUsage, 30000);
  const { data: range } = usePolling(
    useCallback(() => getUsageRange(effectiveFrom, effectiveTo), [effectiveFrom, effectiveTo]),
    30000,
  );
  const { data: modelBreakdown } = usePolling(
    useCallback(() => getModelBreakdown(undefined, effectiveFrom, effectiveTo), [effectiveFrom, effectiveTo]),
    30000,
  );
  const { data: providerBreakdown } = usePolling(
    useCallback(() => getProviderBreakdown(undefined, effectiveFrom, effectiveTo), [effectiveFrom, effectiveTo]),
    30000,
  );
  const { data: stats } = usePolling(getStats, 30000);
  const { data: costSummary } = usePolling(
    useCallback(() => getCostSummary(month), [month]),
    30000,
  );

  const { data: quotaHistory, loading: quotaHistoryLoading, error: quotaHistoryError } = usePolling(
    useCallback(
      () => fetchQuotaHistory(
        typeof timeRange === "number" ? timeRange : undefined,
        typeof timeRange === "number" ? undefined : effectiveFrom,
        typeof timeRange === "number" ? undefined : effectiveTo,
      ),
      [timeRange, effectiveFrom, effectiveTo],
    ),
    30000,
  );
  const { data: usageTrend, loading: usageTrendLoading, error: usageTrendError } = usePolling(
    useCallback(
      () => fetchUsageTrend(
        typeof timeRange === "number" ? timeRange : undefined,
        typeof timeRange === "number" ? undefined : effectiveFrom,
        typeof timeRange === "number" ? undefined : effectiveTo,
      ),
      [timeRange, effectiveFrom, effectiveTo],
    ),
    30000,
  );

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

  const quotaChart = useMemo(() => {
    if (!quotaHistory || quotaHistory.buckets.length === 0) {
      return { data: [], lines: [] };
    }
    return transformQuotaHistory(quotaHistory.buckets);
  }, [quotaHistory]);

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
    backgroundColor: CHART_TOOLTIP_BG,
    border: `1px solid ${CHART_TOOLTIP_BORDER}`,
    borderRadius: 4,
    color: "#e6edf3",
    fontSize: 12,
  };

  return (
    <div>
      <div className="content-header">
        <h2>Usage &amp; Cost</h2>
      </div>

      {today && <UsageSummary summary={today} />}

      <div className="section">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <h3>Trends</h3>
          <div style={{ display: "flex", gap: 6 }}>
            {TIME_RANGES.map(({ value, label }) => (
              <button
                key={String(value)}
                className={timeRange === value ? "primary" : undefined}
                onClick={() => setTimeRange(value)}
                style={{ padding: "4px 10px", fontSize: 12 }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {timeRange === "custom" && (
          <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 8 }}>
            <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>From</label>
            <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
            <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>To</label>
            <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
          </div>
        )}

        {totalSummary && (
          <div className="stats-row" style={{ marginTop: 12 }}>
            <div className="stat-box">
              <div className="label">Requests</div>
              <div className="value">{formatNumber(totalSummary.requests)}</div>
            </div>
            <div className="stat-box">
              <div className="label">Tokens</div>
              <div className="value">{formatNumber(totalSummary.tokens)}</div>
            </div>
            <div className="stat-box">
              <div className="label">Cost</div>
              <div className="value">{formatCost(totalSummary.cost)}</div>
            </div>
          </div>
        )}

        {(quotaHistoryError || usageTrendError) && (
          <div className="error-banner" style={{ marginTop: 12 }}>
            {quotaHistoryError || usageTrendError}
          </div>
        )}

        {(quotaHistoryLoading || usageTrendLoading) && (!quotaHistory || !usageTrend) && (
          <div style={{ display: "flex", justifyContent: "center", padding: 24 }}>
            <div
              style={{
                width: 20,
                height: 20,
                border: "2px solid var(--border)",
                borderTopColor: "var(--accent-blue)",
                borderRadius: "50%",
                animation: "spin 0.8s linear infinite",
              }}
            />
          </div>
        )}

        {quotaChart.lines.length > 0 && (
          <div className="card" style={{ marginTop: 12, marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 8, fontWeight: 600 }}>
              Quota Usage (%)
            </div>
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={quotaChart.data}>
                <CartesianGrid stroke={CHART_GRID_COLOR} strokeDasharray="3 3" />
                <XAxis
                  dataKey="timestamp"
                  tick={{ fill: CHART_AXIS_COLOR, fontSize: 11 }}
                  tickFormatter={(v: string) => formatAxisTime(displayHours, v)}
                  stroke={CHART_AXIS_COLOR}
                />
                <YAxis
                  domain={[0, 100]}
                  tick={{ fill: CHART_AXIS_COLOR, fontSize: 11 }}
                  stroke={CHART_AXIS_COLOR}
                  unit="%"
                />
                <Tooltip contentStyle={tooltipStyle} itemStyle={{ fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 11, color: "var(--text-secondary)" }} />
                {quotaChart.lines.map((line, i) => (
                  <Line
                    key={line}
                    type="monotone"
                    dataKey={line}
                    stroke={LINE_COLORS[i % LINE_COLORS.length]}
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4 }}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {trendData.length > 0 && (
          <div className="card">
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 8, fontWeight: 600 }}>
              Requests &amp; Cost
            </div>
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
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  tick={{ fill: CHART_AXIS_COLOR, fontSize: 11 }}
                  stroke={CHART_AXIS_COLOR}
                  tickFormatter={(v: number) => `$${v.toFixed(2)}`}
                />
                <Tooltip contentStyle={tooltipStyle} itemStyle={{ fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 11, color: "var(--text-secondary)" }} />
                <Bar yAxisId="left" dataKey="requests" fill="rgba(88, 166, 255, 0.6)" radius={[2, 2, 0, 0]} />
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="cost_usd"
                  stroke="#3fb950"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {range && range.length > 0 && (
        <div className="section">
          <h3>Daily Overview</h3>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th style={{ textAlign: "right" }}>Requests</th>
                  <th style={{ textAlign: "right" }}>Tokens</th>
                  <th style={{ textAlign: "right" }}>Cost</th>
                </tr>
              </thead>
              <tbody>
                {range.slice().reverse().map((day) => (
                  <tr key={day.date}>
                    <td>{day.date}</td>
                    <td style={{ textAlign: "right" }}><span className="mono">{formatNumber(day.requests)}</span></td>
                    <td style={{ textAlign: "right" }}><span className="mono">{formatNumber(day.total_tokens)}</span></td>
                    <td style={{ textAlign: "right" }}><span className="mono">{formatCost(day.cost_usd)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {modelBreakdown && modelBreakdown.length > 0 && (
        <div className="section">
          <h3>Model Breakdown{effectiveFrom !== effectiveTo ? ` (${effectiveFrom} ~ ${effectiveTo})` : ` (${effectiveFrom})`}</h3>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Provider</th>
                  <th style={{ textAlign: "right" }}>Requests</th>
                  <th style={{ textAlign: "right" }}>Tokens</th>
                  <th style={{ textAlign: "right" }}>Cost</th>
                  <th style={{ width: 140 }}></th>
                </tr>
              </thead>
              <tbody>
                {modelBreakdown.map((row) => (
                  <tr key={`${row.provider}-${row.model}`}>
                    <td><span className="mono">{row.model}</span></td>
                    <td>{row.provider}</td>
                    <td style={{ textAlign: "right" }}><span className="mono">{formatNumber(row.request_count)}</span></td>
                    <td style={{ textAlign: "right" }}><span className="mono">{formatNumber(row.total_tokens)}</span></td>
                    <td style={{ textAlign: "right" }}><span className="mono">{formatCost(row.cost_usd)}</span></td>
                    <td>
                      <div className="bar-cell">
                        <div className="bar-track">
                          <div
                            className="bar-fill"
                            style={{ width: `${(row.total_tokens / maxModelTokens) * 100}%` }}
                          />
                        </div>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {providerBreakdown && providerBreakdown.length > 0 && (
        <div className="section">
          <h3>Provider Breakdown{effectiveFrom !== effectiveTo ? ` (${effectiveFrom} ~ ${effectiveTo})` : ` (${effectiveFrom})`}</h3>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>Provider</th>
                  <th style={{ textAlign: "right" }}>Requests</th>
                  <th style={{ textAlign: "right" }}>Tokens</th>
                  <th style={{ textAlign: "right" }}>Cost</th>
                  <th style={{ width: 140 }}></th>
                </tr>
              </thead>
              <tbody>
                {providerBreakdown.map((row) => (
                  <tr key={row.provider}>
                    <td>{row.provider}</td>
                    <td style={{ textAlign: "right" }}><span className="mono">{formatNumber(row.request_count)}</span></td>
                    <td style={{ textAlign: "right" }}><span className="mono">{formatNumber(row.total_tokens)}</span></td>
                    <td style={{ textAlign: "right" }}><span className="mono">{formatCost(row.cost_usd)}</span></td>
                    <td>
                      <div className="bar-cell">
                        <div className="bar-track">
                          <div
                            className="bar-fill"
                            style={{ width: `${(row.total_tokens / maxProviderTokens) * 100}%` }}
                          />
                        </div>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="section">
        <h3>Monthly Cost Summary</h3>
        <div className="date-range">
          <label>Month</label>
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
          />
        </div>
      </div>

      {costSummary && (
        <div className="section">
          <div className="stats-row">
            <div className="stat-box">
              <div className="label">Accounts</div>
              <div className="value">{formatNumber(costSummary.totals.accounts)}</div>
            </div>
            <div className="stat-box">
              <div className="label">Requests</div>
              <div className="value">{formatNumber(costSummary.totals.total_requests)}</div>
            </div>
            <div className="stat-box">
              <div className="label">Total Cost</div>
              <div className="value">{formatCost(costSummary.totals.total_cost_usd)}</div>
            </div>
            <div className="stat-box">
              <div className="label">Overage</div>
              <div className="value" style={{ color: costSummary.totals.total_overage_usd > 0 ? "var(--accent-red)" : undefined }}>
                {formatCost(costSummary.totals.total_overage_usd)}
              </div>
            </div>
          </div>

          {costSummary.rows.length > 0 && (
            <div className="card">
              <table>
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Plan</th>
                    <th style={{ textAlign: "right" }}>Monthly Price</th>
                    <th style={{ textAlign: "right" }}>Requests</th>
                    <th style={{ textAlign: "right" }}>Cost</th>
                    <th style={{ textAlign: "right" }}>Overage</th>
                  </tr>
                </thead>
                <tbody>
                  {costSummary.rows.map((row) => (
                    <tr key={row.cliproxy_account}>
                      <td>{row.cliproxy_account}</td>
                      <td>{row.subscription_code ?? "—"}</td>
                      <td style={{ textAlign: "right" }}><span className="mono">{formatCost(row.monthly_price_usd)}</span></td>
                      <td style={{ textAlign: "right" }}><span className="mono">{formatNumber(row.total_requests)}</span></td>
                      <td style={{ textAlign: "right" }}><span className="mono">{formatCost(row.total_cost_usd)}</span></td>
                      <td
                        style={{
                          textAlign: "right",
                          color: row.computed_overage_usd > 0 ? "var(--accent-red)" : undefined,
                        }}
                      >
                        <span className="mono">{formatCost(row.computed_overage_usd)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {stats && (
        <div className="section">
          <h3>All-Time Statistics</h3>
          <div className="stats-row">
            <div className="stat-box">
              <div className="label">Total Requests</div>
              <div className="value">{formatNumber(stats.total_requests)}</div>
            </div>
            <div className="stat-box">
              <div className="label">Total Tokens</div>
              <div className="value">{formatNumber(stats.total_tokens)}</div>
            </div>
            <div className="stat-box">
              <div className="label">Total Cost</div>
              <div className="value">{formatCost(stats.total_cost_usd)}</div>
            </div>
          </div>
          {stats.first_request_at && (
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>
              First request: {new Date(stats.first_request_at).toLocaleDateString()} · Last request:{" "}
              {stats.last_request_at ? new Date(stats.last_request_at).toLocaleDateString() : "—"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
