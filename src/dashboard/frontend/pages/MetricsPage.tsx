import React, { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { api, PrometheusResponse } from "../lib/api";
import { useFetch, useInterval } from "../lib/hooks";

interface MetricChartProps {
  title: string;
  unit: string;
  color: string;
  data: PrometheusResponse | null;
  loading: boolean;
  error: string | null;
}

function extractSeries(
  data: PrometheusResponse | null
): { timestamps: number[]; values: (number | null)[] } {
  if (!data || data.status !== "success" || data.data.result.length === 0) {
    return { timestamps: [], values: [] };
  }
  const series = data.data.result[0];
  if (!series.values || series.values.length === 0) {
    return { timestamps: [], values: [] };
  }
  const timestamps = series.values.map(([t]) => t);
  const values = series.values.map(([, v]) => {
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  });
  return { timestamps, values };
}

function MetricChart({ title, unit, color, data, loading, error }: MetricChartProps) {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartInstance = useRef<uPlot | null>(null);

  useEffect(() => {
    if (!chartRef.current) return;

    const { timestamps, values } = extractSeries(data);

    if (timestamps.length === 0) {
      chartInstance.current?.destroy();
      chartInstance.current = null;
      return;
    }

    chartInstance.current?.destroy();

    const opts: uPlot.Options = {
      width: chartRef.current.clientWidth,
      height: 240,
      series: [
        {},
        {
          label: `${title} (${unit})`,
          stroke: color,
          width: 2,
          fill: `${color}14`,
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
              return `${d.getHours().toString().padStart(2, "0")}:${d
                .getMinutes()
                .toString()
                .padStart(2, "0")}`;
            }),
        },
        {
          stroke: "#8b949e",
          grid: { stroke: "#30363d", width: 1 },
          ticks: { stroke: "#30363d" },
          values: (_, vals) => vals.map((v) => (v == null ? "" : `${v.toFixed(1)}${unit}`)),
        },
      ],
      scales: {
        x: { time: true },
        y: { auto: false, range: (_self, _min, _max) => [0, 100] as [number, number] },
      },
      cursor: {
        points: { size: 5 },
      },
    };

    chartInstance.current = new uPlot(
      opts,
      [timestamps, values as number[]],
      chartRef.current
    );

    return () => {
      chartInstance.current?.destroy();
      chartInstance.current = null;
    };
  }, [data, color, title, unit]);

  useEffect(() => {
    const handleResize = () => {
      if (chartInstance.current && chartRef.current) {
        chartInstance.current.setSize({
          width: chartRef.current.clientWidth,
          height: 240,
        });
      }
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const { timestamps } = extractSeries(data);

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">{title}</span>
        {data && timestamps.length > 0 && (
          <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
            {timestamps.length} data points
          </span>
        )}
      </div>

      {error ? (
        <div className="error-state">{error}</div>
      ) : loading ? (
        <div className="loading-spinner" style={{ height: "240px" }}>
          <div className="spinner" />
          <span>Loading...</span>
        </div>
      ) : timestamps.length === 0 ? (
        <div className="chart-placeholder">No data available from Prometheus</div>
      ) : (
        <div className="chart-container" ref={chartRef} />
      )}
    </div>
  );
}

const SIX_HOURS = 6 * 3600;
const STEP = 60;

const QUERIES = {
  cpu: `100 - (avg(rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)`,
  memory: `(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100`,
  disk: `(1 - node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"}) * 100`,
};

function useMetricRange(promql: string, deps: unknown[]) {
  return useFetch(() => {
    const end = Math.floor(Date.now() / 1000);
    const start = end - SIX_HOURS;
    return api.metrics.queryRange(promql, start, end, STEP);
  }, deps as Parameters<typeof useFetch>[1]);
}

export function MetricsPage() {
  const [tick, setTick] = React.useState(0);

  const cpuState = useMetricRange(QUERIES.cpu, [tick]);
  const memState = useMetricRange(QUERIES.memory, [tick]);
  const diskState = useMetricRange(QUERIES.disk, [tick]);

  useInterval(() => setTick((t) => t + 1), 60_000);

  return (
    <div>
      <div className="page-header">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h1 className="page-title">Metrics</h1>
            <p className="page-subtitle">Server resource usage from Prometheus (last 6 hours)</p>
          </div>
          <div className="refresh-indicator">
            <div className="refresh-dot" />
            Auto-refresh 60s
          </div>
        </div>
      </div>

      <div className="charts-stack">
        <MetricChart
          title="CPU Usage"
          unit="%"
          color="#58a6ff"
          data={cpuState.data}
          loading={cpuState.loading}
          error={cpuState.error}
        />
        <MetricChart
          title="Memory Usage"
          unit="%"
          color="#3fb950"
          data={memState.data}
          loading={memState.loading}
          error={memState.error}
        />
        <MetricChart
          title="Disk Usage"
          unit="%"
          color="#d29922"
          data={diskState.data}
          loading={diskState.loading}
          error={diskState.error}
        />
      </div>
    </div>
  );
}
