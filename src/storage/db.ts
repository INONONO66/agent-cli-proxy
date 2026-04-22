import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { join } from "path";

export namespace Storage {
  export function initDb(dbPath: string): Database {
    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    const migrationPath = join(import.meta.dir, "migrations/001_init.sql");
    const migration = readFileSync(migrationPath, "utf-8");
    db.exec(migration);
    return db;
  }
}
