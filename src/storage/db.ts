import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

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
        (statement.toUpperCase().includes("ADD COLUMN") &&
          msg.includes("syntax error"));
      if (!ignorable) throw err;
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
        console.error(`[migration] ${file} failed:`, err);
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

    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_request_logs_cliproxy_account ON request_logs(cliproxy_account)",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_request_logs_cliproxy_auth_index ON request_logs(cliproxy_auth_index)",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_request_logs_request_id ON request_logs(request_id)",
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
}
