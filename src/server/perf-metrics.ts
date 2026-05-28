import { Logger } from "../util/logger";

const logger = Logger.fromConfig().child({ component: "perf-metrics" });
const DURATION_BUCKETS_MS = [25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000] as const;

type HistogramName = "proxy_request_duration_ms" | "ready_check_duration_ms";
type Labels = Record<string, string>;

interface HistogramState {
  labels: Labels;
  count: number;
  sum: number;
  max: number;
  buckets: number[];
}

const histograms = new Map<string, HistogramState>();

export namespace PerfMetrics {
  export interface ProxyObservation {
    provider: string;
    status: number;
    lifecycleStatus: string;
    streamed: boolean;
    durationMs: number;
  }

  export interface ReadyObservation {
    status: string;
    durationMs: number;
  }

  export function observeProxyRequest(observation: ProxyObservation): void {
    observe("proxy_request_duration_ms", {
      provider: normalizeLabelValue(observation.provider),
      status: String(observation.status),
      lifecycle_status: normalizeLabelValue(observation.lifecycleStatus),
      streamed: observation.streamed ? "true" : "false",
    }, observation.durationMs);
  }

  export function observeReadyCheck(observation: ReadyObservation): void {
    observe("ready_check_duration_ms", {
      status: normalizeLabelValue(observation.status),
    }, observation.durationMs);
  }

  export function renderPrometheus(): string {
    const lines: string[] = [];
    renderHistogram(lines, "proxy_request_duration_ms", "Proxied request duration in milliseconds, measured from request entry until response finalization");
    renderHistogram(lines, "ready_check_duration_ms", "Readiness check duration in milliseconds, measured for uncached /ready evaluations");
    return lines.join("\n") + "\n";
  }

  export function __resetForTests(): void {
    histograms.clear();
  }
}

function observe(name: HistogramName, labels: Labels, rawDurationMs: number): void {
  if (!Number.isFinite(rawDurationMs)) {
    logger.warn("ignored non-finite duration observation", { event: "perf.duration_invalid", metric: name });
    return;
  }

  const durationMs = Math.max(0, rawDurationMs);
  const key = histogramKey(name, labels);
  let state = histograms.get(key);
  if (!state) {
    state = {
      labels,
      count: 0,
      sum: 0,
      max: 0,
      buckets: Array.from({ length: DURATION_BUCKETS_MS.length }, () => 0),
    };
    histograms.set(key, state);
  }

  state.count += 1;
  state.sum += durationMs;
  state.max = Math.max(state.max, durationMs);
  for (let i = 0; i < DURATION_BUCKETS_MS.length; i += 1) {
    if (durationMs <= DURATION_BUCKETS_MS[i]) state.buckets[i] += 1;
  }
}

function renderHistogram(lines: string[], name: HistogramName, help: string): void {
  const metric = `agent_cli_proxy_${name}`;
  lines.push(`# HELP ${metric} ${help}`);
  lines.push(`# TYPE ${metric} histogram`);

  const states = Array.from(histograms.entries())
    .filter(([key]) => key.startsWith(`${name}|`))
    .map(([, state]) => state)
    .sort((a, b) => labelString(a.labels).localeCompare(labelString(b.labels)));

  for (const state of states) {
    for (let i = 0; i < DURATION_BUCKETS_MS.length; i += 1) {
      lines.push(`${metric}_bucket{${labelString({ ...state.labels, le: String(DURATION_BUCKETS_MS[i]) })}} ${state.buckets[i]}`);
    }
    lines.push(`${metric}_bucket{${labelString({ ...state.labels, le: "+Inf" })}} ${state.count}`);
    lines.push(`${metric}_sum{${labelString(state.labels)}} ${formatNumber(state.sum)}`);
    lines.push(`${metric}_count{${labelString(state.labels)}} ${state.count}`);
  }

  lines.push(`# HELP ${metric}_max Maximum observed ${name.replace(/_/g, " ")}`);
  lines.push(`# TYPE ${metric}_max gauge`);
  for (const state of states) {
    lines.push(`${metric}_max{${labelString(state.labels)}} ${formatNumber(state.max)}`);
  }
}

function histogramKey(name: HistogramName, labels: Labels): string {
  return `${name}|${labelString(labels)}`;
}

function labelString(labels: Labels): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}="${escapeLabel(value)}"`)
    .join(",");
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function normalizeLabelValue(value: string): string {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : "unknown";
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}
