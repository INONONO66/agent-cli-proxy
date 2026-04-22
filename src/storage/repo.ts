import { Database } from "bun:sqlite";
import { Usage } from "../usage";

export namespace RequestRepo {
  export function insert(db: Database, log: Omit<Usage.RequestLog, "id">): number {
    const stmt = db.prepare(`
      INSERT INTO request_logs (
        provider, model, tool, client_id, path, streamed, status, prompt_tokens,
        completion_tokens, cache_creation_tokens, cache_read_tokens,
        total_tokens, cost_usd, incomplete, error_code, latency_ms,
        started_at, finished_at, meta_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      log.provider,
      log.model,
      log.tool,
      log.client_id,
      log.path,
      log.streamed,
      log.status ?? null,
      log.prompt_tokens,
      log.completion_tokens,
      log.cache_creation_tokens,
      log.cache_read_tokens,
      log.total_tokens,
      log.cost_usd,
      log.incomplete,
      log.error_code ?? null,
      log.latency_ms ?? null,
      log.started_at,
      log.finished_at ?? null,
      log.meta_json ?? null,
    );

    return result.lastInsertRowid as number;
  }

  export function getRecent(
    db: Database,
    limit: number,
    offset: number,
    tool?: string,
    clientId?: string,
  ): Usage.RequestLog[] {
    let sql = `SELECT * FROM request_logs WHERE 1=1`;
    const params: (string | number)[] = [];

    if (tool) {
      sql += ` AND tool = ?`;
      params.push(tool);
    }
    if (clientId) {
      sql += ` AND client_id = ?`;
      params.push(clientId);
    }

    sql += ` ORDER BY started_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const stmt = db.prepare(sql);
    return stmt.all(...params) as Usage.RequestLog[];
  }

  export function getById(db: Database, id: number): Usage.RequestLog | null {
    const stmt = db.prepare("SELECT * FROM request_logs WHERE id = ?");
    return (stmt.get(id) as Usage.RequestLog) || null;
  }
}

export namespace UsageRepo {
  export function upsertDaily(db: Database, usage: Usage.DailyUsage): void {
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
      usage.cost_usd,
    );
  }

  export function getDaily(db: Database, day: string): Usage.DailyUsage[] {
    const stmt = db.prepare(`
      SELECT * FROM daily_usage
      WHERE day = ?
      ORDER BY provider, model
    `);
    return stmt.all(day) as Usage.DailyUsage[];
  }

  export function getRange(db: Database, from: string, to: string): Usage.DailyUsage[] {
    const stmt = db.prepare(`
      SELECT * FROM daily_usage
      WHERE day >= ? AND day <= ?
      ORDER BY day DESC, provider, model
    `);
    return stmt.all(from, to) as Usage.DailyUsage[];
  }
}
