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
