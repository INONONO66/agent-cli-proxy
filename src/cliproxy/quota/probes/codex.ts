import type { AuthFile, ProbeFn, ProbeWindow } from "../types";
import { errorMessage, fetchJson, normalizePercent, normalizeReset, quotaTypeFromSeconds } from "../helpers";

export const probeCodex: ProbeFn = async (auth) => {
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
};
