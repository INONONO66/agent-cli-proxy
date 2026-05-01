#!/usr/bin/env bun
/**
 * tokscale → proxy.db migrator. Reads local AI coding tool usage via
 * @tokscale/core and writes one row per message into a fresh SQLite that
 * mirrors the agent-cli-proxy schema. Output DB is intended to be merged into
 * the live proxy.db on inonono via INSERT … SELECT.
 *
 *   bun run tools/migrate-tokscale.ts \
 *     --output ./data/migration-output.db \
 *     [--sources opencode,claude,codex] \
 *     [--since 2024-01-01] [--until 2026-04-22] \
 *     [--limit 1000] [--verify] [--overwrite]
 */
import { Database } from "bun:sqlite";
import { mkdirSync, existsSync, unlinkSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import {
  parseLocalSources,
  lookupPricing,
  type ParsedMessage,
  type NativePricing,
  type PricingLookupResult,
} from "@tokscale/core";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    output: { type: "string", default: "./data/migration-output.db" },
    sources: { type: "string", default: "opencode,claude,codex" },
    since: { type: "string" },
    until: { type: "string" },
    limit: { type: "string" },
    verify: { type: "boolean", default: false },
    overwrite: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
  allowPositionals: false,
});

if (values.help) {
  console.log(readFileSync(import.meta.path, "utf-8").split("\n").slice(2, 14).join("\n"));
  process.exit(0);
}

const OUTPUT_PATH = values.output!;
const SOURCES = values.sources!.split(",").map((s) => s.trim()).filter(Boolean);
const LIMIT = values.limit ? Number.parseInt(values.limit, 10) : undefined;

mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
if (existsSync(OUTPUT_PATH)) {
  if (!values.overwrite) {
    console.error(`[migrate] ${OUTPUT_PATH} already exists. Pass --overwrite to replace it.`);
    process.exit(1);
  }
  unlinkSync(OUTPUT_PATH);
}

const db = new Database(OUTPUT_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");

const PROJECT_ROOT = join(import.meta.dir, "..");
for (const file of [
  "001_init.sql",
  "002_agent_attribution.sql",
  "003_enhanced_logging.sql",
]) {
  const sql = readFileSync(join(PROJECT_ROOT, "src/storage/migrations", file), "utf-8");
  // bun:sqlite chokes on `ADD COLUMN IF NOT EXISTS` on some builds; table is fresh, the guard isn't needed.
  const cleaned = sql.replace(/ADD COLUMN IF NOT EXISTS/g, "ADD COLUMN");
  db.exec(cleaned);
}

type PricingEntry = NativePricing & { matchedKey: string; source: string };
const pricingCache = new Map<string, PricingEntry | null>();

// models.dev fallback for models that LiteLLM/lookupPricing() doesn't know about. Costs are $/token.
const MODELS_DEV_FALLBACK: Record<string, NativePricing & { _key: string }> = {
  "antigravity-gemini-3-flash": {
    _key: "google/gemini-3-flash (close match via models.dev)",
    inputCostPerToken: 0.0000005,
    outputCostPerToken: 0.000003,
    cacheReadInputTokenCost: 0.00000005,
  },
  "gemini-3-flash-preview": {
    _key: "google/gemini-3-flash-preview (models.dev)",
    inputCostPerToken: 0.0000005,
    outputCostPerToken: 0.000003,
    cacheReadInputTokenCost: 0.00000005,
  },
  "gemini-3-pro-preview": {
    _key: "google/gemini-3-pro-preview (models.dev)",
    inputCostPerToken: 0.000002,
    outputCostPerToken: 0.000012,
    cacheReadInputTokenCost: 0.0000002,
  },
  "gemini-3.1-pro-preview": {
    _key: "google/gemini-3.1-pro-preview (models.dev)",
    inputCostPerToken: 0.000002,
    outputCostPerToken: 0.000012,
    cacheReadInputTokenCost: 0.0000002,
  },
  "antigravity-gemini-3-pro": {
    _key: "google/gemini-3-pro-preview (close via models.dev)",
    inputCostPerToken: 0.000002,
    outputCostPerToken: 0.000012,
    cacheReadInputTokenCost: 0.0000002,
  },
  "antigravity-gemini-3-pro-high": {
    _key: "google/gemini-3-pro-preview (close via models.dev)",
    inputCostPerToken: 0.000002,
    outputCostPerToken: 0.000012,
    cacheReadInputTokenCost: 0.0000002,
  },
  "claude-opus-4-5": {
    _key: "anthropic/claude-opus-4-5 (models.dev)",
    inputCostPerToken: 0.000005,
    outputCostPerToken: 0.000025,
    cacheReadInputTokenCost: 0.0000005,
    cacheCreationInputTokenCost: 0.00000625,
  },
  "claude-opus-4-6": {
    _key: "anthropic/claude-opus-4-6 (models.dev)",
    inputCostPerToken: 0.000005,
    outputCostPerToken: 0.000025,
    cacheReadInputTokenCost: 0.0000005,
    cacheCreationInputTokenCost: 0.00000625,
  },
  "claude-opus-4-7": {
    _key: "anthropic/claude-opus-4-7 (models.dev)",
    inputCostPerToken: 0.000005,
    outputCostPerToken: 0.000025,
    cacheReadInputTokenCost: 0.0000005,
    cacheCreationInputTokenCost: 0.00000625,
  },
  "claude-sonnet-4-5": {
    _key: "anthropic/claude-sonnet-4-5 (models.dev)",
    inputCostPerToken: 0.000003,
    outputCostPerToken: 0.000015,
    cacheReadInputTokenCost: 0.0000003,
    cacheCreationInputTokenCost: 0.00000375,
  },
  "claude-sonnet-4-6": {
    _key: "anthropic/claude-sonnet-4-6 (models.dev)",
    inputCostPerToken: 0.000003,
    outputCostPerToken: 0.000015,
    cacheReadInputTokenCost: 0.0000003,
    cacheCreationInputTokenCost: 0.00000375,
  },
  "claude-haiku-4-5": {
    _key: "anthropic/claude-haiku-4-5 (models.dev)",
    inputCostPerToken: 0.000001,
    outputCostPerToken: 0.000005,
    cacheReadInputTokenCost: 0.0000001,
    cacheCreationInputTokenCost: 0.00000125,
  },
  "gpt-5.2": {
    _key: "openai/gpt-5.2 (models.dev)",
    inputCostPerToken: 0.00000175,
    outputCostPerToken: 0.000014,
    cacheReadInputTokenCost: 0.000000175,
  },
  "gpt-5.2-codex": {
    _key: "openai/gpt-5.2-codex (models.dev)",
    inputCostPerToken: 0.00000175,
    outputCostPerToken: 0.000014,
    cacheReadInputTokenCost: 0.000000175,
  },
  "gpt-5.3-codex": {
    _key: "openai/gpt-5.3-codex (models.dev)",
    inputCostPerToken: 0.00000175,
    outputCostPerToken: 0.000014,
    cacheReadInputTokenCost: 0.000000175,
  },
  "gpt-5.4": {
    _key: "openai/gpt-5.4 (models.dev)",
    inputCostPerToken: 0.0000025,
    outputCostPerToken: 0.000015,
    cacheReadInputTokenCost: 0.00000025,
  },
  "gpt-5.5": {
    _key: "openai/gpt-5.5 (models.dev)",
    inputCostPerToken: 0.000005,
    outputCostPerToken: 0.00003,
    cacheReadInputTokenCost: 0.0000005,
  },
};

// Normalize Anthropic dated suffixes (claude-haiku-4-5-20251001 → claude-haiku-4-5) so dashboard
// aggregates by canonical model. The original ID is preserved in actual_model.
function normalizeModelId(modelId: string): string {
  const datedAnthropic = modelId.match(/^(claude-[a-z]+-[0-9]+(?:-[0-9]+)*)-20\d{6}$/);
  if (datedAnthropic) return datedAnthropic[1];
  return modelId;
}

async function getPricing(modelId: string, providerId: string): Promise<PricingEntry | null> {
  const key = `${providerId}::${modelId}`;
  if (pricingCache.has(key)) return pricingCache.get(key)!;
  try {
    const result: PricingLookupResult = await lookupPricing(modelId, providerId);
    const entry: PricingEntry = {
      ...result.pricing,
      matchedKey: result.matchedKey,
      source: result.source,
    };
    if (entry.inputCostPerToken === 0 && entry.outputCostPerToken === 0) {
      const fallback = MODELS_DEV_FALLBACK[modelId] ?? MODELS_DEV_FALLBACK[normalizeModelId(modelId)];
      if (fallback) {
        const filled: PricingEntry = {
          inputCostPerToken: fallback.inputCostPerToken,
          outputCostPerToken: fallback.outputCostPerToken,
          cacheReadInputTokenCost: fallback.cacheReadInputTokenCost,
          cacheCreationInputTokenCost: fallback.cacheCreationInputTokenCost,
          matchedKey: fallback._key,
          source: "models.dev-fallback",
        };
        pricingCache.set(key, filled);
        return filled;
      }
    }
    pricingCache.set(key, entry);
    return entry;
  } catch {
    const fallback = MODELS_DEV_FALLBACK[modelId] ?? MODELS_DEV_FALLBACK[normalizeModelId(modelId)];
    if (fallback) {
      const filled: PricingEntry = {
        inputCostPerToken: fallback.inputCostPerToken,
        outputCostPerToken: fallback.outputCostPerToken,
        cacheReadInputTokenCost: fallback.cacheReadInputTokenCost,
        cacheCreationInputTokenCost: fallback.cacheCreationInputTokenCost,
        matchedKey: fallback._key,
        source: "models.dev-fallback",
      };
      pricingCache.set(key, filled);
      return filled;
    }
    pricingCache.set(key, null);
    return null;
  }
}

function computeCost(msg: ParsedMessage, p: PricingEntry | null): number {
  if (!p) return 0;
  return (
    msg.input * p.inputCostPerToken +
    msg.output * p.outputCostPerToken +
    msg.cacheRead * (p.cacheReadInputTokenCost ?? 0) +
    msg.cacheWrite * (p.cacheCreationInputTokenCost ?? 0)
  );
}

console.log(`[migrate] Parsing local sources: ${SOURCES.join(", ")} ...`);
const t0 = Date.now();
const parsed = parseLocalSources({
  homeDir: homedir(),
  sources: SOURCES,
  since: values.since,
  until: values.until,
});
const parseMs = Date.now() - t0;
console.log(
  `[migrate] parseLocalSources(): ${parsed.messages.length.toLocaleString()} messages in ${parseMs} ms ` +
    `(opencode=${parsed.opencodeCount} claude=${parsed.claudeCount} codex=${parsed.codexCount} ` +
    `gemini=${parsed.geminiCount} amp=${parsed.ampCount} droid=${parsed.droidCount} ` +
    `openclaw=${parsed.openclawCount} pi=${parsed.piCount} kimi=${parsed.kimiCount})`,
);

parsed.messages.sort((a, b) => a.timestamp - b.timestamp);

const messages = LIMIT ? parsed.messages.slice(0, LIMIT) : parsed.messages;
if (LIMIT) console.log(`[migrate] --limit applied: processing ${messages.length} messages`);

const pricingKeys = new Set<string>();
for (const m of messages) pricingKeys.add(`${m.providerId}::${m.modelId}`);
console.log(`[migrate] Looking up pricing for ${pricingKeys.size} distinct (provider, model) pairs ...`);
await Promise.all(
  [...pricingKeys].map((key) => {
    const [providerId, modelId] = key.split("::");
    return getPricing(modelId, providerId);
  }),
);
const pricingMissCount = [...pricingCache.values()].filter((v) => v === null).length;
console.log(
  `[migrate] Pricing: ${pricingCache.size - pricingMissCount} matched, ${pricingMissCount} missing (cost=0 for those)`,
);

const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO request_logs (
    provider, model, actual_model, tool, client_id, path, streamed, status,
    prompt_tokens, completion_tokens, cache_creation_tokens, cache_read_tokens, total_tokens,
    cost_usd, incomplete, error_code, latency_ms, started_at, finished_at,
    meta_json, source_ip, user_agent,
    agent, source, msg_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertMany = db.transaction((rows: ParsedMessage[]) => {
  let inserted = 0;
  let skippedByDedupe = 0;
  for (const msg of rows) {
    const pricing = pricingCache.get(`${msg.providerId}::${msg.modelId}`) ?? null;
    const cost = computeCost(msg, pricing);
    const total = msg.input + msg.output + msg.cacheRead + msg.cacheWrite + msg.reasoning;
    const startedAtIso = new Date(msg.timestamp).toISOString();
    const meta = JSON.stringify({
      session_id: msg.sessionId,
      reasoning_tokens: msg.reasoning,
      agent: msg.agent ?? null,
      pricing_matched_key: pricing?.matchedKey ?? null,
      pricing_source: pricing?.source ?? null,
      imported_from: "@tokscale/core@1.4.3",
      imported_at: new Date().toISOString(),
    });
    // msg_id must be globally unique so the existing idx_request_logs_msg_id makes re-runs idempotent.
    const msgId = `tokscale:${msg.source}:${msg.sessionId}:${msg.timestamp}:${msg.modelId}`;
    // Synthesized fields: path/user_agent/source — proxy didn't see real HTTP for imported data.
    const normalizedModel = normalizeModelId(msg.modelId);
    const result = insertStmt.run(
      msg.providerId,
      normalizedModel,
      msg.modelId,
      msg.source,
      `${msg.source}:${msg.sessionId}`,
      "/v1/messages",
      0,
      null,
      msg.input,
      msg.output,
      msg.cacheWrite,
      msg.cacheRead,
      total,
      cost,
      0,
      null,
      null,
      startedAtIso,
      null,
      meta,
      null,
      "tokscale-import",
      msg.agent ?? null,
      "tokscale",
      msgId,
    );
    if (result.changes === 0) skippedByDedupe++;
    else inserted++;
  }
  return { inserted, skippedByDedupe };
});

console.log(`[migrate] Inserting ${messages.length.toLocaleString()} rows into request_logs ...`);
const tInsert = Date.now();
const { inserted, skippedByDedupe } = insertMany(messages);
console.log(
  `[migrate] inserted=${inserted.toLocaleString()} dedupe_skipped=${skippedByDedupe.toLocaleString()} in ${Date.now() - tInsert} ms`,
);

console.log("[migrate] Building daily_usage aggregates ...");
db.exec(`
  INSERT OR REPLACE INTO daily_usage (
    day, provider, model, request_count,
    prompt_tokens, completion_tokens, cache_creation_tokens, cache_read_tokens,
    total_tokens, cost_usd
  )
  SELECT substr(started_at, 1, 10) AS day, provider, model,
         COUNT(*), SUM(prompt_tokens), SUM(completion_tokens),
         SUM(cache_creation_tokens), SUM(cache_read_tokens),
         SUM(total_tokens), SUM(cost_usd)
    FROM request_logs WHERE source = 'tokscale'
   GROUP BY day, provider, model
`);
const dailyRows = db.query("SELECT COUNT(*) AS c FROM daily_usage").get() as { c: number };
console.log(`[migrate] daily_usage rows: ${dailyRows.c}`);

const totals = db
  .query<
    {
      tool: string;
      n: number;
      input: number;
      output: number;
      cache_read: number;
      cache_write: number;
      total: number;
      cost: number;
    },
    []
  >(
    `SELECT tool,
            COUNT(*) AS n,
            SUM(prompt_tokens) AS input,
            SUM(completion_tokens) AS output,
            SUM(cache_read_tokens) AS cache_read,
            SUM(cache_creation_tokens) AS cache_write,
            SUM(total_tokens) AS total,
            SUM(cost_usd) AS cost
       FROM request_logs WHERE source = 'tokscale'
      GROUP BY tool ORDER BY cost DESC`,
  )
  .all();

console.log("\n[migrate] Per-tool totals (this DB):");
console.table(
  totals.map((r) => ({
    tool: r.tool,
    rows: r.n.toLocaleString(),
    input: r.input.toLocaleString(),
    output: r.output.toLocaleString(),
    cache_read: r.cache_read.toLocaleString(),
    cache_write: r.cache_write.toLocaleString(),
    total: r.total.toLocaleString(),
    cost_usd: `$${r.cost.toFixed(2)}`,
  })),
);
const grand = db
  .query<{ rows: number; cost: number; total: number }, []>(
    "SELECT COUNT(*) AS rows, SUM(cost_usd) AS cost, SUM(total_tokens) AS total FROM request_logs WHERE source='tokscale'",
  )
  .get();
console.log(
  `[migrate] GRAND TOTAL: ${grand?.rows.toLocaleString()} rows, ${grand?.total.toLocaleString()} tokens, $${grand?.cost.toFixed(2)}`,
);

if (values.verify) {
  console.log("\n[verify] Running `bunx tokscale --json --group-by client,model` for cross-check ...");
  const args = ["tokscale@latest", "--json", "--group-by", "client,model", "--no-spinner"];
  if (values.since) args.push("--since", values.since);
  if (values.until) args.push("--until", values.until);
  const proc = Bun.spawn(["bunx", ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  let externalEntries: Array<{
    client: string;
    model: string;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    messageCount: number;
    cost: number;
  }> = [];
  try {
    externalEntries = JSON.parse(out).entries ?? [];
  } catch (err) {
    console.error("[verify] Failed to parse tokscale --json output:", err);
  }

  const ourByKey = new Map<
    string,
    { input: number; output: number; cacheRead: number; cacheWrite: number; messages: number; cost: number }
  >();
  for (const r of db
    .query<
      { tool: string; model: string; input: number; output: number; cr: number; cw: number; n: number; cost: number },
      []
    >(
      `SELECT tool, model,
              SUM(prompt_tokens) AS input,
              SUM(completion_tokens) AS output,
              SUM(cache_read_tokens) AS cr,
              SUM(cache_creation_tokens) AS cw,
              COUNT(*) AS n,
              SUM(cost_usd) AS cost
         FROM request_logs WHERE source='tokscale'
         GROUP BY tool, model`,
    )
    .all()) {
    ourByKey.set(`${r.tool}::${r.model}`, {
      input: r.input,
      output: r.output,
      cacheRead: r.cr,
      cacheWrite: r.cw,
      messages: r.n,
      cost: r.cost,
    });
  }

  let ok = 0;
  let mismatched = 0;
  const issues: string[] = [];
  for (const e of externalEntries) {
    const key = `${e.client}::${e.model}`;
    const ours = ourByKey.get(key);
    if (!ours) {
      issues.push(`MISSING in our DB: ${key}`);
      mismatched++;
      continue;
    }
    const tolN = Math.max(1, Math.round(e.messageCount * 0.001));
    const tolCost = Math.max(0.01, Math.abs(e.cost) * 0.01);
    const diffs: string[] = [];
    if (Math.abs(ours.messages - e.messageCount) > tolN)
      diffs.push(`messages: ours=${ours.messages} their=${e.messageCount}`);
    if (ours.input !== e.input) diffs.push(`input: ours=${ours.input} their=${e.input}`);
    if (ours.output !== e.output) diffs.push(`output: ours=${ours.output} their=${e.output}`);
    if (ours.cacheRead !== e.cacheRead) diffs.push(`cacheRead: ours=${ours.cacheRead} their=${e.cacheRead}`);
    if (ours.cacheWrite !== e.cacheWrite) diffs.push(`cacheWrite: ours=${ours.cacheWrite} their=${e.cacheWrite}`);
    if (Math.abs(ours.cost - e.cost) > tolCost)
      diffs.push(`cost: ours=$${ours.cost.toFixed(2)} their=$${e.cost.toFixed(2)}`);
    if (diffs.length === 0) ok++;
    else {
      mismatched++;
      issues.push(`${key} → ${diffs.join("; ")}`);
    }
    ourByKey.delete(key);
  }
  for (const extraKey of ourByKey.keys()) issues.push(`EXTRA in our DB (not in tokscale --json): ${extraKey}`);
  console.log(`[verify] matched=${ok} mismatched=${mismatched} extra_in_ours=${ourByKey.size}`);
  if (issues.length) {
    console.log("[verify] issues:");
    for (const i of issues.slice(0, 30)) console.log("  - " + i);
    if (issues.length > 30) console.log(`  ... and ${issues.length - 30} more`);
  }
  if (mismatched === 0 && ourByKey.size === 0) {
    console.log("[verify] ✅ All (client, model) groups match within tolerance.");
  } else {
    console.log("[verify] ⚠️  See issues above.");
  }
}

db.close();
console.log(`\n[migrate] Done. Output: ${OUTPUT_PATH}`);
