import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { DEFAULT_STALE_PENDING_MAX_AGE_MS } from "../config/validate";
import { Logger } from "../util/logger";

const logger = Logger.fromConfig().child({ component: "storage-db" });
const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const SQLITE_WRITE_RETRY_DELAYS_MS: readonly number[] = [50, 200, 800];
const REQUIRED_COLUMNS = {
  request_logs: [
    "id", "request_id", "provider", "model", "actual_model", "actual_provider", "proxy_api_key_id",
    "tool", "client_id", "agent", "source", "msg_id", "path", "streamed", "status",
    "prompt_tokens", "completion_tokens", "cache_creation_tokens", "cache_read_tokens",
    "reasoning_tokens", "total_tokens", "cost_usd", "cost_status", "lifecycle_status",
    "incomplete", "error_code", "error_message", "latency_ms", "started_at", "finished_at",
    "finalized_at", "meta_json", "user_agent", "source_ip", "cliproxy_account",
    "cliproxy_auth_index", "cliproxy_source", "correlated_at",
  ],
  daily_usage: [
    "day", "provider", "model", "request_count", "prompt_tokens", "completion_tokens",
    "cache_creation_tokens", "cache_read_tokens", "total_tokens", "cost_usd",
  ],
  daily_account_usage: [
    "day", "provider", "model", "cliproxy_account", "cliproxy_auth_index", "request_count",
    "prompt_tokens", "completion_tokens", "cache_creation_tokens", "cache_read_tokens",
    "reasoning_tokens", "total_tokens", "cost_usd",
  ],
  quota_snapshots: [
    "id", "timestamp", "provider", "account", "quota_type", "model", "used_pct",
    "remaining", "remaining_raw", "resets_at", "raw_json",
  ],
  cost_audit: ["id", "request_log_id", "model", "provider", "source", "base_cost_usd", "calc_at"],
  api_keys: [
    "id", "key_hash", "key_prefix", "name", "created_at", "revoked_at", "last_used_at",
    "allowed_accounts", "allowed_providers",
  ],
} as const;
const REQUIRED_INDEXES = [
  "idx_request_logs_started_at",
  "idx_request_logs_tool",
  "idx_request_logs_client_id",
  "idx_request_logs_cliproxy_account",
  "idx_request_logs_cliproxy_auth_index",
  "idx_request_logs_request_id",
  "idx_request_logs_msg_id",
  "idx_request_logs_lifecycle_status",
  "idx_request_logs_cost_status",
  "idx_daily_usage_day",
  "idx_daily_account_usage_day",
  "idx_daily_account_usage_account",
  "idx_quota_snapshots_provider",
  "idx_cost_audit_request_log_id",
] as const;

type TableInfoRow = {
  readonly name: string;
};

type SqliteMasterRow = {
  readonly name: string;
};

export interface BackupResult {
  readonly sourcePath: string;
  readonly outputPath: string;
  readonly sizeBytes: number;
}

class SchemaAssertionError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(`schema assertion failed: missing ${missing.join(", ")}`);
    this.name = "SchemaAssertionError";
    this.missing = missing;
  }
}

export namespace Storage {
  function splitStatements(sql: string): string[] {
    const stripped = sql.replace(/^\s*--.*$/gm, "");
    return stripped
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
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

  export function initDb(dbPath: string): Database {
    ensureDbParentDir(dbPath);
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

    try {
      for (const file of files) {
        const applied = db
          .prepare("SELECT name FROM schema_migrations WHERE name = ?")
          .get(file);
        if (applied) continue;

        const sql = readFileSync(join(migrationsDir, file), "utf-8");

        const txn = db.transaction(() => {
          for (const stmt of splitStatements(sql)) {
            db.exec(stmt);
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

      assertCoreSchema(db);
      return db;
    } catch (err) {
      db.close();
      throw err;
    }
  }

  export function recoverStalePending(
    db: Database,
    maxAgeMs: number = DEFAULT_STALE_PENDING_MAX_AGE_MS,
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
        AND source = 'proxy'
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

  export function backupBeforeStart(dbPath: string): void {
    const { existsSync, copyFileSync, statSync, unlinkSync, readdirSync } = require("node:fs");
    const { dirname, join, basename } = require("node:path");
    if (!existsSync(dbPath)) return;

    const stat = statSync(dbPath);
    if (stat.size < 4096) return;

    const dir = dirname(dbPath);
    const base = basename(dbPath, ".db");
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const backupName = `${base}.backup-${ts}.db`;
    const backupPath = join(dir, backupName);

    try {
      copyFileSync(dbPath, backupPath);
      logger.info("database backup created", { event: "db.backup", path: backupPath, size: stat.size });
    } catch (err) {
      logger.warn("database backup failed", { event: "db.backup_failed", err });
    }

    try {
      const MAX_BACKUPS = 5;
      const backups = readdirSync(dir)
        .filter((f: string) => f.startsWith(`${base}.backup-`) && f.endsWith(".db"))
        .sort()
        .reverse();
      for (const old of backups.slice(MAX_BACKUPS)) {
        unlinkSync(join(dir, old));
        logger.info("old backup removed", { event: "db.backup_pruned", file: old });
      }
    } catch {}
  }

  export function backupDb(dbPath: string, outputPath: string): BackupResult {
    if (dbPath === ":memory:") throw new Error("cannot back up in-memory database");
    if (!existsSync(dbPath)) throw new Error(`database does not exist: ${dbPath}`);

    const resolvedDbPath = resolve(dbPath);
    const resolvedOutputPath = resolve(outputPath);
    if (resolvedDbPath === resolvedOutputPath) throw new Error("backup output must differ from DB_PATH");
    if (existsSync(resolvedOutputPath)) throw new Error(`backup output already exists: ${resolvedOutputPath}`);

    ensureDbParentDir(resolvedOutputPath);
    const db = initDb(resolvedDbPath);
    try {
      db.query<never, [string]>("VACUUM INTO ?").run(resolvedOutputPath);
    } finally {
      db.close();
    }

    const sizeBytes = statSync(resolvedOutputPath).size;
    logger.info("database backup created", {
      event: "db.backup",
      path: resolvedOutputPath,
      source_path: resolvedDbPath,
      size: sizeBytes,
    });
    return { sourcePath: resolvedDbPath, outputPath: resolvedOutputPath, sizeBytes };
  }
}

function assertCoreSchema(db: Database): void {
  const missing: string[] = [];

  for (const [table, requiredColumns] of Object.entries(REQUIRED_COLUMNS)) {
    const columns = new Set(db
      .query<TableInfoRow, []>(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name));
    for (const column of requiredColumns) {
      if (!columns.has(column)) missing.push(`${table}.${column}`);
    }
  }

  const indexes = new Set(db
    .query<SqliteMasterRow, []>("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all()
    .map((row) => row.name));
  for (const index of REQUIRED_INDEXES) {
    if (!indexes.has(index)) missing.push(`index.${index}`);
  }

  if (missing.length > 0) throw new SchemaAssertionError(missing);
}

function ensureDbParentDir(dbPath: string): void {
  if (dbPath === ":memory:") return;
  const dir = dirname(dbPath);
  if (!dir || dir === "." || existsSync(dir)) return;
  mkdirSync(dir, { recursive: true });
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
