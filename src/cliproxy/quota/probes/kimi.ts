import type { AuthFile, ProbeFn, ProbeWindow } from "../types";
import { errorMessage, fetchJson, normalizePercent, normalizeReset } from "../helpers";

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

function quotaTypeFromDuration(duration: number | undefined): string {
  if (duration === 300) return "5h";
  if (typeof duration !== "number" || !Number.isFinite(duration)) return "window";
  const seconds = duration * 60;
  const hours = Math.round(seconds / 3600);
  if (hours >= 24 * 6) return "week";
  if (hours >= 24) return `${Math.round(hours / 24)}d`;
  return `${hours}h`;
}

export const probeKimi: ProbeFn = async (auth) => {
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
    const quotaType = quotaTypeFromDuration(limit.window?.duration);
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
};
