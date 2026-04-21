import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { join } from "path";

export function initDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");

  const migrationsDir = join(import.meta.dir, "migrations");
  const migrations = ["001_init.sql", "002_agent_attribution.sql"];

  for (const migration of migrations) {
    const sql = readFileSync(join(migrationsDir, migration), "utf-8");
    // Run each statement separately to handle ALTER TABLE gracefully
    for (const stmt of sql.split(";").map(s => s.trim()).filter(Boolean)) {
      try {
        db.exec(stmt);
      } catch (err: unknown) {
        // Ignore "duplicate column" errors from ALTER TABLE on re-run
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("duplicate column") && !msg.includes("already exists")) {
          throw err;
        }
      }
    }
  }

  return db;
}
