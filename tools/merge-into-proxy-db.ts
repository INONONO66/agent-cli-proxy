#!/usr/bin/env bun
/**
 * Merge a tokscale-import SQLite (created by tools/migrate-tokscale.ts) into
 * the live proxy.db. Uses ATTACH + INSERT … SELECT for transactional safety.
 * Idempotent: msg_id unique index in proxy.db prevents double-import.
 *
 *   bun run tools/merge-into-proxy-db.ts \
 *     --target ./data/proxy.db \
 *     --source ./data/migration-tokscale.db
 */
import { Database } from "bun:sqlite";
import { parseArgs } from "node:util";
import { existsSync } from "node:fs";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    target: { type: "string", default: "./data/proxy.db" },
    source: { type: "string", default: "./data/migration-tokscale.db" },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
  allowPositionals: false,
});

if (values.help) {
  console.log("Usage: bun run tools/merge-into-proxy-db.ts --target proxy.db --source migration-tokscale.db");
  process.exit(0);
}

if (!existsSync(values.target!)) {
  console.error(`[merge] target not found: ${values.target}`);
  process.exit(1);
}
if (!existsSync(values.source!)) {
  console.error(`[merge] source not found: ${values.source}`);
  process.exit(1);
}

const db = new Database(values.target!);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");

console.log(`[merge] target=${values.target}  source=${values.source}`);

const beforeTarget = db
  .query<{ n: number; cost: number }, []>("SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd),0) AS cost FROM request_logs")
  .get();
console.log(`[merge] BEFORE target: ${beforeTarget?.n.toLocaleString()} rows, $${beforeTarget?.cost.toFixed(2)}`);

db.exec(`ATTACH DATABASE '${values.source!.replace(/'/g, "''")}' AS src`);

const srcCount = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM src.request_logs").get();
console.log(`[merge] source has ${srcCount?.n.toLocaleString()} rows`);

console.log("[merge] Inserting (INSERT OR IGNORE — msg_id unique index handles dedupe) ...");
const t0 = Date.now();
db.exec("BEGIN");
try {
  db.exec(`
    INSERT OR IGNORE INTO main.request_logs (
      provider, model, actual_model, tool, client_id, path, streamed, status,
      prompt_tokens, completion_tokens, cache_creation_tokens, cache_read_tokens, total_tokens,
      cost_usd, incomplete, error_code, latency_ms, started_at, finished_at,
      meta_json, source_ip, user_agent,
      agent, source, msg_id
    )
    SELECT
      provider, model, actual_model, tool, client_id, path, streamed, status,
      prompt_tokens, completion_tokens, cache_creation_tokens, cache_read_tokens, total_tokens,
      cost_usd, incomplete, error_code, latency_ms, started_at, finished_at,
      meta_json, source_ip, user_agent,
      agent, source, msg_id
    FROM src.request_logs
    WHERE source = 'tokscale'
  `);

  const after = db
    .query<{ n: number; cost: number }, []>("SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd),0) AS cost FROM request_logs")
    .get();
  const inserted = (after?.n ?? 0) - (beforeTarget?.n ?? 0);
  console.log(
    `[merge] inserted=${inserted.toLocaleString()} (${(srcCount?.n ?? 0) - inserted} skipped by dedupe) in ${Date.now() - t0} ms`,
  );

  console.log("[merge] Rebuilding daily_usage from request_logs ...");
  db.exec("DELETE FROM daily_usage");
  db.exec(`
    INSERT INTO daily_usage (
      day, provider, model, request_count,
      prompt_tokens, completion_tokens, cache_creation_tokens, cache_read_tokens,
      total_tokens, cost_usd
    )
    SELECT substr(started_at, 1, 10) AS day, provider, model,
           COUNT(*),
           COALESCE(SUM(prompt_tokens), 0),
           COALESCE(SUM(completion_tokens), 0),
           COALESCE(SUM(cache_creation_tokens), 0),
           COALESCE(SUM(cache_read_tokens), 0),
           COALESCE(SUM(total_tokens), 0),
           COALESCE(SUM(cost_usd), 0)
      FROM request_logs
     GROUP BY day, provider, model
  `);
  const dailyN = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM daily_usage").get();
  console.log(`[merge] daily_usage rebuilt: ${dailyN?.n.toLocaleString()} rows`);

  db.exec("COMMIT");
} catch (err) {
  db.exec("ROLLBACK");
  console.error("[merge] FAILED — rolled back:", err);
  process.exit(1);
}

const afterTarget = db
  .query<{ n: number; cost: number }, []>("SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd),0) AS cost FROM request_logs")
  .get();
console.log(`[merge] AFTER  target: ${afterTarget?.n.toLocaleString()} rows, $${afterTarget?.cost.toFixed(2)}`);

const bySource = db
  .query<{ src: string; n: number; cost: number }, []>(
    `SELECT COALESCE(source,'(null)') AS src, COUNT(*) AS n, COALESCE(SUM(cost_usd),0) AS cost
       FROM request_logs GROUP BY src ORDER BY n DESC`,
  )
  .all();
console.log("[merge] By source:");
console.table(
  bySource.map((r) => ({ source: r.src, rows: r.n.toLocaleString(), cost: `$${r.cost.toFixed(2)}` })),
);

db.close();
console.log("[merge] Done.");
