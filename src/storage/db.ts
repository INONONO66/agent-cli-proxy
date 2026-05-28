import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "fs";
import { dirname, join } from "path";
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

function parseStalePendingMaxAgeMs(raw: string | undefined): number {
  if (raw === undefined) return 600_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 600_000;
  return parsed;
}
