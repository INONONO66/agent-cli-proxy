import { Config } from "../config";
import { CLIProxyClient } from "./client";
import { UsageService } from "../storage/service";

export namespace Correlator {
  type Detail = CLIProxyClient.UsageDetail & { model: string };

  function bestMatch(
    log: { started_at: string; model: string; total_tokens: number; latency_ms?: number },
    pool: Detail[],
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
      if (dt > 30_000) continue;

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

  export function start(usageService: UsageService.UsageService) {
    if (!Config.cliproxyMgmtKey) {
      console.warn("[correlator] CLIPROXY_MGMT_KEY not set, skipping correlator");
      return;
    }

    const intervalMs = Config.cliproxyCorrelationIntervalMs;
    const lookbackMs = Config.cliproxyCorrelationLookbackMs;

    async function tick() {
      try {
        const response = await CLIProxyClient.fetchUsage();
        if (!response) return;

        const details = CLIProxyClient.flattenDetails(response);
        if (details.length === 0) return;

        const uncorrelated = usageService.getUncorrelatedLogs(lookbackMs, 200);
        if (uncorrelated.length === 0) return;

        const pool = [...details];
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
          );
          if (!match) continue;

          const { detail } = match;
          usageService.applyCorrelation(log.id, log, {
            cliproxy_account: detail.source,
            cliproxy_auth_index: detail.auth_index,
            cliproxy_source: detail.source,
            reasoning_tokens: detail.tokens.reasoning_tokens,
            actual_model: detail.model,
          });

          pool.splice(match.index, 1);
          matched++;
        }

        if (matched > 0) {
          console.log(
            `[correlator] correlated ${matched}/${uncorrelated.length} logs`,
          );
        }
      } catch (err) {
        console.error("[correlator] tick error:", err);
      }
    }

    setInterval(tick, intervalMs);
    setTimeout(tick, 5_000);

    console.log(
      `[correlator] started (interval=${intervalMs}ms, lookback=${lookbackMs}ms)`,
    );
  }
}
