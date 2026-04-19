import { Database } from "bun:sqlite";
import type { DailyUsage } from "../types";

export function upsertDailyUsage(db: Database, usage: DailyUsage): void {
  const stmt = db.prepare(`
    INSERT INTO daily_usage (
      day, provider, model, request_count, prompt_tokens,
      completion_tokens, cache_creation_tokens, cache_read_tokens,
      total_tokens, cost_usd
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(day, provider, model) DO UPDATE SET
      request_count = request_count + excluded.request_count,
      prompt_tokens = prompt_tokens + excluded.prompt_tokens,
      completion_tokens = completion_tokens + excluded.completion_tokens,
      cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
      cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
      total_tokens = total_tokens + excluded.total_tokens,
      cost_usd = cost_usd + excluded.cost_usd
  `);

  stmt.run(
    usage.day,
    usage.provider,
    usage.model,
    usage.request_count,
    usage.prompt_tokens,
    usage.completion_tokens,
    usage.cache_creation_tokens,
    usage.cache_read_tokens,
    usage.total_tokens,
    usage.cost_usd
  );
}

export function getDailyUsage(db: Database, day: string): DailyUsage[] {
  const stmt = db.prepare(`
    SELECT * FROM daily_usage
    WHERE day = ?
    ORDER BY provider, model
  `);
  return stmt.all(day) as DailyUsage[];
}

export function getUsageRange(
  db: Database,
  from: string,
  to: string
): DailyUsage[] {
  const stmt = db.prepare(`
    SELECT * FROM daily_usage
    WHERE day >= ? AND day <= ?
    ORDER BY day DESC, provider, model
  `);
  return stmt.all(from, to) as DailyUsage[];
}
