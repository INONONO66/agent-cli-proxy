import { Database } from "bun:sqlite";
import { Usage } from "../usage";

export namespace RequestRepo {
  export interface MonthlyAccountCost {
    cliproxy_account: string;
    subscription_code: string | null;
    total_requests: number;
    total_cost_usd: number;
  }

  export interface AccountRecentUsage {
    started_at: string;
    model: string;
    total_tokens: number;
    cost_usd: number;
    lifecycle_status: Usage.LifecycleStatus;
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
        request_id, provider, model, actual_model, tool, client_id, path,
        streamed, status, prompt_tokens, completion_tokens,
        cache_creation_tokens, cache_read_tokens, reasoning_tokens,
        total_tokens, cost_usd, incomplete, error_code, latency_ms,
        started_at, finished_at, meta_json, user_agent, source_ip,
        agent, source, msg_id, lifecycle_status, cost_status,
        subscription_code, finalized_at, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      log.request_id ?? null,
      log.provider,
      log.model,
      log.actual_model ?? null,
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

  export function aggregateByAccountForMonth(
    db: Database,
    monthStart: string,
    monthEnd: string,
  ): MonthlyAccountCost[] {
    const stmt = db.prepare(`
      SELECT
        rl.cliproxy_account AS cliproxy_account,
        sub.subscription_code AS subscription_code,
        COUNT(*) AS total_requests,
        COALESCE(SUM(rl.cost_usd), 0) AS total_cost_usd
      FROM request_logs rl
      LEFT JOIN account_subscriptions sub
        ON sub.cliproxy_account = rl.cliproxy_account
      WHERE rl.lifecycle_status = 'completed'
        AND rl.started_at >= ?
        AND rl.started_at < ?
        AND rl.cliproxy_account IS NOT NULL
        AND rl.cliproxy_account <> ''
      GROUP BY rl.cliproxy_account, sub.subscription_code
      ORDER BY total_cost_usd DESC, rl.cliproxy_account ASC
    `);
    return stmt.all(monthStart, monthEnd).map((row) => {
      const record = row as Record<string, unknown>;
      return {
        cliproxy_account: String(record.cliproxy_account),
        subscription_code: typeof record.subscription_code === "string" ? record.subscription_code : null,
        total_requests: Number(record.total_requests ?? 0),
        total_cost_usd: Number(record.total_cost_usd ?? 0),
      };
    });
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

  export function applySubscription(
    db: Database,
    id: number,
    subscriptionCode: string,
  ): void {
    db.prepare("UPDATE request_logs SET subscription_code = ? WHERE id = ?")
      .run(subscriptionCode, id);
  }

  export function updateFinalize(
    db: Database,
    id: number,
    fields: {
      provider?: string;
      model?: string;
      actual_model?: string;
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
}

function parseLifecycleStatus(value: unknown): Usage.LifecycleStatus {
  if (value === "completed" || value === "error" || value === "aborted") return value;
  return "pending";
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
}
