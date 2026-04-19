import { Database } from "bun:sqlite";
import type { RequestLog } from "../types";

export function insertRequest(
  db: Database,
  log: Omit<RequestLog, "id">
): number {
  const stmt = db.prepare(`
    INSERT INTO request_logs (
      provider, model, path, streamed, status, prompt_tokens,
      completion_tokens, cache_creation_tokens, cache_read_tokens,
      total_tokens, cost_usd, incomplete, error_code, latency_ms,
      started_at, finished_at, meta_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    log.provider,
    log.model,
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
    log.meta_json ?? null
  );

  return result.lastInsertRowid as number;
}

export function updateRequest(
  db: Database,
  id: number,
  update: Partial<RequestLog>
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  const fieldMap: Record<string, keyof RequestLog> = {
    status: "status",
    prompt_tokens: "prompt_tokens",
    completion_tokens: "completion_tokens",
    cache_creation_tokens: "cache_creation_tokens",
    cache_read_tokens: "cache_read_tokens",
    total_tokens: "total_tokens",
    cost_usd: "cost_usd",
    incomplete: "incomplete",
    error_code: "error_code",
    latency_ms: "latency_ms",
    finished_at: "finished_at",
    meta_json: "meta_json",
  };

  for (const [key, dbField] of Object.entries(fieldMap)) {
    if (dbField in update) {
      fields.push(`${key} = ?`);
      values.push(update[dbField]);
    }
  }

  if (fields.length === 0) return;

  values.push(id);
  const sql = `UPDATE request_logs SET ${fields.join(", ")} WHERE id = ?`;
  const stmt = db.prepare(sql);
  stmt.run(...(values as Parameters<typeof stmt.run>));
}

export function getRequestsByDate(db: Database, date: string): RequestLog[] {
  const stmt = db.prepare(`
    SELECT * FROM request_logs
    WHERE DATE(started_at) = ?
    ORDER BY started_at DESC
  `);
  return stmt.all(date) as RequestLog[];
}

export function getRecentRequests(
  db: Database,
  limit: number,
  offset: number
): RequestLog[] {
  const stmt = db.prepare(`
    SELECT * FROM request_logs
    ORDER BY started_at DESC
    LIMIT ? OFFSET ?
  `);
  return stmt.all(limit, offset) as RequestLog[];
}

export function getRequestById(db: Database, id: number): RequestLog | null {
  const stmt = db.prepare("SELECT * FROM request_logs WHERE id = ?");
  return (stmt.get(id) as RequestLog) || null;
}
