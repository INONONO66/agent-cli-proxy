import { Database } from "bun:sqlite";
import { Usage } from "../usage";

export namespace RequestRepo {
  export interface AccountRecentUsage {
    started_at: string;
    model: string;
    total_tokens: number;
    cost_usd: number;
    lifecycle_status: Usage.LifecycleStatus;
  }

  export interface TrendBucket {
    timestamp: string;
    requests: number;
    tokens: number;
    cost_usd: number;
  }

  export interface TrendOptions {
    hours: number;
    from?: string;
    to?: string;
    provider?: string;
    model?: string;
    tool?: string;
  }

  export function insert(db: Database, log: Omit<Usage.RequestLog, "id">): number {
    const lifecycleStatus =
      log.lifecycle_status ??
      (log.incomplete === 1 || log.error_code || (log.status ?? 0) >= 400
        ? "error"
        : "completed");
    const costStatus =
      log.cost_status ??
      (log.cost_usd > 0
        ? "ok"
        : lifecycleStatus === "pending"
          ? "unresolved"
          : "pending");
    const finalizedAt =
      log.finalized_at ??
      (lifecycleStatus === "pending"
        ? null
        : (log.finished_at ?? log.started_at));

    const stmt = db.prepare(`
      INSERT INTO request_logs (
        request_id, provider, model, actual_model, proxy_api_key_id, tool, client_id, path,
        streamed, status, prompt_tokens, completion_tokens,
        cache_creation_tokens, cache_read_tokens, reasoning_tokens,
        total_tokens, cost_usd, incomplete, error_code, latency_ms,
        started_at, finished_at, meta_json, user_agent, source_ip,
        agent, source, msg_id, lifecycle_status, cost_status,
        subscription_code, finalized_at, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      log.request_id ?? null,
      log.provider,
      log.model,
      log.actual_model ?? null,
      log.proxy_api_key_id ?? null,
      log.tool,
      log.client_id,
      log.path,
      log.streamed,
      log.status ?? null,
      log.prompt_tokens,
      log.completion_tokens,
      log.cache_creation_tokens,
      log.cache_read_tokens,
      log.reasoning_tokens ?? 0,
      log.total_tokens,
      log.cost_usd,
      log.incomplete,
      log.error_code ?? null,
      log.latency_ms ?? null,
      log.started_at,
      log.finished_at ?? null,
      log.meta_json ?? null,
      log.user_agent ?? null,
      log.source_ip ?? null,
      log.agent ?? null,
      log.source ?? "proxy",
      log.msg_id ?? null,
      lifecycleStatus,
      costStatus,
      log.subscription_code ?? null,
      finalizedAt,
      log.error_message ?? null,
    );

    return result.lastInsertRowid as number;
  }

  export function getRecent(
    db: Database,
    limit: number,
    offset: number,
    tool?: string,
    clientId?: string,
  ): Usage.RequestLog[];
  export function getRecent(
    db: Database,
    limit: number,
    offset: number,
    filters?: {
      tool?: string;
      clientId?: string;
      model?: string;
      provider?: string;
      statusMin?: number;
      statusMax?: number;
      lifecycleStatus?: Usage.LifecycleStatus;
    },
  ): Usage.RequestLog[];
  export function getRecent(
    db: Database,
    limit: number,
    offset: number,
    toolOrFilters?: string | {
      tool?: string;
      clientId?: string;
      model?: string;
      provider?: string;
      statusMin?: number;
      statusMax?: number;
      lifecycleStatus?: Usage.LifecycleStatus;
    },
    clientId?: string,
  ): Usage.RequestLog[] {
    const filters =
      typeof toolOrFilters === "object" && toolOrFilters !== null
        ? toolOrFilters
        : {
            tool: toolOrFilters,
            clientId,
          };

    return getRecentWithFilters(db, limit, offset, filters);
  }

  function getRecentWithFilters(
    db: Database,
    limit: number,
    offset: number,
    filters: {
      tool?: string;
      clientId?: string;
      model?: string;
      provider?: string;
      statusMin?: number;
      statusMax?: number;
      lifecycleStatus?: Usage.LifecycleStatus;
    },
  ): Usage.RequestLog[] {
    let sql = `SELECT * FROM request_logs WHERE 1=1`;
    const params: (string | number)[] = [];

    if (filters.tool) {
      sql += ` AND tool = ?`;
      params.push(filters.tool);
    }
    if (filters.clientId) {
      sql += ` AND client_id = ?`;
      params.push(filters.clientId);
    }
    if (filters.model) {
      sql += ` AND model = ?`;
      params.push(filters.model);
    }
    if (filters.provider) {
      sql += ` AND provider = ?`;
      params.push(filters.provider);
    }
    if (filters.statusMin !== undefined) {
      sql += ` AND status >= ?`;
      params.push(filters.statusMin);
    }
    if (filters.statusMax !== undefined) {
      sql += ` AND status <= ?`;
      params.push(filters.statusMax);
    }
    if (filters.lifecycleStatus) {
      sql += ` AND lifecycle_status = ?`;
      params.push(filters.lifecycleStatus);
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

  export function getRecentByAccount(
    db: Database,
    cliproxyAccount: string,
    limit: number,
  ): AccountRecentUsage[] {
    const stmt = db.prepare(`
      SELECT started_at, model, total_tokens, cost_usd, lifecycle_status
      FROM request_logs
      WHERE cliproxy_account = ?
      ORDER BY started_at DESC
      LIMIT ?
    `);
    return stmt.all(cliproxyAccount, limit).map((row) => {
      const record = row as Record<string, unknown>;
      return {
        started_at: String(record.started_at),
        model: String(record.model),
        total_tokens: Number(record.total_tokens ?? 0),
        cost_usd: Number(record.cost_usd ?? 0),
        lifecycle_status: parseLifecycleStatus(record.lifecycle_status),
      };
    });
  }

  export function getTrend(db: Database, options: TrendOptions): TrendBucket[] {
    const hasRange = options.from && options.to;
    const fromIso = hasRange
      ? options.from!
      : new Date(Date.now() - options.hours * 60 * 60 * 1000).toISOString();
    const toIso = hasRange ? options.to! : new Date().toISOString();
    const spanHours = hasRange
      ? Math.max(1, (new Date(toIso).getTime() - new Date(fromIso).getTime()) / (1000 * 60 * 60))
      : options.hours;
    const bucketSeconds = resolveTrendBucketSeconds(spanHours);

    let sql = `
      WITH bucketed AS (
        SELECT
          strftime('%Y-%m-%dT%H:%M:%SZ', datetime((CAST(strftime('%s', started_at) AS INTEGER) / ?) * ?, 'unixepoch')) AS timestamp,
          total_tokens,
          cost_usd
        FROM request_logs
        WHERE started_at >= ? AND started_at < ?
    `;
    const params: Array<string | number> = [bucketSeconds, bucketSeconds, fromIso, toIso];

    if (options.provider) {
      sql += ` AND provider = ?`;
      params.push(options.provider);
    }
    if (options.model) {
      sql += ` AND model = ?`;
      params.push(options.model);
    }
    if (options.tool) {
      sql += ` AND tool = ?`;
      params.push(options.tool);
    }

    sql += `
      )
      SELECT
        timestamp,
        COUNT(*) AS requests,
        COALESCE(SUM(total_tokens), 0) AS tokens,
        COALESCE(SUM(cost_usd), 0) AS cost_usd
      FROM bucketed
      GROUP BY timestamp
      ORDER BY timestamp ASC
    `;

    return db.prepare(sql).all(...params).map((row) => {
      const record = row as Record<string, unknown>;
      return {
        timestamp: String(record.timestamp),
        requests: Number(record.requests ?? 0),
        tokens: Number(record.tokens ?? 0),
        cost_usd: Number(record.cost_usd ?? 0),
      };
    });
  }

  export function getUncorrelated(
    db: Database,
    sinceMs: number,
    limit: number,
  ): Usage.RequestLog[] {
    const sinceIso = new Date(Date.now() - sinceMs).toISOString();
    const stmt = db.prepare(`
      SELECT * FROM request_logs
      WHERE cliproxy_account IS NULL
        AND status = 200
        AND started_at >= ?
      ORDER BY started_at DESC
      LIMIT ?
    `);
    return stmt.all(sinceIso, limit) as Usage.RequestLog[];
  }

  function resolveTrendBucketSeconds(hours: number): number {
    if (hours <= 5) return 5 * 60;
    if (hours <= 24) return 60 * 60;
    if (hours <= 7 * 24) return 4 * 60 * 60;
    return 24 * 60 * 60;
  }

  export function applyCorrelation(
    db: Database,
    id: number,
    fields: {
      cliproxy_account?: string;
      cliproxy_auth_index?: string;
      cliproxy_source?: string;
      reasoning_tokens?: number;
      actual_model?: string;
    },
  ): number {
    const stmt = db.prepare(`
      UPDATE request_logs
      SET cliproxy_account = COALESCE(?, cliproxy_account),
          cliproxy_auth_index = COALESCE(?, cliproxy_auth_index),
          cliproxy_source = COALESCE(?, cliproxy_source),
          reasoning_tokens = COALESCE(?, reasoning_tokens),
          actual_model = COALESCE(?, actual_model),
          correlated_at = ?
      WHERE id = ? AND cliproxy_account IS NULL
    `);
    const result = stmt.run(
      fields.cliproxy_account ?? null,
      fields.cliproxy_auth_index ?? null,
      fields.cliproxy_source ?? null,
      fields.reasoning_tokens ?? null,
      fields.actual_model ?? null,
      new Date().toISOString(),
      id,
    );
    return result.changes;
  }

  export function updateLifecycle(
    db: Database,
    id: number,
    fields: {
      lifecycle_status?: Usage.LifecycleStatus;
      finalized_at?: string;
      error_message?: string;
      cost_status?: Usage.CostStatus;
      subscription_code?: string;
    },
  ): void {
    const stmt = db.prepare(`
      UPDATE request_logs
      SET lifecycle_status = COALESCE(?, lifecycle_status),
          finalized_at = COALESCE(?, finalized_at),
          error_message = COALESCE(?, error_message),
          cost_status = COALESCE(?, cost_status),
          subscription_code = COALESCE(?, subscription_code)
      WHERE id = ?
    `);
    stmt.run(
      fields.lifecycle_status ?? null,
      fields.finalized_at ?? null,
      fields.error_message ?? null,
      fields.cost_status ?? null,
      fields.subscription_code ?? null,
      id,
    );
  }

  export function updateFinalize(
    db: Database,
    id: number,
    fields: {
      provider?: string;
      model?: string;
      actual_model?: string;
      proxy_api_key_id?: number;
      streamed?: number;
      status?: number;
      prompt_tokens?: number;
      completion_tokens?: number;
      cache_creation_tokens?: number;
      cache_read_tokens?: number;
      reasoning_tokens?: number;
      total_tokens?: number;
      cost_usd?: number;
      incomplete?: number;
      error_code?: string;
      latency_ms?: number;
      finished_at?: string;
      lifecycle_status: Usage.LifecycleStatus;
      finalized_at: string;
      error_message?: string;
      cost_status: Usage.CostStatus;
      subscription_code?: string;
    },
  ): number {
    const stmt = db.prepare(`
      UPDATE request_logs
      SET provider = COALESCE(?, provider),
          model = COALESCE(?, model),
          actual_model = COALESCE(?, actual_model),
          proxy_api_key_id = COALESCE(?, proxy_api_key_id),
          streamed = COALESCE(?, streamed),
          status = COALESCE(?, status),
          prompt_tokens = COALESCE(?, prompt_tokens),
          completion_tokens = COALESCE(?, completion_tokens),
          cache_creation_tokens = COALESCE(?, cache_creation_tokens),
          cache_read_tokens = COALESCE(?, cache_read_tokens),
          reasoning_tokens = COALESCE(?, reasoning_tokens),
          total_tokens = COALESCE(?, total_tokens),
          cost_usd = COALESCE(?, cost_usd),
          incomplete = COALESCE(?, incomplete),
          error_code = COALESCE(?, error_code),
          latency_ms = COALESCE(?, latency_ms),
          finished_at = COALESCE(?, finished_at),
          lifecycle_status = ?,
          finalized_at = ?,
          error_message = COALESCE(?, error_message),
          cost_status = ?,
          subscription_code = COALESCE(?, subscription_code)
      WHERE id = ? AND lifecycle_status = 'pending'
    `);
    const result = stmt.run(
      fields.provider ?? null,
      fields.model ?? null,
      fields.actual_model ?? null,
      fields.proxy_api_key_id ?? null,
      fields.streamed ?? null,
      fields.status ?? null,
      fields.prompt_tokens ?? null,
      fields.completion_tokens ?? null,
      fields.cache_creation_tokens ?? null,
      fields.cache_read_tokens ?? null,
      fields.reasoning_tokens ?? null,
      fields.total_tokens ?? null,
      fields.cost_usd ?? null,
      fields.incomplete ?? null,
      fields.error_code ?? null,
      fields.latency_ms ?? null,
      fields.finished_at ?? null,
      fields.lifecycle_status,
      fields.finalized_at,
      fields.error_message ?? null,
      fields.cost_status,
      fields.subscription_code ?? null,
      id,
    );
    return result.changes;
  }

  export function insertCostAudit(
    db: Database,
    audit: Omit<Usage.CostAudit, "id">,
  ): number {
    const stmt = db.prepare(`
      INSERT INTO cost_audit (
        request_log_id, model, provider, source, base_cost_usd, calc_at
      ) VALUES (?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
    `);
    const result = stmt.run(
      audit.request_log_id ?? null,
      audit.model ?? null,
      audit.provider ?? null,
      audit.source ?? null,
      audit.base_cost_usd ?? null,
      audit.calc_at ?? null,
    );
    return result.lastInsertRowid as number;
  }

  export function getLatestCostAudit(db: Database, requestLogId: number): Usage.CostAudit | null {
    const stmt = db.prepare(`
      SELECT * FROM cost_audit
      WHERE request_log_id = ?
      ORDER BY id DESC
      LIMIT 1
    `);
    return (stmt.get(requestLogId) as Usage.CostAudit) || null;
  }
}

function parseLifecycleStatus(value: unknown): Usage.LifecycleStatus {
  if (value === "completed" || value === "error" || value === "aborted") return value;
  return "pending";
}

export namespace UsageRepo {
  export interface DailyBucket {
    day: string;
    provider: string;
    model: string;
  }

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

  export function refreshDailyBucket(db: Database, bucket: DailyBucket): void {
    db.prepare("DELETE FROM daily_usage WHERE day = ? AND provider = ? AND model = ?")
      .run(bucket.day, bucket.provider, bucket.model);

    db.prepare(`
      INSERT INTO daily_usage (
        day, provider, model, request_count, prompt_tokens,
        completion_tokens, cache_creation_tokens, cache_read_tokens,
        total_tokens, cost_usd
      )
      SELECT
        substr(started_at, 1, 10), provider, model, COUNT(*),
        COALESCE(SUM(prompt_tokens), 0), COALESCE(SUM(completion_tokens), 0),
        COALESCE(SUM(cache_creation_tokens), 0), COALESCE(SUM(cache_read_tokens), 0),
        COALESCE(SUM(total_tokens), 0), COALESCE(SUM(cost_usd), 0)
      FROM request_logs
      WHERE lifecycle_status IN ('completed', 'error')
        AND substr(started_at, 1, 10) = ?
        AND provider = ?
        AND model = ?
      GROUP BY substr(started_at, 1, 10), provider, model
    `).run(bucket.day, bucket.provider, bucket.model);
  }

  export function upsertDailyAccount(
    db: Database,
    usage: Usage.DailyAccountUsage,
  ): void {
    const stmt = db.prepare(`
      INSERT INTO daily_account_usage (
        day, provider, model, cliproxy_account, cliproxy_auth_index,
        request_count, prompt_tokens, completion_tokens,
        cache_creation_tokens, cache_read_tokens, reasoning_tokens,
        total_tokens, cost_usd
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(day, provider, model, cliproxy_account) DO UPDATE SET
        cliproxy_auth_index = COALESCE(excluded.cliproxy_auth_index, cliproxy_auth_index),
        request_count = request_count + excluded.request_count,
        prompt_tokens = prompt_tokens + excluded.prompt_tokens,
        completion_tokens = completion_tokens + excluded.completion_tokens,
        cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
        cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
        reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
        total_tokens = total_tokens + excluded.total_tokens,
        cost_usd = cost_usd + excluded.cost_usd
    `);

    stmt.run(
      usage.day,
      usage.provider,
      usage.model,
      usage.cliproxy_account,
      usage.cliproxy_auth_index ?? null,
      usage.request_count,
      usage.prompt_tokens,
      usage.completion_tokens,
      usage.cache_creation_tokens,
      usage.cache_read_tokens,
      usage.reasoning_tokens,
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

  export function getDailyByAccount(
    db: Database,
    day: string,
  ): Usage.DailyAccountUsage[] {
    const stmt = db.prepare(`
      SELECT * FROM daily_account_usage
      WHERE day = ?
      ORDER BY cliproxy_account, provider, model
    `);
    return stmt.all(day) as Usage.DailyAccountUsage[];
  }

  export function getRange(db: Database, from: string, to: string): Usage.DailyUsage[] {
    const stmt = db.prepare(`
      SELECT * FROM daily_usage
      WHERE day >= ? AND day <= ?
      ORDER BY day DESC, provider, model
    `);
    return stmt.all(from, to) as Usage.DailyUsage[];
  }

  export function getAccountRange(
    db: Database,
    from: string,
    to: string,
  ): Usage.DailyAccountUsage[] {
    const stmt = db.prepare(`
      SELECT * FROM daily_account_usage
      WHERE day >= ? AND day <= ?
      ORDER BY day DESC, cliproxy_account, provider, model
    `);
    return stmt.all(from, to) as Usage.DailyAccountUsage[];
  }

  export function getAccountSummary(
    db: Database,
    from: string,
    to: string,
  ): Usage.AccountSummary[] {
    const stmt = db.prepare(`
      SELECT
        cliproxy_account,
        cliproxy_auth_index,
        provider,
        SUM(request_count) AS request_count,
        SUM(total_tokens) AS total_tokens,
        SUM(cost_usd) AS cost_usd
      FROM daily_account_usage
      WHERE day >= ? AND day <= ?
      GROUP BY cliproxy_account, cliproxy_auth_index, provider
      ORDER BY cost_usd DESC
    `);
    return stmt.all(from, to) as Usage.AccountSummary[];
  }
}

export namespace QuotaRepo {
  export interface HistoryQuery {
    hours: number;
    from?: string;
    to?: string;
    provider?: string;
    account?: string;
  }

  export interface HistorySnapshot {
    provider: string;
    account: string;
    quota_type: string;
    used_pct: number | null;
  }

  export interface HistoryBucket {
    timestamp: string;
    snapshots: HistorySnapshot[];
  }

  export function insertSnapshot(db: Database, snapshot: Usage.QuotaSnapshot): number {
    const stmt = db.prepare(`
      INSERT INTO quota_snapshots (
        timestamp, provider, account, quota_type, used_pct,
        remaining, remaining_raw, resets_at, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      snapshot.timestamp,
      snapshot.provider,
      snapshot.account,
      snapshot.quota_type,
      snapshot.used_pct ?? null,
      snapshot.remaining ?? null,
      snapshot.remaining_raw ?? null,
      snapshot.resets_at ?? null,
      snapshot.raw_json ?? null,
    );
    return result.lastInsertRowid as number;
  }

  export function deleteOlderThan30Days(db: Database): number {
    const result = db.prepare(`
      DELETE FROM quota_snapshots
      WHERE timestamp < datetime('now', '-30 days')
    `).run();
    return result.changes;
  }

  export function getLatest(db: Database): Usage.QuotaSnapshot[] {
    const stmt = db.prepare(`
      SELECT q.*
      FROM quota_snapshots q
      JOIN (
        SELECT provider, account, quota_type, MAX(timestamp) AS max_timestamp
        FROM quota_snapshots
        GROUP BY provider, account, quota_type
      ) latest
        ON latest.provider = q.provider
       AND latest.account = q.account
       AND latest.quota_type = q.quota_type
       AND latest.max_timestamp = q.timestamp
      ORDER BY q.provider, q.account, q.quota_type
    `);
    return stmt.all() as Usage.QuotaSnapshot[];
  }

  export function getHistory(db: Database, query: HistoryQuery): HistoryBucket[] {
    const hasRange = query.from && query.to;
    const startIso = hasRange ? query.from! : new Date(Date.now() - query.hours * 60 * 60 * 1000).toISOString();
    const endIso = hasRange ? query.to! : new Date().toISOString();
    const spanHours = hasRange
      ? Math.max(1, (new Date(endIso).getTime() - new Date(startIso).getTime()) / (1000 * 60 * 60))
      : query.hours;
    const bucketSeconds = getBucketSeconds(spanHours);

    let sql = `
      WITH bucketed AS (
        SELECT
          strftime('%Y-%m-%dT%H:%M:%SZ', (strftime('%s', timestamp) / ?) * ?, 'unixepoch') AS bucket_timestamp,
          provider,
          account,
          quota_type,
          used_pct,
          timestamp,
          id
        FROM quota_snapshots
        WHERE timestamp >= ?
          AND timestamp < ?
    `;
    const params: (number | string)[] = [bucketSeconds, bucketSeconds, startIso, endIso];

    if (query.provider) {
      sql += `
          AND provider = ?`;
      params.push(query.provider);
    }

    if (query.account) {
      sql += `
          AND account = ?`;
      params.push(query.account);
    }

    sql += `
      ), ranked AS (
        SELECT
          bucket_timestamp,
          provider,
          account,
          quota_type,
          used_pct,
          ROW_NUMBER() OVER (
            PARTITION BY bucket_timestamp, provider, account, quota_type
            ORDER BY timestamp DESC, id DESC
          ) AS rn
        FROM bucketed
      )
      SELECT bucket_timestamp, provider, account, quota_type, used_pct
      FROM ranked
      WHERE rn = 1
      ORDER BY bucket_timestamp ASC, provider ASC, account ASC, quota_type ASC
    `;

    const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
    const buckets = new Map<string, HistorySnapshot[]>();

    for (const row of rows) {
      const bucketTimestamp = String(row.bucket_timestamp);
      const snapshots = buckets.get(bucketTimestamp) ?? [];
      snapshots.push({
        provider: String(row.provider),
        account: String(row.account),
        quota_type: String(row.quota_type),
        used_pct: typeof row.used_pct === "number" ? row.used_pct : null,
      });
      buckets.set(bucketTimestamp, snapshots);
    }

    const bucketMs = bucketSeconds * 1000;
    const startMs = new Date(startIso).getTime();
    const endMs = new Date(endIso).getTime();
    const startBucketMs = Math.floor(startMs / bucketMs) * bucketMs;
    const endBucketMs = Math.floor(endMs / bucketMs) * bucketMs;
    const history: HistoryBucket[] = [];

    for (let current = startBucketMs; current <= endBucketMs; current += bucketMs) {
      const timestamp = formatBucketTimestamp(current);
      history.push({
        timestamp,
        snapshots: buckets.get(timestamp) ?? [],
      });
    }

    return history;
  }

  export function getLocalWindowUsage(
    db: Database,
    provider: string,
    account: string,
    sinceIso: string,
  ): Usage.AccountUsageWindow {
    const row = db
      .prepare(`
        SELECT
          COUNT(*) AS requests,
          COALESCE(SUM(total_tokens), 0) AS total_tokens,
          COALESCE(SUM(cost_usd), 0) AS cost_usd
        FROM request_logs
        WHERE provider = ?
          AND cliproxy_account = ?
          AND started_at >= ?
      `)
      .get(provider, account, sinceIso) as {
      requests?: number;
      total_tokens?: number;
      cost_usd?: number;
    };

    return {
      since: sinceIso,
      requests: Number(row.requests ?? 0),
      total_tokens: Number(row.total_tokens ?? 0),
      cost_usd: Number(row.cost_usd ?? 0),
    };
  }

  function getBucketSeconds(hours: number): number {
    if (hours <= 5) return 5 * 60;
    if (hours <= 24) return 60 * 60;
    if (hours <= 168) return 4 * 60 * 60;
    return 24 * 60 * 60;
  }

  function formatBucketTimestamp(epochMs: number): string {
    return new Date(epochMs).toISOString().replace(".000Z", "Z");
  }
}
