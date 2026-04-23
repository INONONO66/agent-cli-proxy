import React, { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { api, DailyUsageSummary, RequestLog, TotalStats } from "../lib/api";
import { useFetch, useInterval, formatTokens, formatCost } from "../lib/hooks";

function getDateRange(daysBack: number): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - daysBack);
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  };
}

function StatCard({
  label,
  value,
  sub,
  accent,
  icon,
}: {
  label: string;
  value: string;
  sub?: string;
  accent: "blue" | "green" | "yellow" | "purple";
  icon: string;
}) {
  return (
    <div className={`stat-card ${accent}`}>
      <div className="stat-icon" aria-hidden="true">{icon}</div>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

interface CostChartProps {
  data: DailyUsageSummary[] | null;
}

function CostChart({ data }: CostChartProps) {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartInstance = useRef<uPlot | null>(null);

  useEffect(() => {
    if (!chartRef.current || !data || data.length === 0) return;

    chartInstance.current?.destroy();

    const timestamps = data.map((d) => Math.floor(new Date(d.date).getTime() / 1000));
    const costs = data.map((d) => d.cost_usd);
    const tokens = data.map((d) => d.total_tokens / 1000);

    const opts: uPlot.Options = {
      width: chartRef.current.clientWidth,
      height: 260,
      series: [
        {},
        {
          label: "Cost ($)",
          stroke: "#58a6ff",
          width: 2,
          fill: "rgba(88, 166, 255, 0.08)",
        },
        {
          label: "Tokens (K)",
          stroke: "#3fb950",
          width: 2,
          scale: "tokens",
        },
      ],
      axes: [
        {
          stroke: "#8b949e",
          grid: { stroke: "#30363d", width: 1 },
          ticks: { stroke: "#30363d" },
          values: (_, vals) =>
            vals.map((v) => {
              if (v == null) return "";
              const d = new Date(v * 1000);
              return `${d.getMonth() + 1}/${d.getDate()}`;
            }),
        },
        {
          stroke: "#8b949e",
          grid: { stroke: "#30363d", width: 1 },
          ticks: { stroke: "#30363d" },
          values: (_, vals) => vals.map((v) => (v == null ? "" : `$${v.toFixed(2)}`)),
        },
        {
          side: 1,
          scale: "tokens",
          stroke: "#3fb950",
          grid: { show: false },
          ticks: { stroke: "#30363d" },
          values: (_, vals) => vals.map((v) => (v == null ? "" : `${v.toFixed(0)}K`)),
        },
      ],
      scales: {
        x: { time: true },
        y: { auto: true },
        tokens: { auto: true },
      },
      cursor: {
        points: { size: 6 },
      },
      legend: {
        show: true,
      },
    };

    chartInstance.current = new uPlot(
      opts,
      [timestamps, costs, tokens],
      chartRef.current
    );

    return () => {
      chartInstance.current?.destroy();
      chartInstance.current = null;
    };
  }, [data]);

  useEffect(() => {
    const handleResize = () => {
      if (chartInstance.current && chartRef.current) {
        chartInstance.current.setSize({ width: chartRef.current.clientWidth, height: 260 });
      }
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  if (!data || data.length === 0) {
    return <div className="chart-placeholder">No trend data available</div>;
  }

  return <div className="chart-container" ref={chartRef} />;
}

interface BreakdownTableProps {
  logs: RequestLog[] | null;
}

interface BreakdownRow {
  tool: string;
  client_id: string;
  requests: number;
  tokens: number;
  cost: number;
}

function buildBreakdown(logs: RequestLog[]): BreakdownRow[] {
  const map = new Map<string, BreakdownRow>();
  for (const log of logs) {
    const key = `${log.tool}||${log.client_id}`;
    const existing = map.get(key);
    if (existing) {
      existing.requests++;
      existing.tokens += log.total_tokens;
      existing.cost += log.cost_usd;
    } else {
      map.set(key, {
        tool: log.tool,
        client_id: log.client_id,
        requests: 1,
        tokens: log.total_tokens,
        cost: log.cost_usd,
      });
    }
  }
  return Array.from(map.values()).sort((a, b) => b.cost - a.cost);
}

function BreakdownTable({ logs }: BreakdownTableProps) {
  if (!logs) return null;
  const rows = buildBreakdown(logs);

  if (rows.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">📊</div>
        <div className="empty-state-text">No usage data yet</div>
      </div>
    );
  }

  return (
    <div className="table-container">
      <table>
        <thead>
          <tr>
            <th>Tool</th>
            <th>Client ID</th>
            <th>Requests</th>
            <th>Tokens</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.tool}-${row.client_id}`} style={{ cursor: "default" }}>
              <td>
                <span className="badge badge-blue">{row.tool || "unknown"}</span>
              </td>
              <td className="mono">{row.client_id || "—"}</td>
              <td className="mono">{row.requests.toLocaleString()}</td>
              <td className="mono">{formatTokens(row.tokens)}</td>
              <td className="mono">{formatCost(row.cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function OverviewPage() {
  const { from, to } = getDateRange(7);

  const todayState = useFetch(() => api.usage.today(), []);
  const statsState = useFetch(() => api.usage.stats(), []);
  const rangeState = useFetch(() => api.usage.range(from, to), []);
  const logsState = useFetch(() => api.usage.logs({ limit: 200 }), []);

  const refetchAll = () => {
    todayState.refetch();
    statsState.refetch();
    rangeState.refetch();
    logsState.refetch();
  };

  useInterval(refetchAll, 30_000);

  const today: DailyUsageSummary | null = todayState.data;
  const stats: TotalStats | null = statsState.data;

  return (
    <div>
      <div className="page-header">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h1 className="page-title">Overview</h1>
            <p className="page-subtitle">API proxy usage summary</p>
          </div>
          <div className="refresh-indicator">
            <div className="refresh-dot" />
            Auto-refresh 30s
          </div>
        </div>
      </div>

      <div className="stats-grid">
        <StatCard
          label="Today's Requests"
          value={today ? today.requests.toLocaleString() : "—"}
          accent="blue"
          icon="⬡"
        />
        <StatCard
          label="Today's Tokens"
          value={today ? formatTokens(today.total_tokens) : "—"}
          accent="green"
          icon="◈"
        />
        <StatCard
          label="Today's Cost"
          value={today ? formatCost(today.cost_usd) : "—"}
          accent="yellow"
          icon="◆"
        />
        <StatCard
          label="Total Requests"
          value={stats ? stats.total_requests.toLocaleString() : "—"}
          sub={stats?.first_request_at ? `Since ${new Date(stats.first_request_at).toLocaleDateString()}` : undefined}
          accent="purple"
          icon="▲"
        />
      </div>

      {(todayState.error || statsState.error) && (
        <div className="error-state">
          {todayState.error ?? statsState.error}
        </div>
      )}

      <div className="section">
        <div className="section-header">
          <h2 className="section-title">Tool & Instance Breakdown</h2>
        </div>
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          {logsState.loading ? (
            <div className="loading-spinner">
              <div className="spinner" />
              <span>Loading breakdown...</span>
            </div>
          ) : (
            <BreakdownTable logs={logsState.data} />
          )}
        </div>
      </div>

      <div className="section">
        <div className="section-header">
          <h2 className="section-title">7-Day Usage Trend</h2>
        </div>
        <div className="card">
          {rangeState.loading ? (
            <div className="loading-spinner">
              <div className="spinner" />
              <span>Loading chart...</span>
            </div>
          ) : (
            <CostChart data={rangeState.data} />
          )}
        </div>
      </div>
    </div>
  );
}
