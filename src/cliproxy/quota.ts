import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { Config } from "../config";
import { UpstreamClient } from "../upstream/client";
import { Usage } from "../usage";
import { Logger } from "../util/logger";

const logger = Logger.fromConfig().child({ component: "quota" });

type AuthFile = {
  type?: string;
  email?: string;
  access_token?: string;
  account_id?: string;
  disabled?: boolean;
};

type ProbeWindow = {
  quota_type: string;
  used_pct?: number;
  resets_at?: string;
  raw: unknown;
};

type ProbeResult = {
  provider: string;
  account: string;
  status: string;
  unavailable: boolean;
  disabled: boolean;
  plan?: string;
  error?: string;
  windows: ProbeWindow[];
};

function normalizePercent(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const pct = value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, pct));
}

function normalizeReset(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return undefined;
}

function quotaTypeFromSeconds(seconds: unknown, fallback: string): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return fallback;
  const hours = Math.round(seconds / 3600);
  if (hours >= 24 * 6) return "week";
  if (hours >= 24) return `${Math.round(hours / 24)}d`;
  return `${hours}h`;
}

async function fetchJson(
  url: string,
  init: RequestInit,
): Promise<{ ok: boolean; status: number; data: unknown; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Config.quotaRefreshTimeoutMs);
  try {
    const res = await UpstreamClient.fetch({
      method: init.method ?? "GET",
      url,
      headers: init.headers,
      body: init.body ?? null,
      providerId: `quota:${new URL(url).hostname}`,
      idempotent: (init.method ?? "GET") === "GET" || (init.method ?? "GET") === "HEAD",
      signal: controller.signal,
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return { ok: res.ok, status: res.status, data, text };
  } finally {
    clearTimeout(timer);
  }
}

function errorMessage(data: unknown, fallback: string): string {
  if (data && typeof data === "object" && "error" in data) {
    const err = (data as { error?: unknown }).error;
    if (err && typeof err === "object" && "message" in err) {
      const message = (err as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) return message;
    }
    if (typeof err === "string" && err.trim()) return err;
  }
  return fallback;
}

async function probeClaude(auth: AuthFile): Promise<ProbeResult> {
  const account = auth.email ?? "claude";
  if (!auth.access_token) {
    return {
      provider: "claude",
      account,
      status: "error",
      unavailable: true,
      disabled: auth.disabled === true,
      error: "missing access_token",
      windows: [],
    };
  }

  const res = await fetchJson("https://api.anthropic.com/api/oauth/usage", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${auth.access_token}`,
      Accept: "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "agent-cli-proxy",
    },
  });

  if (!res.ok) {
    return {
      provider: "claude",
      account,
      status: "error",
      unavailable: true,
      disabled: auth.disabled === true,
      error: errorMessage(res.data, `HTTP ${res.status}`),
      windows: [],
    };
  }

  const data = res.data as {
    five_hour?: { utilization?: number; resets_at?: string | number } | null;
    seven_day?: { utilization?: number; resets_at?: string | number } | null;
    seven_day_sonnet?: { utilization?: number; resets_at?: string | number } | null;
    seven_day_opus?: { utilization?: number; resets_at?: string | number } | null;
  };
  const windows: ProbeWindow[] = [];
  for (const [quotaType, window] of [
    ["5h", data.five_hour],
    ["week", data.seven_day],
    ["week_sonnet", data.seven_day_sonnet],
    ["week_opus", data.seven_day_opus],
  ] as const) {
    if (!window) continue;
    const used = normalizePercent(window.utilization);
    if (used === undefined && !window.resets_at) continue;
    windows.push({
      quota_type: quotaType,
      used_pct: used,
      resets_at: normalizeReset(window.resets_at),
      raw: window,
    });
  }

  return {
    provider: "claude",
    account,
    status: "active",
    unavailable: false,
    disabled: auth.disabled === true,
    windows,
  };
}

async function probeCodex(auth: AuthFile): Promise<ProbeResult> {
  const account = auth.email ?? "codex";
  if (!auth.access_token) {
    return {
      provider: "codex",
      account,
      status: "error",
      unavailable: true,
      disabled: auth.disabled === true,
      error: "missing access_token",
      windows: [],
    };
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.access_token}`,
    Accept: "application/json",
    "User-Agent": "codex_cli_rs/0.101.0 (Linux; x86_64) agent-cli-proxy",
  };
  if (auth.account_id) headers["ChatGPT-Account-Id"] = auth.account_id;

  const res = await fetchJson("https://chatgpt.com/backend-api/wham/usage", {
    method: "GET",
    headers,
  });

  if (!res.ok) {
    const data = res.data as {
      error?: { type?: string; message?: string; plan_type?: string; resets_at?: number };
    } | null;
    const resetsAt = normalizeReset(data?.error?.resets_at);
    const usedWindow: ProbeWindow[] = resetsAt
      ? [
          {
            quota_type: "exhausted",
            used_pct: 100,
            resets_at: resetsAt,
            raw: data,
          },
        ]
      : [];
    return {
      provider: "codex",
      account,
      status: data?.error?.type ?? "error",
      unavailable: true,
      disabled: auth.disabled === true,
      plan: data?.error?.plan_type,
      error: data?.error?.message ?? `HTTP ${res.status}`,
      windows: usedWindow,
    };
  }

  const data = res.data as {
    plan_type?: string;
    credits?: { balance?: number | string | null };
    rate_limit?: {
      limit_reached?: boolean;
      primary_window?: {
        used_percent?: number;
        reset_at?: number | string;
        reset_after_seconds?: number;
        limit_window_seconds?: number;
      };
      secondary_window?: {
        used_percent?: number;
        reset_at?: number | string;
        reset_after_seconds?: number;
        limit_window_seconds?: number;
      };
    };
  };

  const windows: ProbeWindow[] = [];
  for (const [fallback, window] of [
    ["5h", data.rate_limit?.primary_window],
    ["week", data.rate_limit?.secondary_window],
  ] as const) {
    if (!window) continue;
    const used = normalizePercent(window.used_percent);
    const reset = normalizeReset(window.reset_at);
    if (used === undefined && !reset) continue;
    windows.push({
      quota_type: quotaTypeFromSeconds(window.limit_window_seconds, fallback),
      used_pct: used,
      resets_at: reset,
      raw: window,
    });
  }

  let plan = data.plan_type;
  if (data.credits?.balance !== undefined && data.credits.balance !== null) {
    plan = plan ? `${plan}` : undefined;
  }

  return {
    provider: "codex",
    account,
    status: data.rate_limit?.limit_reached ? "limit_reached" : "active",
    unavailable: data.rate_limit?.limit_reached === true,
    disabled: auth.disabled === true,
    plan,
    windows,
  };
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function kimiWindow(
  quotaType: string,
  detail: { limit?: unknown; used?: unknown; remaining?: unknown; resetTime?: unknown } | undefined,
  raw: unknown,
): ProbeWindow | null {
  if (!detail) return null;
  const limit = readNumber(detail.limit);
  const remaining = readNumber(detail.remaining);
  const used = readNumber(detail.used) ??
    (limit !== undefined && remaining !== undefined ? limit - remaining : undefined);
  const usedPct = limit && used !== undefined ? (used / limit) * 100 : undefined;
  const reset = normalizeReset(detail.resetTime);
  if (usedPct === undefined && remaining === undefined && !reset) return null;
  return {
    quota_type: quotaType,
    used_pct: normalizePercent(usedPct),
    resets_at: reset,
    raw,
  };
}

async function probeKimi(auth: AuthFile): Promise<ProbeResult> {
  const account = "kimi";
  if (!auth.access_token) {
    return {
      provider: "kimi",
      account,
      status: "error",
      unavailable: true,
      disabled: auth.disabled === true,
      error: "missing access_token",
      windows: [],
    };
  }

  const headers = {
    Authorization: `Bearer ${auth.access_token}`,
    Accept: "application/json",
    "User-Agent": "KimiCLI/1.35 agent-cli-proxy",
  };
  let res = await fetchJson("https://api.kimi.com/coding/v1/usages", {
    method: "GET",
    headers,
  });
  if (!res.ok) {
    res = await fetchJson("https://api.moonshot.ai/v1/usages", {
      method: "GET",
      headers,
    });
  }

  if (!res.ok) {
    return {
      provider: "kimi",
      account,
      status: "error",
      unavailable: true,
      disabled: auth.disabled === true,
      error: errorMessage(res.data, `HTTP ${res.status}`),
      windows: [],
    };
  }

  const data = res.data as {
    usage?: { limit?: unknown; used?: unknown; remaining?: unknown; resetTime?: unknown };
    limits?: Array<{
      window?: { duration?: number; timeUnit?: string };
      detail?: { limit?: unknown; used?: unknown; remaining?: unknown; resetTime?: unknown };
    }>;
    usages?: Array<{
      scope?: string;
      detail?: { limit?: unknown; used?: unknown; remaining?: unknown; resetTime?: unknown };
      limits?: Array<{
        window?: { duration?: number; timeUnit?: string };
        detail?: { limit?: unknown; used?: unknown; remaining?: unknown; resetTime?: unknown };
      }>;
    }>;
  };
  const coding = data.usages?.find((u) => u.scope === "FEATURE_CODING") ?? data.usages?.[0];
  const windows: ProbeWindow[] = [];
  const weekly = kimiWindow("week", coding?.detail ?? data.usage, coding?.detail ?? data.usage);
  if (weekly) windows.push(weekly);
  for (const limit of coding?.limits ?? data.limits ?? []) {
    const duration = limit.window?.duration;
    const quotaType = duration === 300 ? "5h" : quotaTypeFromSeconds((duration ?? 0) * 60, "window");
    const window = kimiWindow(quotaType, limit.detail, limit);
    if (window) windows.push(window);
  }

  return {
    provider: "kimi",
    account,
    status: "active",
    unavailable: false,
    disabled: auth.disabled === true,
    windows,
  };
}

function unsupported(auth: AuthFile): ProbeResult {
  const provider = auth.type ?? "unknown";
  return {
    provider,
    account: auth.email ?? provider,
    status: "unsupported",
    unavailable: false,
    disabled: auth.disabled === true,
    error: "quota endpoint is not known for this provider",
    windows: [],
  };
}

async function readAuthFiles(): Promise<AuthFile[]> {
  if (!Config.cliproxyAuthDir) return [];
  const names = await readdir(Config.cliproxyAuthDir);
  const out: AuthFile[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(Config.cliproxyAuthDir, name), "utf-8");
      const parsed = JSON.parse(raw) as AuthFile;
      out.push(parsed);
    } catch (err) {
      logger.warn("failed to read auth file", { err, name });
    }
  }
  return out;
}

export namespace QuotaProbe {
  export async function refresh(): Promise<Usage.QuotaRefreshResult> {
    const timestamp = new Date().toISOString();
    const auths = await readAuthFiles();
    const accounts: Usage.AccountQuotaReport[] = [];

    for (const auth of auths) {
      let result: ProbeResult;
      try {
        if (auth.type === "claude") result = await probeClaude(auth);
        else if (auth.type === "codex") result = await probeCodex(auth);
        else if (auth.type === "kimi") result = await probeKimi(auth);
        else result = unsupported(auth);
      } catch (err) {
        result = {
          provider: auth.type ?? "unknown",
          account: auth.email ?? auth.type ?? "unknown",
          status: "error",
          unavailable: true,
          disabled: auth.disabled === true,
          error: err instanceof Error ? err.message : String(err),
          windows: [],
        };
      }

      const windows: Usage.QuotaSnapshot[] = result.windows.map((window) => ({
        timestamp,
        provider: result.provider,
        account: result.account,
        quota_type: window.quota_type,
        used_pct: window.used_pct ?? null,
        remaining:
          window.used_pct === undefined ? null : Math.max(0, 100 - window.used_pct),
        remaining_raw:
          window.used_pct === undefined ? null : `${Math.max(0, 100 - window.used_pct).toFixed(2)}%`,
        resets_at: window.resets_at ?? null,
        raw_json: JSON.stringify(window.raw),
      }));

      accounts.push({
        provider: result.provider,
        account: result.account,
        status: result.status,
        unavailable: result.unavailable,
        disabled: result.disabled,
        plan: result.plan,
        refreshed_at: timestamp,
        error: result.error,
        windows,
        local_usage: {
          five_hour: { since: "", requests: 0, total_tokens: 0, cost_usd: 0 },
          seven_day: { since: "", requests: 0, total_tokens: 0, cost_usd: 0 },
        },
      });
    }

    return { timestamp, accounts, inserted: 0 };
  }
}
