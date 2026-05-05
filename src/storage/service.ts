import type { Database } from "bun:sqlite";
import { QuotaRepo, RequestRepo, UsageRepo } from "./repo";
import { Pricing } from "./pricing";
import { Cost } from "./cost";
import { Usage } from "../usage";
import { QuotaProbe } from "../cliproxy/quota";
import { Logger } from "../util/logger";

const logger = Logger.fromConfig().child({ component: "usage-service" });
const costBackfillLogger = Logger.fromConfig().child({ component: "cost" });

const DEFAULT_COST_BACKFILL_INTERVAL_MS = 1_800_000;
const DEFAULT_COST_BACKFILL_LOOKBACK_MS = 604_800_000;

export namespace UsageService {
  export function create(db: Database) {
    function preLog(log: Omit<Usage.RequestLog, "id">): number {
      return RequestRepo.insert(db, log);
    }

    async function finalizeUsage(id: number, log: Omit<Usage.RequestLog, "id">): Promise<boolean> {
      const cost = computeCost(log);
      const logWithCost = { ...log, cost_usd: cost.cost_usd, cost_status: cost.cost_status };

      const txn = db.transaction(() => {
        const updated = RequestRepo.updateFinalize(db, id, {
          provider: logWithCost.provider,
          model: logWithCost.model,
          actual_model: logWithCost.actual_model,
          streamed: logWithCost.streamed,
          status: logWithCost.status,
          prompt_tokens: logWithCost.prompt_tokens,
          completion_tokens: logWithCost.completion_tokens,
          cache_creation_tokens: logWithCost.cache_creation_tokens,
          cache_read_tokens: logWithCost.cache_read_tokens,
          reasoning_tokens: logWithCost.reasoning_tokens ?? 0,
          total_tokens: logWithCost.total_tokens,
          cost_usd: cost.cost_usd,
          incomplete: logWithCost.incomplete,
          error_code: logWithCost.error_code,
          latency_ms: logWithCost.latency_ms,
          finished_at: logWithCost.finished_at,
          lifecycle_status: logWithCost.lifecycle_status ?? "completed",
          finalized_at: logWithCost.finalized_at ?? logWithCost.finished_at ?? new Date().toISOString(),
          error_message: logWithCost.error_message,
          cost_status: cost.cost_status,
          subscription_code: logWithCost.subscription_code,
        });

        if (updated === 0) return false;

        insertCostAudit(id, logWithCost, cost);

        const day = logWithCost.started_at.slice(0, 10);
        UsageRepo.upsertDaily(db, {
          day,
          provider: logWithCost.provider,
          model: logWithCost.model,
          request_count: 1,
          prompt_tokens: logWithCost.prompt_tokens,
          completion_tokens: logWithCost.completion_tokens,
          cache_creation_tokens: logWithCost.cache_creation_tokens,
          cache_read_tokens: logWithCost.cache_read_tokens,
          total_tokens: logWithCost.total_tokens,
          cost_usd: cost.cost_usd,
        });

        return true;
      });

      return txn();
    }

    async function recordUsage(log: Omit<Usage.RequestLog, "id">): Promise<number> {
      const cost = computeCost(log);
      const logWithCost = { ...log, cost_usd: cost.cost_usd, cost_status: cost.cost_status };

      const txn = db.transaction(() => {
        const id = RequestRepo.insert(db, logWithCost);
        insertCostAudit(id, logWithCost, cost);

        const day = log.started_at.slice(0, 10);
        UsageRepo.upsertDaily(db, {
          day,
          provider: log.provider,
          model: log.model,
          request_count: 1,
          prompt_tokens: log.prompt_tokens,
          completion_tokens: log.completion_tokens,
          cache_creation_tokens: log.cache_creation_tokens,
          cache_read_tokens: log.cache_read_tokens,
          total_tokens: log.total_tokens,
          cost_usd: cost.cost_usd,
        });

        return id;
      });

      return txn();
    }

    async function backfillCosts(options: { all?: boolean; limit?: number; lookbackMs?: number } = {}): Promise<BackfillCostsResult> {
      try {
        await Pricing.fetchPricing({ force: true });
      } catch (err) {
        logger.warn("pricing refresh failed before cost backfill", { err, event: "cost.backfill_pricing_failed" });
      }

      const lookbackMs = options.lookbackMs ?? readPositiveEnvNumber("COST_BACKFILL_LOOKBACK_MS", DEFAULT_COST_BACKFILL_LOOKBACK_MS);
      const limitClause = options.limit && options.limit > 0 ? " LIMIT ?" : "";
      const sinceClause = options.all ? "" : "AND started_at >= ?";
      const sinceIso = new Date(Date.now() - lookbackMs).toISOString();
      const params: Array<string | number> = [];
      if (!options.all) params.push(sinceIso);
      if (options.limit && options.limit > 0) params.push(options.limit);
      const rows = db.query(`
        SELECT id, provider, model, prompt_tokens, completion_tokens,
               cache_creation_tokens, cache_read_tokens, reasoning_tokens, cost_usd, cost_status
        FROM request_logs
        WHERE lifecycle_status IN ('completed', 'error')
          AND cost_status IN ('pending', 'unresolved')
          ${sinceClause}
        ORDER BY id ASC${limitClause}
      `).all(...params) as Array<{
        id: number;
        provider: string;
        model: string;
        prompt_tokens: number;
        completion_tokens: number;
        cache_creation_tokens: number;
        cache_read_tokens: number;
        reasoning_tokens?: number | null;
        cost_usd: number;
        cost_status: Usage.CostStatus;
      }>;

      let updated = 0;
      const statusCounts = { ok: 0, pending: 0, unsupported: 0 };
      const updateTxn = db.transaction(() => {
        const updateLog = db.prepare("UPDATE request_logs SET cost_usd = ?, cost_status = 'ok' WHERE id = ? AND cost_status IN ('pending', 'unresolved')");
        for (const row of rows) {
          const cost = computeCost(row);
          statusCounts[cost.cost_status] += 1;
          insertCostAudit(row.id, row, cost);
          if ((row.cost_status === "pending" || row.cost_status === "unresolved") && cost.cost_status === "ok") {
            const result = updateLog.run(cost.cost_usd, row.id);
            updated += result.changes;
          }
        }

        db.exec(`
          DELETE FROM daily_usage;
          INSERT INTO daily_usage (
            day, provider, model, request_count, prompt_tokens,
            completion_tokens, cache_creation_tokens, cache_read_tokens,
            total_tokens, cost_usd
          )
          SELECT
            substr(started_at, 1, 10), provider, model, COUNT(*),
            SUM(prompt_tokens), SUM(completion_tokens), SUM(cache_creation_tokens),
            SUM(cache_read_tokens), SUM(total_tokens), SUM(cost_usd)
          FROM request_logs
          GROUP BY substr(started_at, 1, 10), provider, model;
        `);
      });

      updateTxn();
      return { scanned: rows.length, updated, ...statusCounts };
    }

    function computeCost(log: {
      provider: string;
      model: string;
      prompt_tokens: number;
      completion_tokens: number;
      cache_creation_tokens: number;
      cache_read_tokens: number;
      reasoning_tokens?: number | null;
    }): Cost.CostResult {
      return Cost.compute(Cost.inputsFromLog(log));
    }

    function insertCostAudit(
      requestLogId: number,
      log: Pick<Usage.RequestLog, "provider" | "model">,
      cost: Cost.CostResult,
    ): void {
      RequestRepo.insertCostAudit(db, {
        request_log_id: requestLogId,
        model: log.model,
        provider: log.provider,
        source: cost.source,
        base_cost_usd: cost.cost_usd,
      });
    }

    function getToday(): Usage.DailyUsageSummary {
      const today = new Date().toISOString().slice(0, 10);
      const breakdown = UsageRepo.getDaily(db, today);
      const totals = breakdown.reduce(
        (acc, row) => ({
          requests: acc.requests + row.request_count,
          total_tokens: acc.total_tokens + row.total_tokens,
          cost_usd: acc.cost_usd + row.cost_usd,
        }),
        { requests: 0, total_tokens: 0, cost_usd: 0 },
      );

      return {
        date: today,
        requests: totals.requests,
        total_tokens: totals.total_tokens,
        cost_usd: totals.cost_usd,
        breakdown,
      };
    }

    function getDateRange(from: string, to: string): Usage.DailyUsageSummary[] {
      const rows = UsageRepo.getRange(db, from, to);
      const byDay = new Map<string, Usage.DailyUsage[]>();
      for (const row of rows) {
        const existing = byDay.get(row.day) ?? [];
        existing.push(row);
        byDay.set(row.day, existing);
      }

      return Array.from(byDay.entries()).map(([day, breakdown]) => {
        const totals = breakdown.reduce(
          (acc, row) => ({
            requests: acc.requests + row.request_count,
            total_tokens: acc.total_tokens + row.total_tokens,
            cost_usd: acc.cost_usd + row.cost_usd,
          }),
          { requests: 0, total_tokens: 0, cost_usd: 0 },
        );
        return { date: day, ...totals, breakdown };
      });
    }

    function getModelBreakdown(day: string): Usage.DailyUsage[] {
      return UsageRepo.getDaily(db, day);
    }

    function getProviderBreakdown(day: string): Usage.ProviderSummary[] {
      const rows = UsageRepo.getDaily(db, day);
      const byProvider = new Map<string, Usage.ProviderSummary>();
      for (const row of rows) {
        const existing = byProvider.get(row.provider) ?? {
          provider: row.provider,
          request_count: 0,
          total_tokens: 0,
          cost_usd: 0,
        };
        existing.request_count += row.request_count;
        existing.total_tokens += row.total_tokens;
        existing.cost_usd += row.cost_usd;
        byProvider.set(row.provider, existing);
      }
      return Array.from(byProvider.values());
    }

    function getTotalStats(): Usage.TotalStats {
      const stmt = db.prepare(`
        SELECT 
          COUNT(*) as total_requests,
          SUM(total_tokens) as total_tokens,
          SUM(cost_usd) as total_cost_usd,
          MIN(started_at) as first_request_at,
          MAX(started_at) as last_request_at
        FROM request_logs
      `);
      const row = stmt.get() as Record<string, unknown>;
      return {
        total_requests: Number(row.total_requests ?? 0),
        total_tokens: Number(row.total_tokens ?? 0),
        total_cost_usd: Number(row.total_cost_usd ?? 0),
        first_request_at: (row.first_request_at as string | null) ?? null,
        last_request_at: (row.last_request_at as string | null) ?? null,
      };
    }

    function getRecentLogs(limit: number, offset: number, tool?: string, clientId?: string): Usage.RequestLog[] {
      return RequestRepo.getRecent(db, limit, offset, tool, clientId);
    }

    function getLogById(id: number): Usage.RequestLog | null {
      return RequestRepo.getById(db, id);
    }

    function getUncorrelatedLogs(sinceMs: number, limit: number): Usage.RequestLog[] {
      return RequestRepo.getUncorrelated(db, sinceMs, limit);
    }

    function applyCorrelation(
      id: number,
      log: Usage.RequestLog,
      fields: {
        cliproxy_account?: string;
        cliproxy_auth_index?: string;
        cliproxy_source?: string;
        reasoning_tokens?: number;
        actual_model?: string;
      },
    ): void {
      const txn = db.transaction(() => {
        RequestRepo.applyCorrelation(db, id, fields);

        if (fields.cliproxy_account) {
          UsageRepo.upsertDailyAccount(db, {
            day: log.started_at.slice(0, 10),
            provider: log.provider,
            model: log.model,
            cliproxy_account: fields.cliproxy_account,
            cliproxy_auth_index: fields.cliproxy_auth_index,
            request_count: 1,
            prompt_tokens: log.prompt_tokens,
            completion_tokens: log.completion_tokens,
            cache_creation_tokens: log.cache_creation_tokens,
            cache_read_tokens: log.cache_read_tokens,
            reasoning_tokens: fields.reasoning_tokens ?? 0,
            total_tokens: log.total_tokens,
            cost_usd: log.cost_usd,
          });
        }
      });
      txn();
    }

    function getAccountSummary(from: string, to: string): Usage.AccountSummary[] {
      return UsageRepo.getAccountSummary(db, from, to);
    }

    function getAccountDaily(day: string): Usage.DailyAccountUsage[] {
      return UsageRepo.getDailyByAccount(db, day);
    }

    function getAccountRange(from: string, to: string): Usage.DailyAccountUsage[] {
      return UsageRepo.getAccountRange(db, from, to);
    }

    function withLocalUsage(
      report: Usage.AccountQuotaReport,
    ): Usage.AccountQuotaReport {
      const now = Date.now();
      const fiveHourSince = new Date(now - 5 * 60 * 60 * 1000).toISOString();
      const sevenDaySince = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
      const localProvider = report.provider === "claude" ? "anthropic" : "openai";
      return {
        ...report,
        local_usage: {
          five_hour: QuotaRepo.getLocalWindowUsage(
            db,
            localProvider,
            report.account,
            fiveHourSince,
          ),
          seven_day: QuotaRepo.getLocalWindowUsage(
            db,
            localProvider,
            report.account,
            sevenDaySince,
          ),
        },
      };
    }

    async function refreshQuotas(): Promise<Usage.QuotaRefreshResult> {
      const result = await QuotaProbe.refresh();
      let inserted = 0;
      const accounts = result.accounts.map(withLocalUsage);
      const txn = db.transaction(() => {
        for (const account of accounts) {
          for (const snapshot of account.windows) {
            QuotaRepo.insertSnapshot(db, snapshot);
            inserted += 1;
          }
        }
      });
      txn();
      return { ...result, inserted, accounts };
    }

    function getLatestQuotas(): Usage.QuotaSnapshot[] {
      return QuotaRepo.getLatest(db);
    }

    return {
      db,
      preLog,
      finalizeUsage,
      recordUsage,
      getToday,
      getDateRange,
      getModelBreakdown,
      getProviderBreakdown,
      getTotalStats,
      getRecentLogs,
      getLogById,
      backfillCosts,
      getUncorrelatedLogs,
      applyCorrelation,
      getAccountSummary,
      getAccountDaily,
      getAccountRange,
      refreshQuotas,
      getLatestQuotas,
    };
  }

  export type UsageService = ReturnType<typeof create>;

  export interface BackfillCostsResult {
    scanned: number;
    updated: number;
    ok: number;
    pending: number;
    unsupported: number;
  }

  export function startCostBackfillLoop(service: UsageService): ReturnType<typeof setInterval> {
    const intervalMs = readPositiveEnvNumber("COST_BACKFILL_INTERVAL_MS", DEFAULT_COST_BACKFILL_INTERVAL_MS);
    const runBackfill = (): void => {
      service.backfillCosts().then((result) => {
        costBackfillLogger.info("cost backfill completed", { event: "cost.backfill", ...result });
      }).catch((err) => {
        costBackfillLogger.warn("cost backfill failed", { event: "cost.backfill_failed", err });
      });
    };

    runBackfill();
    // TODO(T11): migrate to Supervisor.run when supervisor module exists
    return setInterval(runBackfill, intervalMs);
  }
}

function readPositiveEnvNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
