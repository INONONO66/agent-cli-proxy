import { Config } from "../config";
import { CLIProxyClient } from "./client";
import { UsageService } from "../storage/service";
import { Logger } from "../util/logger";
import { Supervisor } from "../runtime/supervisor";

const logger = Logger.fromConfig().child({ component: "correlator" });

export namespace Correlator {
  type Detail = CLIProxyClient.UsageDetail & { model: string };
  type RunTickOptions = {
    readonly lookbackMs: number;
    readonly maxPoolSize?: number;
    readonly maxMatchDeltaMs?: number;
  };

  const DEFAULT_MATCH_WINDOW_MS = 30_000;
  const LOW_MATCH_RATE_TICKS = 5;
  const LOW_MATCH_RATE_THRESHOLD = 0.5;
  const LOW_MATCH_RATE_WARN_INTERVAL_MS = 60 * 60 * 1000;
  const lowMatchSamples: Array<{ readonly matched: number; readonly total: number }> = [];
  let lastLowMatchWarnAt = 0;

  function bestMatch(
    log: { started_at: string; model: string; total_tokens: number; latency_ms?: number },
    pool: Detail[],
    maxMatchDeltaMs: number,
  ): { detail: Detail; index: number } | null {
    const logTs = Date.parse(log.started_at);
    if (Number.isNaN(logTs)) return null;

    let bestIdx = -1;
    let bestScore = Infinity;

    for (let i = 0; i < pool.length; i++) {
      const detail = pool[i];
      if (detail.model !== log.model) continue;

      const detailTs = Date.parse(detail.timestamp);
      if (Number.isNaN(detailTs)) continue;

      const dt = Math.abs(detailTs - logTs);
      if (dt > maxMatchDeltaMs) continue;

      const tokenDiff = Math.abs(detail.tokens.total_tokens - log.total_tokens);
      const tokenPenalty = log.total_tokens > 0 ? tokenDiff * 100 : 0;

      const latencyDiff =
        log.latency_ms != null
          ? Math.abs(detail.latency_ms - log.latency_ms)
          : 0;

      const score = dt + tokenPenalty + latencyDiff * 0.1;

      if (score < bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) return null;
    return { detail: pool[bestIdx], index: bestIdx };
  }

  const MAX_POOL_SIZE = 10_000;

  export async function runTick(
    usageService: UsageService.UsageService,
    options: RunTickOptions = { lookbackMs: 30_000 },
  ): Promise<void> {
    const lookbackMs = options.lookbackMs;
    const maxPoolSize = options.maxPoolSize ?? MAX_POOL_SIZE;
    const maxMatchDeltaMs = options.maxMatchDeltaMs ?? DEFAULT_MATCH_WINDOW_MS;

    const response = await CLIProxyClient.fetchUsage();
    if (!response) return;

    const allDetails = CLIProxyClient.flattenDetails(response);
    if (allDetails.length === 0) return;

    const cutoff = Date.now() - lookbackMs;
    const filtered = allDetails.filter((d) => {
      const ts = Date.parse(d.timestamp);
      return !Number.isNaN(ts) && ts >= cutoff;
    });
    if (filtered.length === 0) return;

    const pool = filtered.length > maxPoolSize
      ? filtered.slice(-maxPoolSize)
      : filtered;

    const uncorrelated = usageService.getUncorrelatedLogs(lookbackMs, 200);
    if (uncorrelated.length === 0) return;
    let matched = 0;

    for (const log of uncorrelated) {
      if (log.id == null) continue;
      const match = bestMatch(
        {
          started_at: log.started_at,
          model: log.model,
          total_tokens: log.total_tokens,
          latency_ms: log.latency_ms,
        },
        pool,
        maxMatchDeltaMs,
      );
      if (!match) continue;

      const { detail } = match;
      usageService.applyCorrelation(log.id, log, {
        cliproxy_account: detail.source,
        cliproxy_auth_index: detail.auth_index,
        cliproxy_source: detail.source,
      });

      pool.splice(match.index, 1);
      matched++;
    }

    if (matched > 0) {
      logger.info("correlated logs", { matched, total: uncorrelated.length });
    }
    recordMatchRate(matched, uncorrelated.length);
  }

  function recordMatchRate(matched: number, total: number): void {
    lowMatchSamples.push({ matched, total });
    if (lowMatchSamples.length > LOW_MATCH_RATE_TICKS) {
      lowMatchSamples.shift();
    }
    if (lowMatchSamples.length < LOW_MATCH_RATE_TICKS) return;

    const sampleTotals = lowMatchSamples.reduce((acc, sample) => ({
      matched: acc.matched + sample.matched,
      total: acc.total + sample.total,
    }), { matched: 0, total: 0 });
    if (sampleTotals.total === 0) return;

    const matchRate = sampleTotals.matched / sampleTotals.total;
    if (matchRate >= LOW_MATCH_RATE_THRESHOLD) return;

    const now = Date.now();
    if (now - lastLowMatchWarnAt < LOW_MATCH_RATE_WARN_INTERVAL_MS) return;
    lastLowMatchWarnAt = now;
    logger.warn("low correlator match rate", {
      event: "correlator.low_match_rate",
      matched: sampleTotals.matched,
      total: sampleTotals.total,
      match_rate: matchRate,
      window_ticks: LOW_MATCH_RATE_TICKS,
      threshold: LOW_MATCH_RATE_THRESHOLD,
      hint: "check host clock sync and CLIPROXY_CORRELATION_WINDOW_MS",
    });
  }

  export function __resetLowMatchRateForTests(): void {
    lowMatchSamples.length = 0;
    lastLowMatchWarnAt = 0;
  }

  export function start(usageService: UsageService.UsageService, options: { signal?: AbortSignal } = {}) {
    if (!Config.cliproxyMgmtKey) {
      logger.warn("CLIPROXY_MGMT_KEY not set, skipping correlator");
      return;
    }

    const intervalMs = Config.cliproxyCorrelationIntervalMs;
    const lookbackMs = Config.cliproxyCorrelationLookbackMs;
    const maxMatchDeltaMs = Config.cliproxyCorrelationWindowMs;

    Supervisor.run("correlator", () => runTick(usageService, { lookbackMs, maxMatchDeltaMs }), {
      intervalMs,
      initialDelayMs: 5_000,
      runOnStart: true,
      signal: options.signal,
    });

    logger.info("started", { interval_ms: intervalMs, lookback_ms: lookbackMs, match_window_ms: maxMatchDeltaMs });
  }
}
