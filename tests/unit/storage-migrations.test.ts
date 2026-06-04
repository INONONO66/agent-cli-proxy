import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../src/storage/db";

function removeDbFiles(dbPath: string): void {
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(path)) unlinkSync(path);
  }
}

test("initDb rejects a migration marked applied when required schema is missing", () => {
  const dbPath = join(tmpdir(), `agent-cli-proxy-migration-assert-${crypto.randomUUID()}.db`);
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO schema_migrations (name) VALUES ('001_init.sql');
    INSERT INTO schema_migrations (name) VALUES ('002_quota_local_usage_index.sql');
    CREATE TABLE request_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT
    );
  `);
  db.close();

  try {
    expect(() => Storage.initDb(dbPath)).toThrow("schema assertion failed");
  } finally {
    removeDbFiles(dbPath);
  }
});

test("initDb creates an index for quota local usage window scans", () => {
  const dbPath = join(tmpdir(), `agent-cli-proxy-quota-index-${crypto.randomUUID()}.db`);
  const db = Storage.initDb(dbPath);

  try {
    const index = db
      .query<{ name: string }, []>(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND name = 'idx_request_logs_provider_cliproxy_account_started_at'
      `)
      .get();
    expect(index?.name).toBe("idx_request_logs_provider_cliproxy_account_started_at");

    const plan = db
      .query<{ detail: string }, []>(`
        EXPLAIN QUERY PLAN
        SELECT COUNT(*) AS requests
        FROM request_logs
        WHERE provider = 'claude'
          AND cliproxy_account = 'acct@example.com'
          AND started_at >= '2026-06-01T00:00:00.000Z'
      `)
      .all()
      .map((row) => row.detail)
      .join("\n");
    expect(plan).toContain("idx_request_logs_provider_cliproxy_account_started_at");
  } finally {
    db.close();
    removeDbFiles(dbPath);
  }
});
