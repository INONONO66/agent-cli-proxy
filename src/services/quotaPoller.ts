import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { Database } from "bun:sqlite";

const CRED_DIR = join(homedir(), ".cli-proxy-api");
const POLL_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes

function insertSnapshot(
  db: Database,
  provider: string,
  account: string,
  quotaType: string,
  usedPct: number | null,
  remaining: number | null,
  remainingRaw: string | null,
  resetsAt: string | null,
  rawJson: string
): void {
  db.prepare(`
    INSERT INTO quota_snapshots (timestamp, provider, account, quota_type, used_pct, remaining, remaining_raw, resets_at, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    new Date().toISOString(),
    provider, account, quotaType,
    usedPct, remaining, remainingRaw, resetsAt, rawJson
  );
}

// ─── Anthropic ───────────────────────────────────────────────────────────────

async function pollAnthropic(db: Database): Promise<void> {
  let files: string[];
  try {
    files = readdirSync(CRED_DIR).filter(f => f.startsWith("claude-") && f.endsWith(".json"));
  } catch { return; }

  for (const file of files) {
    try {
      const cred = JSON.parse(readFileSync(join(CRED_DIR, file), "utf-8"));
      const token = cred.access_token;
      const email = cred.email ?? file;

      const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
        headers: {
          "Authorization": `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
          "User-Agent": "claude-code/2.1.97",
        },
      });

      if (!res.ok) {
        console.warn(`[quota:anthropic] ${email}: HTTP ${res.status}`);
        continue;
      }

      const data = await res.json() as Record<string, unknown>;
      const raw = JSON.stringify(data);

      // five_hour
      const fiveHour = data.five_hour as Record<string, unknown> | null;
      if (fiveHour) {
        insertSnapshot(db, "anthropic", email, "five_hour",
          typeof fiveHour.utilization === "number" ? fiveHour.utilization : null,
          typeof fiveHour.utilization === "number" ? Math.max(0, 100 - fiveHour.utilization) : null,
          null,
          typeof fiveHour.resets_at === "string" ? fiveHour.resets_at : null,
          raw
        );
      }

      // seven_day
      const sevenDay = data.seven_day as Record<string, unknown> | null;
      if (sevenDay) {
        insertSnapshot(db, "anthropic", email, "seven_day",
          typeof sevenDay.utilization === "number" ? sevenDay.utilization : null,
          typeof sevenDay.utilization === "number" ? Math.max(0, 100 - sevenDay.utilization) : null,
          null,
          typeof sevenDay.resets_at === "string" ? sevenDay.resets_at : null,
          raw
        );
      }

      // seven_day_sonnet
      const sevenDaySonnet = data.seven_day_sonnet as Record<string, unknown> | null;
      if (sevenDaySonnet && sevenDaySonnet.utilization != null) {
        insertSnapshot(db, "anthropic", email, "seven_day_sonnet",
          typeof sevenDaySonnet.utilization === "number" ? sevenDaySonnet.utilization : null,
          typeof sevenDaySonnet.utilization === "number" ? Math.max(0, 100 - sevenDaySonnet.utilization) : null,
          null,
          typeof sevenDaySonnet.resets_at === "string" ? sevenDaySonnet.resets_at : null,
          raw
        );
      }

      console.log(`[quota:anthropic] ${email}: polled OK`);
    } catch (err) {
      console.warn(`[quota:anthropic] ${file}: error`, err);
    }
  }
}

// ─── Codex/GPT ───────────────────────────────────────────────────────────────

async function pollCodex(db: Database): Promise<void> {
  let files: string[];
  try {
    files = readdirSync(CRED_DIR).filter(f => f.startsWith("codex-") && f.endsWith(".json"));
  } catch { return; }

  for (const file of files) {
    try {
      const cred = JSON.parse(readFileSync(join(CRED_DIR, file), "utf-8"));
      if (cred.disabled) continue;
      const token = cred.access_token;
      const accountId = cred.account_id ?? "";
      const email = cred.email ?? file;

      const headers: Record<string, string> = {
        "Authorization": `Bearer ${token}`,
        "User-Agent": "codex-cli",
        "Accept": "application/json",
      };
      if (accountId) headers["ChatGPT-Account-Id"] = accountId;

      const res = await fetch("https://chatgpt.com/backend-api/wham/usage", { headers });

      if (!res.ok) {
        console.warn(`[quota:codex] ${email}: HTTP ${res.status}`);
        continue;
      }

      const data = await res.json() as Record<string, unknown>;
      const raw = JSON.stringify(data);
      const rateLimit = data.rate_limit as Record<string, unknown> | null;

      if (rateLimit) {
        const primary = rateLimit.primary_window as Record<string, unknown> | null;
        const secondary = rateLimit.secondary_window as Record<string, unknown> | null;

        if (primary) {
          const usedPct = typeof primary.used_percent === "number" ? primary.used_percent : null;
          const resetAt = typeof primary.reset_at === "number"
            ? new Date(primary.reset_at * 1000).toISOString()
            : null;
          insertSnapshot(db, "codex", email, "five_hour",
            usedPct,
            usedPct != null ? Math.max(0, 100 - usedPct) : null,
            null, resetAt, raw
          );
        }

        if (secondary) {
          const usedPct = typeof secondary.used_percent === "number" ? secondary.used_percent : null;
          const resetAt = typeof secondary.reset_at === "number"
            ? new Date(secondary.reset_at * 1000).toISOString()
            : null;
          insertSnapshot(db, "codex", email, "seven_day",
            usedPct,
            usedPct != null ? Math.max(0, 100 - usedPct) : null,
            null, resetAt, raw
          );
        }
      }

      // credits
      const credits = data.credits as Record<string, unknown> | null;
      if (credits) {
        const balance = credits.balance;
        insertSnapshot(db, "codex", email, "credits",
          null, typeof balance === "number" ? balance : null,
          balance != null ? String(balance) : null,
          null, raw
        );
      }

      console.log(`[quota:codex] ${email}: polled OK`);
    } catch (err) {
      console.warn(`[quota:codex] ${file}: error`, err);
    }
  }
}

// ─── GLM ─────────────────────────────────────────────────────────────────────

async function pollGlm(db: Database, apiKey: string): Promise<void> {
  if (!apiKey) return;

  try {
    const res = await fetch("https://open.bigmodel.cn/api/monitor/usage/quota/limit", {
      headers: { "Authorization": `Bearer ${apiKey}` },
    });

    if (!res.ok) {
      console.warn(`[quota:glm] HTTP ${res.status}`);
      return;
    }

    const data = await res.json() as Record<string, unknown>;
    const raw = JSON.stringify(data);
    const limits = (data.data as Record<string, unknown>)?.limits as Array<Record<string, unknown>> ?? [];

    for (const limit of limits) {
      const type = String(limit.type ?? "UNKNOWN").toLowerCase();
      const pct = typeof limit.percentage === "number" ? limit.percentage : null;
      const remaining = typeof limit.remaining === "number" ? limit.remaining : null;
      const nextReset = typeof limit.nextResetTime === "number"
        ? new Date(limit.nextResetTime).toISOString()
        : null;

      insertSnapshot(db, "glm", "api-key", type,
        pct, remaining, remaining != null ? String(remaining) : null,
        nextReset, raw
      );
    }

    console.log(`[quota:glm] polled OK`);
  } catch (err) {
    console.warn(`[quota:glm] error`, err);
  }
}

// ─── Kimi ─────────────────────────────────────────────────────────────────────

async function pollKimi(db: Database): Promise<void> {
  let files: string[];
  try {
    files = readdirSync(CRED_DIR).filter(f => f.startsWith("kimi-") && f.endsWith(".json"));
  } catch { return; }

  for (const file of files) {
    try {
      const cred = JSON.parse(readFileSync(join(CRED_DIR, file), "utf-8"));
      const token = cred.access_token;
      const account = cred.email ?? file;

      const res = await fetch("https://api.kimi.com/coding/v1/usages", {
        headers: { "Authorization": `Bearer ${token}` },
      });

      if (!res.ok) {
        console.warn(`[quota:kimi] ${account}: HTTP ${res.status}`);
        continue;
      }

      const data = await res.json() as Record<string, unknown>;
      const raw = JSON.stringify(data);

      // Weekly usage
      const usage = data.usage as Record<string, unknown> | null;
      if (usage) {
        const limit = Number(usage.limit ?? 0);
        const remaining = Number(usage.remaining ?? 0);
        const usedPct = limit > 0 ? Math.round((1 - remaining / limit) * 100) : 0;
        const resetsAt = typeof usage.resetTime === "string" ? usage.resetTime : null;

        insertSnapshot(db, "kimi", account, "weekly",
          usedPct, remaining, String(remaining), resetsAt, raw
        );
      }

      // 5-hour window (limits[0])
      const limits = data.limits as Array<Record<string, unknown>> | null;
      if (limits && limits.length > 0) {
        const win = limits[0];
        const detail = win.detail as Record<string, unknown> | null;
        if (detail) {
          const limit = Number(detail.limit ?? 0);
          const remaining = Number(detail.remaining ?? 0);
          const usedPct = limit > 0 ? Math.round((1 - remaining / limit) * 100) : 0;
          const resetsAt = typeof detail.resetTime === "string" ? detail.resetTime : null;

          insertSnapshot(db, "kimi", account, "five_hour",
            usedPct, remaining, String(remaining), resetsAt, raw
          );
        }
      }

      console.log(`[quota:kimi] ${account}: polled OK`);
    } catch (err) {
      console.warn(`[quota:kimi] ${file}: error`, err);
    }
  }
}


// ─── Subscription info ───────────────────────────────────────────────────────

export interface SubscriptionInfo {
  provider: string;
  account: string;
  plan: string;
  price: number;
  currency: string;
  billingDay: string;
  tax?: number;
  note?: string;
}

export function loadSubscriptions(): SubscriptionInfo[] {
  const subs: SubscriptionInfo[] = [];
  for (const [key, val] of Object.entries(process.env)) {
    if (!key.startsWith("SUB_") || !val) continue;
    const parts = key.replace("SUB_", "").split("_");
    const provider = parts[0].toLowerCase();
    const account = parts.slice(1).join("_") || provider;
    
    const fields: Record<string, string> = {};
    for (const pair of val.split(",")) {
      const [k, ...rest] = pair.split(":");
      fields[k] = rest.join(":");
    }
    
    subs.push({
      provider,
      account,
      plan: fields.plan ?? "unknown",
      price: parseFloat(fields.price ?? "0"),
      currency: fields.currency ?? "USD",
      billingDay: fields.billing_day ?? "unknown",
      tax: fields.tax ? parseFloat(fields.tax) : undefined,
      note: fields.note,
    });
  }
  return subs;
}

// ─── Main poller ─────────────────────────────────────────────────────────────

export function startQuotaPoller(db: Database, glmApiKey: string): void {
  async function poll(): Promise<void> {
    await Promise.allSettled([
      pollAnthropic(db),
      pollCodex(db),
      pollGlm(db, glmApiKey),
      pollKimi(db),
    ]);
  }

  // Poll immediately on start, then every 3 minutes
  poll().catch(err => console.warn("[quota] initial poll error:", err));
  setInterval(() => {
    poll().catch(err => console.warn("[quota] poll error:", err));
  }, POLL_INTERVAL_MS);

  console.log("[quota] poller started (interval: 3 min)");
}
