import type { Database } from "bun:sqlite";
import {
  insertRequest,
  updateRequest,
  getRequestsByDate,
  getRecentRequests,
  getRequestById,
} from "../db/requestsRepo";
import {
  upsertDailyUsage,
  getDailyUsage,
  getUsageRange,
} from "../db/usageRepo";
import { getPricing, calculateCost, fetchPricing } from "./pricingService";
import type {
  RequestLog,
  DailyUsage,
  DailyUsageSummary,
  ProviderSummary,
  TotalStats,
} from "../types/index";

export function createUsageService(db: Database) {
  async function recordUsage(log: Omit<RequestLog, "id">): Promise<number> {
    let costUsd = log.cost_usd;
    if (!costUsd && log.model) {
      let pricing = getPricing(log.model);
      if (!pricing) {
        try {
          await fetchPricing();
        } catch {}
        pricing = getPricing(log.model);
      }
      if (pricing) {
        costUsd = calculateCost(
          {
            prompt_tokens: log.prompt_tokens,
            completion_tokens: log.completion_tokens,
            cache_creation_tokens: log.cache_creation_tokens,
            cache_read_tokens: log.cache_read_tokens,
          },
          pricing
        );
      }
    }

    const logWithCost = { ...log, cost_usd: costUsd };

    const txn = db.transaction(() => {
      const id = insertRequest(db, logWithCost);

      const day = log.started_at.slice(0, 10);
      upsertDailyUsage(db, {
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

  function getToday(): DailyUsageSummary {
    const today = new Date().toISOString().slice(0, 10);
    const breakdown = getDailyUsage(db, today);
    const totals = breakdown.reduce(
      (acc, row) => ({
        requests: acc.requests + row.request_count,
        total_tokens: acc.total_tokens + row.total_tokens,
        cost_usd: acc.cost_usd + row.cost_usd,
      }),
      { requests: 0, total_tokens: 0, cost_usd: 0 }
    );

    return {
      date: today,
      requests: totals.requests,
      total_tokens: totals.total_tokens,
      cost_usd: totals.cost_usd,
      breakdown,
    };
  }

  function getDateRange(from: string, to: string): DailyUsageSummary[] {
    const rows = getUsageRange(db, from, to);
    const byDay = new Map<string, DailyUsage[]>();
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
        { requests: 0, total_tokens: 0, cost_usd: 0 }
      );
      return { date: day, ...totals, breakdown };
    });
  }

  function getModelBreakdown(day: string): DailyUsage[] {
    return getDailyUsage(db, day);
  }

  function getProviderBreakdown(day: string): ProviderSummary[] {
    const rows = getDailyUsage(db, day);
    const byProvider = new Map<string, ProviderSummary>();
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

  function getTotalStats(): TotalStats {
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

  function getRecentLogs(limit: number, offset: number): RequestLog[] {
    return getRecentRequests(db, limit, offset);
  }

  function getLogById(id: number): RequestLog | null {
    return getRequestById(db, id);
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
  };
}

export type UsageService = ReturnType<typeof createUsageService>;
