import type { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { AccountSubscriptionRepo } from "./account-subscriptions";
import { QuotaRepo, RequestRepo, UsageRepo } from "./repo";
import { Pricing } from "./pricing";
import { Cost } from "./cost";
import { Usage } from "../usage";
import { QuotaProbe } from "../cliproxy/quota";
import { Logger } from "../util/logger";
import { Config } from "../config";
import { Supervisor } from "../runtime/supervisor";

const logger = Logger.fromConfig().child({ component: "usage-service" });
const costBackfillLogger = Logger.fromConfig().child({ component: "cost" });
const unmappedSubscriptionWarnings = new Map<string, true>();
let backfillRunning = false;

export namespace UsageService {
  export interface CreateOptions {
    logger?: Logger.Logger;
    now?: () => Date;
  }

  export function create(db: Database, options: CreateOptions = {}) {
    const serviceLogger = options.logger ?? logger;
    const now = options.now ?? (() => new Date());

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

    async function backfillCosts(options: BackfillCostsOptions = {}): Promise<BackfillCostsResult> {
      if (backfillRunning) return emptyBackfillResult();

      backfillRunning = true;
      try {
        return await runBackfillCosts(options);
      } finally {
        backfillRunning = false;
      }
    }

    async function runBackfillCosts(options: BackfillCostsOptions): Promise<BackfillCostsResult> {
      try {
        await Pricing.fetchPricing({ force: true });
      } catch (err) {
        logger.warn("pricing refresh failed before cost backfill", { err, event: "cost.backfill_pricing_failed" });
      }

      const lookbackMs = options.lookbackMs ?? Config.costBackfillLookbackMs;
      const chunkSize = normalizeBackfillChunkSize(options.chunkSize ?? Config.costBackfillChunkSize);
      const maxRows = options.limit && options.limit > 0 ? Math.floor(options.limit) : null;
      const sinceClause = options.all ? "" : "AND started_at >= ?";
      const sinceIso = new Date(Date.now() - lookbackMs).toISOString();
      const maxCandidateId = getCostBackfillMaxId(sinceClause, sinceIso);

      let scanned = 0;
      let updated = 0;
      let lastSeenId = 0;
      const statusCounts = { ok: 0, pending: 0, unsupported: 0 };

      while (maxCandidateId !== null && (maxRows === null || scanned < maxRows)) {
        const remaining = maxRows === null ? chunkSize : Math.min(chunkSize, maxRows - scanned);
        const rows = selectCostBackfillRows(sinceClause, sinceIso, lastSeenId, maxCandidateId, remaining);
        if (rows.length === 0) break;

        lastSeenId = rows[rows.length - 1].id;
        updated += updateCostBackfillChunk(rows, statusCounts);
        scanned += rows.length;
        await options.afterChunk?.({ scanned, updated, ...statusCounts });

        if (rows.length < remaining || lastSeenId >= maxCandidateId || (maxRows !== null && scanned >= maxRows)) break;
        await yieldBackfillChunk();
      }

      return { scanned, updated, ...statusCounts };
    }

    function getCostBackfillMaxId(sinceClause: string, sinceIso: string): number | null {
      const params: string[] = [];
      if (sinceClause) params.push(sinceIso);

      const row = db.query(`
        SELECT MAX(id) AS max_id
        FROM request_logs
        WHERE lifecycle_status IN ('completed', 'error')
          AND cost_status IN ('pending', 'unresolved')
          ${sinceClause}
      `).get(...params) as { max_id?: number | null } | null;

      return row?.max_id ?? null;
    }

    function selectCostBackfillRows(
      sinceClause: string,
      sinceIso: string,
      lastSeenId: number,
      maxCandidateId: number,
      limit: number,
    ): CostBackfillRow[] {
      const params: Array<string | number> = [];
      if (sinceClause) params.push(sinceIso);
      params.push(lastSeenId, maxCandidateId, limit);

      return db.query(`
        SELECT id, provider, model, prompt_tokens, completion_tokens,
               cache_creation_tokens, cache_read_tokens, reasoning_tokens,
               total_tokens, cost_usd, cost_status, started_at
        FROM request_logs
        WHERE lifecycle_status IN ('completed', 'error')
          AND cost_status IN ('pending', 'unresolved')
          ${sinceClause}
          AND id > ?
          AND id <= ?
        ORDER BY id ASC
        LIMIT ?
      `).all(...params) as CostBackfillRow[];
    }

    function updateCostBackfillChunk(
      rows: CostBackfillRow[],
      statusCounts: Record<Cost.CostResult["cost_status"], number>,
    ): number {
      const updateTxn = db.transaction(() => {
        let chunkUpdated = 0;
        const affectedBuckets = new Map<string, UsageRepo.DailyBucket>();
        const updateLog = db.prepare("UPDATE request_logs SET cost_usd = ?, cost_status = 'ok' WHERE id = ? AND cost_status IN ('pending', 'unresolved')");

        for (const row of rows) {
          const cost = computeCost(row);
          statusCounts[cost.cost_status] += 1;
          insertCostAudit(row.id, row, cost);

          if ((row.cost_status === "pending" || row.cost_status === "unresolved") && cost.cost_status === "ok") {
            const result = updateLog.run(cost.cost_usd, row.id);
            chunkUpdated += result.changes;
            if (result.changes > 0) {
              const bucket = {
                day: row.started_at.slice(0, 10),
                provider: row.provider,
                model: row.model,
              };
              affectedBuckets.set(`${bucket.day}\u0000${bucket.provider}\u0000${bucket.model}`, bucket);
            }
          }
        }

        for (const bucket of affectedBuckets.values()) {
          UsageRepo.refreshDailyBucket(db, bucket);
        }

        return chunkUpdated;
      });

      return updateTxn();
    }

    function normalizeBackfillChunkSize(value: number): number {
      return Number.isInteger(value) && value > 0 ? value : Config.costBackfillChunkSize;
    }

    async function yieldBackfillChunk(): Promise<void> {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
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
          applySubscriptionAttribution(
            db,
            id,
            fields.cliproxy_account,
            serviceLogger,
            now,
          );

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

    function applySubscriptionAttribution(
      database: Database,
      requestLogId: number,
      cliproxyAccount: string,
      targetLogger: Logger.Logger,
      currentDate: () => Date,
    ): void {
      const binding = AccountSubscriptionRepo.get(database, cliproxyAccount);
      if (binding) {
        RequestRepo.applySubscription(
          database,
          requestLogId,
          binding.subscription_code,
        );
        return;
      }

      warnUnmappedSubscription(targetLogger, cliproxyAccount, currentDate());
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

    async function startQuotaRefresh(options: { intervalMs?: number; signal?: AbortSignal } = {}): Promise<Supervisor.Handle | null> {
      if (!Config.cliproxyAuthDir) {
        logger.info("quota background refresh skipped", {
          event: "quota.refresh_skipped",
          reason: "missing_auth_dir",
        });
        return null;
      }

      let authFileNames: string[];
      try {
        authFileNames = await readdir(Config.cliproxyAuthDir);
      } catch (err) {
        logger.warn("quota background refresh skipped", {
          event: "quota.refresh_skipped",
          reason: "auth_dir_unreadable",
          err,
          path: Config.cliproxyAuthDir,
        });
        return null;
      }

      if (!authFileNames.some((name) => name.endsWith(".json"))) {
        logger.info("quota background refresh skipped", {
          event: "quota.refresh_skipped",
          reason: "no_auth_files",
          path: Config.cliproxyAuthDir,
        });
        return null;
      }

      return Supervisor.run("quota-refresh", async () => {
        await refreshQuotas();
      }, {
        intervalMs: options.intervalMs ?? Config.quotaRefreshIntervalMs,
        signal: options.signal,
      });
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
      startQuotaRefresh,
      getLatestQuotas,
    };
  }

  export type UsageService = ReturnType<typeof create>;

  export function warnUnmappedSubscription(
    targetLogger: Logger.Logger,
    cliproxyAccount: string,
    date: Date = new Date(),
  ): void {
    const day = date.toISOString().slice(0, 10);
    const key = `${cliproxyAccount}:${day}`;
    if (unmappedSubscriptionWarnings.has(key)) return;

    unmappedSubscriptionWarnings.set(key, true);
    targetLogger.warn("plans unmapped", {
      event: "plans.unmapped",
      cliproxy_account: cliproxyAccount,
    });
  }

  export interface BackfillCostsResult {
    scanned: number;
    updated: number;
    ok: number;
    pending: number;
    unsupported: number;
  }

  export interface BackfillCostsOptions {
    all?: boolean;
    limit?: number;
    lookbackMs?: number;
    chunkSize?: number;
    afterChunk?: (progress: BackfillCostsResult) => void | Promise<void>;
  }

  function emptyBackfillResult(): BackfillCostsResult {
    return { scanned: 0, updated: 0, ok: 0, pending: 0, unsupported: 0 };
  }

  interface CostBackfillRow {
    id: number;
    provider: string;
    model: string;
    prompt_tokens: number;
    completion_tokens: number;
    cache_creation_tokens: number;
    cache_read_tokens: number;
    reasoning_tokens?: number | null;
    total_tokens: number;
    cost_usd: number;
    cost_status: Usage.CostStatus;
    started_at: string;
  }

  export function startCostBackfillLoop(
    service: UsageService,
    options: { intervalMs?: number; signal?: AbortSignal } = {},
  ): Supervisor.Handle {
    return Supervisor.run("cost-backfill", async () => {
      const result = await service.backfillCosts();
      costBackfillLogger.info("cost backfill completed", { event: "cost.backfill", ...result });
    }, {
      intervalMs: options.intervalMs ?? Config.costBackfillIntervalMs,
      signal: options.signal,
    });
  }
}
