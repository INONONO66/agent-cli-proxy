import { writeFile } from "node:fs/promises";

export interface PerfBaselineOptions {
  baseUrl: string;
  adminKey?: string;
  iterations: number;
  warmup: number;
  json: boolean;
  output?: string;
}

export interface EndpointSummary {
  name: string;
  path: string;
  ok: boolean;
  statuses: Record<string, number>;
  count: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  avgMs: number;
}

interface ProbeTarget {
  name: string;
  path: string;
  headers?: Record<string, string>;
}

interface ProbeSample {
  status: number;
  durationMs: number;
}

const DEFAULT_ITERATIONS = 20;
const DEFAULT_WARMUP = 3;

export function parsePerfBaselineArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): PerfBaselineOptions {
  const options: PerfBaselineOptions = {
    baseUrl: env.PERF_BASE_URL ?? "http://127.0.0.1:8317",
    adminKey: env.ADMIN_API_KEY,
    iterations: parsePositiveInteger(env.PERF_ITERATIONS, DEFAULT_ITERATIONS),
    warmup: parseNonNegativeInteger(env.PERF_WARMUP, DEFAULT_WARMUP),
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`Missing value for ${arg}`);
      return value;
    };

    if (arg === "--url") options.baseUrl = next();
    else if (arg === "--admin-key") options.adminKey = next();
    else if (arg === "--iterations") options.iterations = parsePositiveInteger(next(), DEFAULT_ITERATIONS);
    else if (arg === "--warmup") options.warmup = parseNonNegativeInteger(next(), DEFAULT_WARMUP);
    else if (arg === "--json") options.json = true;
    else if (arg === "--output") options.output = next();
    else if (arg === "--help" || arg === "-h") throw new Error(usage());
    else throw new Error(`Unknown argument: ${arg}\n${usage()}`);
  }

  return options;
}

export async function runPerfBaseline(options: PerfBaselineOptions): Promise<EndpointSummary[]> {
  const targets = buildTargets(options);
  const summaries: EndpointSummary[] = [];

  for (const target of targets) {
    const samples: ProbeSample[] = [];
    const totalRuns = options.warmup + options.iterations;
    for (let i = 0; i < totalRuns; i += 1) {
      const sample = await probe(options.baseUrl, target);
      if (i >= options.warmup) samples.push(sample);
    }
    summaries.push(summarizeSamples(target.name, target.path, samples));
  }

  return summaries;
}

export function summarizeSamples(name: string, path: string, samples: ProbeSample[]): EndpointSummary {
  if (samples.length === 0) throw new Error("at least one sample is required");
  const durations = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
  const statuses = samples.reduce<Record<string, number>>((acc, sample) => {
    const key = String(sample.status);
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  const sum = durations.reduce((acc, value) => acc + value, 0);
  return {
    name,
    path,
    ok: samples.every((sample) => sample.status >= 200 && sample.status < 300),
    statuses,
    count: samples.length,
    minMs: round(durations[0]),
    p50Ms: round(percentile(durations, 0.50)),
    p95Ms: round(percentile(durations, 0.95)),
    maxMs: round(durations[durations.length - 1]),
    avgMs: round(sum / durations.length),
  };
}

export function renderMarkdown(summaries: EndpointSummary[], options: PerfBaselineOptions): string {
  const generatedAt = new Date().toISOString();
  const lines = [
    "# Performance Baseline Report",
    "",
    `Generated at: ${generatedAt}`,
    `Base URL: ${options.baseUrl}`,
    `Iterations: ${options.iterations} (warmup: ${options.warmup})`,
    "",
    "| Endpoint | Statuses | Avg ms | P50 ms | P95 ms | Max ms | Samples |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];

  for (const summary of summaries) {
    lines.push(`| ${summary.name} (${summary.path}) | ${formatStatuses(summary.statuses)} | ${summary.avgMs} | ${summary.p50Ms} | ${summary.p95Ms} | ${summary.maxMs} | ${summary.count} |`);
  }

  lines.push("", "Use this report as a before/after baseline; do not treat a single local run as a production SLO.");
  return `${lines.join("\n")}\n`;
}

function buildTargets(options: PerfBaselineOptions): ProbeTarget[] {
  const targets: ProbeTarget[] = [
    { name: "health", path: "/health" },
    { name: "ready", path: "/ready" },
  ];
  if (options.adminKey) {
    targets.push({ name: "metrics", path: "/metrics", headers: { "x-admin-token": options.adminKey } });
  }
  return targets;
}

async function probe(baseUrl: string, target: ProbeTarget): Promise<ProbeSample> {
  const url = new URL(target.path, ensureTrailingSlash(baseUrl));
  const startedAt = performance.now();
  const res = await fetch(url, { headers: target.headers });
  await res.arrayBuffer();
  return { status: res.status, durationMs: performance.now() - startedAt };
}

function percentile(sorted: number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return sorted[index];
}

function round(value: number): number {
  return Number(value.toFixed(2));
}

function formatStatuses(statuses: Record<string, number>): string {
  return Object.entries(statuses)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([status, count]) => `${status}×${count}`)
    .join(", ");
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Expected a positive integer, got ${value}`);
  return parsed;
}

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`Expected a non-negative integer, got ${value}`);
  return parsed;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function usage(): string {
  return [
    "Usage: bun run scripts/perf-baseline.ts [--url URL] [--admin-key KEY] [--iterations N] [--warmup N] [--json] [--output PATH]",
    "Environment: PERF_BASE_URL, ADMIN_API_KEY, PERF_ITERATIONS, PERF_WARMUP",
  ].join("\n");
}

if (import.meta.main) {
  try {
    const options = parsePerfBaselineArgs(process.argv.slice(2));
    const summaries = await runPerfBaseline(options);
    const output = options.json
      ? `${JSON.stringify({ generatedAt: new Date().toISOString(), baseUrl: options.baseUrl, summaries }, null, 2)}\n`
      : renderMarkdown(summaries, options);
    if (options.output) await writeFile(options.output, output, "utf8");
    else process.stdout.write(output);
    if (summaries.some((summary) => !summary.ok)) process.exitCode = 1;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
