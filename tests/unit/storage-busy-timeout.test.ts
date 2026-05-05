import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../src/storage/db";

function removeDbFiles(dbPath: string): void {
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(path)) unlinkSync(path);
  }
}

async function waitForLocked(stream: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!stream) throw new Error("locker stdout unavailable");

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";

  try {
    while (!output.includes("locked\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`locker exited before write lock: ${output}`);
      output += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

test("initDb configures busy timeout and retries transient busy writes", async () => {
  const dbPath = join(tmpdir(), `agent-cli-proxy-busy-${crypto.randomUUID()}.db`);
  const setupDb = Storage.initDb(dbPath);
  setupDb.query("CREATE TABLE busy_items (name TEXT NOT NULL)").run();

  const pragma = setupDb.query("PRAGMA busy_timeout").get() as { timeout: number };
  expect(pragma.timeout).toBe(5_000);
  setupDb.close();

  const lockerCode = `
    import { Database } from "bun:sqlite";
    const db = new Database(${JSON.stringify(dbPath)});
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT INTO busy_items (name) VALUES (?)").run("locker");
    process.stdout.write("locked\\n");
    await Bun.sleep(150);
    db.exec("COMMIT");
    db.close();
  `;
  const locker = Bun.spawn([process.execPath, "--eval", lockerCode], {
    stdout: "pipe",
    stderr: "pipe",
  });
  let retryDb: Database | null = null;

  try {
    await waitForLocked(locker.stdout);

    retryDb = Storage.initDb(dbPath);
    const db = retryDb;
    db.query("PRAGMA busy_timeout = 1").run();

    Storage.runWriteWithRetry(db, () => {
      db.prepare("INSERT INTO busy_items (name) VALUES (?)").run("retried");
    });

    const exitCode = await locker.exited;
    const stderr = await new Response(locker.stderr).text();
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);

    const rows = db.query("SELECT name FROM busy_items ORDER BY name ASC").all() as Array<{ name: string }>;
    expect(rows.map((row) => row.name)).toEqual(["locker", "retried"]);
  } finally {
    retryDb?.close();
    locker.kill();
    removeDbFiles(dbPath);
  }
});
