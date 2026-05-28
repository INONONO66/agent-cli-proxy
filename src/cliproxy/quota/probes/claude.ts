import type { AuthFile, ProbeFn, ProbeWindow } from "../types";
import { errorMessage, fetchJson, normalizePercent, normalizeReset } from "../helpers";

export const probeClaude: ProbeFn = async (auth) => {
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
};
