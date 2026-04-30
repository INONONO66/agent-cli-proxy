import type { Database } from "bun:sqlite";
import { RequestRepo, UsageRepo } from "./repo";
import { Pricing } from "./pricing";
import { Usage } from "../usage";

export namespace UsageService {
  export function create(db: Database) {
    async function recordUsage(log: Omit<Usage.RequestLog, "id">): Promise<number> {
      let costUsd = log.cost_usd;
      if (!costUsd && log.model) {
        let pricing = Pricing.getPricing(log.model);
        if (!pricing) {
          try {
            await Pricing.fetchPricing();
          } catch {}
          pricing = Pricing.getPricing(log.model);
        }
        if (pricing) {
          costUsd = Pricing.calculateCost(
            {
              prompt_tokens: log.prompt_tokens,
              completion_tokens: log.completion_tokens,
              cache_creation_tokens: log.cache_creation_tokens,
              cache_read_tokens: log.cache_read_tokens,
            },
            pricing,
          );
        }
      }

      const logWithCost = { ...log, cost_usd: costUsd };

      const txn = db.transaction(() => {
        const id = RequestRepo.insert(db, logWithCost);

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
          cost_usd: costUsd,
        });

        return id;
      });

      return txn();
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

    return {
      recordUsage,
      getToday,
      getDateRange,
      getModelBreakdown,
      getProviderBreakdown,
      getTotalStats,
      getRecentLogs,
      getLogById,
      getUncorrelatedLogs,
      applyCorrelation,
      getAccountSummary,
      getAccountDaily,
      getAccountRange,
    };
  }

  export type UsageService = ReturnType<typeof create>;
}
