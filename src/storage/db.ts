import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { Logger } from "../util/logger";

const logger = Logger.fromConfig().child({ component: "storage-db" });
const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const SQLITE_WRITE_RETRY_DELAYS_MS: readonly number[] = [50, 200, 800];

export const STALE_PENDING_MAX_AGE_MS = parseStalePendingMaxAgeMs(process.env.STALE_PENDING_MAX_AGE_MS);

export namespace Storage {
  function splitStatements(sql: string): string[] {
    const stripped = sql.replace(/^\s*--.*$/gm, "");
    return stripped
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  function execSafe(db: Database, statement: string): void {
    try {
      db.exec(statement);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const ignorable =
        msg.includes("duplicate column name") ||
        msg.includes("already exists") ||
        msg.includes("no such column") ||
        (statement.toUpperCase().includes("ADD COLUMN") &&
          msg.includes("syntax error"));
      if (!ignorable) throw err;
    }
  }

  export function runWriteWithRetry<T>(_db: Database, fn: () => T): T {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return fn();
      } catch (err) {
        const delayMs = SQLITE_WRITE_RETRY_DELAYS_MS[attempt];
        if (delayMs === undefined || !isSqliteBusyError(err)) throw err;
        sleepSync(delayMs);
      }
    }
  }

  function ensureColumn(
    db: Database,
    table: string,
    column: string,
    typeDef: string,
  ): void {
    const cols = db
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === column)) return;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeDef}`);
  }

  export function initDb(dbPath: string): Database {
    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.query(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`).run();

    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const migrationsDir = join(import.meta.dir, "migrations");
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const applied = db
        .prepare("SELECT name FROM schema_migrations WHERE name = ?")
        .get(file);
      if (applied) continue;

      const sql = readFileSync(join(migrationsDir, file), "utf-8");

      const txn = db.transaction(() => {
        for (const stmt of splitStatements(sql)) {
          execSafe(db, stmt);
        }
        db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(file);
      });
      try {
        txn();
      } catch (err) {
        logger.error("migration failed", { err, file });
        throw err;
      }
    }

    ensureColumn(db, "request_logs", "cliproxy_account", "TEXT");
    ensureColumn(db, "request_logs", "cliproxy_auth_index", "TEXT");
    ensureColumn(db, "request_logs", "cliproxy_source", "TEXT");
    ensureColumn(db, "request_logs", "request_id", "TEXT");
    ensureColumn(db, "request_logs", "reasoning_tokens", "INTEGER DEFAULT 0");
    ensureColumn(db, "request_logs", "actual_model", "TEXT");
    ensureColumn(db, "request_logs", "user_agent", "TEXT");
    ensureColumn(db, "request_logs", "source_ip", "TEXT");
    ensureColumn(db, "request_logs", "correlated_at", "TEXT");
    ensureColumn(db, "request_logs", "agent", "TEXT");
    ensureColumn(db, "request_logs", "source", "TEXT DEFAULT 'proxy'");
    ensureColumn(db, "request_logs", "msg_id", "TEXT");
    ensureColumn(
      db,
      "request_logs",
      "lifecycle_status",
      "TEXT NOT NULL DEFAULT 'pending' CHECK(lifecycle_status IN ('pending', 'completed', 'error', 'aborted'))",
    );
    ensureColumn(
      db,
      "request_logs",
      "cost_status",
      "TEXT NOT NULL DEFAULT 'unresolved' CHECK(cost_status IN ('unresolved', 'ok', 'pending', 'unsupported'))",
    );
    ensureColumn(db, "request_logs", "subscription_code", "TEXT");
    ensureColumn(db, "request_logs", "finalized_at", "TEXT");
    ensureColumn(db, "request_logs", "error_message", "TEXT");

    db.exec(`
      UPDATE request_logs
      SET lifecycle_status = CASE
          WHEN incomplete = 1
            OR error_code IS NOT NULL
            OR status >= 400 THEN 'error'
          ELSE 'completed'
        END,
        finalized_at = COALESCE(finalized_at, finished_at, started_at),
        cost_status = CASE
          WHEN cost_usd > 0 THEN 'ok'
          ELSE 'pending'
        END
      WHERE lifecycle_status = 'pending'
        AND (finalized_at IS NULL OR cost_status = 'unresolved')
        AND (finished_at IS NOT NULL OR incomplete = 1 OR error_code IS NOT NULL OR status IS NOT NULL)
    `);

    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_request_logs_cliproxy_account ON request_logs(cliproxy_account)",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_request_logs_cliproxy_auth_index ON request_logs(cliproxy_auth_index)",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_request_logs_request_id ON request_logs(request_id)",
    );
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_request_logs_msg_id ON request_logs(msg_id) WHERE msg_id IS NOT NULL",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_request_logs_lifecycle_status ON request_logs(lifecycle_status)",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_request_logs_cost_status ON request_logs(cost_status)",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_request_logs_subscription_code ON request_logs(subscription_code) WHERE subscription_code IS NOT NULL",
    );

    db.exec(`
      CREATE TABLE IF NOT EXISTS cost_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_log_id INTEGER,
        model TEXT,
        provider TEXT,
        source TEXT,
        base_cost_usd REAL,
        calc_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (request_log_id) REFERENCES request_logs(id)
      )
    `);
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_cost_audit_request_log_id ON cost_audit(request_log_id)",
    );

    db.exec(`
      CREATE TABLE IF NOT EXISTS quota_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        provider TEXT NOT NULL,
        account TEXT NOT NULL,
        quota_type TEXT NOT NULL,
        used_pct REAL,
        remaining REAL,
        remaining_raw TEXT,
        resets_at TEXT,
        raw_json TEXT
      )
    `);
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_quota_snapshots_provider ON quota_snapshots(provider, account, timestamp)",
    );

    db.exec(`
      CREATE TABLE IF NOT EXISTS daily_account_usage (
        day TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        cliproxy_account TEXT NOT NULL,
        cliproxy_auth_index TEXT,
        request_count INTEGER DEFAULT 0,
        prompt_tokens INTEGER DEFAULT 0,
        completion_tokens INTEGER DEFAULT 0,
        cache_creation_tokens INTEGER DEFAULT 0,
        cache_read_tokens INTEGER DEFAULT 0,
        reasoning_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        cost_usd REAL DEFAULT 0,
        PRIMARY KEY (day, provider, model, cliproxy_account)
      )
    `);
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_daily_account_usage_day ON daily_account_usage(day)",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_daily_account_usage_account ON daily_account_usage(cliproxy_account)",
    );

    return db;
  }

  export function recoverStalePending(
    db: Database,
    maxAgeMs: number = STALE_PENDING_MAX_AGE_MS,
  ): number {
    const now = new Date().toISOString();
    const threshold = new Date(Date.now() - maxAgeMs).toISOString();
    const stmt = db.prepare(`
      UPDATE request_logs
      SET lifecycle_status = 'aborted',
          error_message = 'boot-recovery',
          finalized_at = ?,
          finished_at = COALESCE(finished_at, ?),
          incomplete = 1,
          cost_status = CASE
            WHEN cost_status = 'unresolved' THEN 'pending'
            ELSE cost_status
          END
      WHERE lifecycle_status = 'pending'
        AND started_at < ?
    `);
    const result = stmt.run(now, now, threshold);
    const recovered = result.changes;
    if (recovered > 0) {
      logger.warn("recovered stale pending request logs", {
        event: "lifecycle.boot_recovery",
        recovered,
        max_age_ms: maxAgeMs,
        threshold,
      });
    }
    return recovered;
  }
}

function isSqliteBusyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;

  const code = getErrorCode(err);
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return true;

  const message = err.message.toLowerCase();
  return message.includes("sqlite_busy") ||
    message.includes("sqlite_locked") ||
    message.includes("database is locked") ||
    message.includes("database table is locked");
}

function getErrorCode(err: Error): unknown {
  if (!("code" in err)) return undefined;
  return (err as { readonly code?: unknown }).code;
}

function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function parseStalePendingMaxAgeMs(raw: string | undefined): number {
  if (raw === undefined) return 600_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 600_000;
  return parsed;
}
