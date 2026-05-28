import type { AuthFile, ProbeFn, ProbeWindow } from "../types";
import { fetchJson, normalizePercent, normalizeReset } from "../helpers";

type GlmLimit = {
  type?: string;
  unit?: number;
  number?: number;
  usage?: number;
  currentValue?: number;
  remaining?: number;
  percentage?: number;
  nextResetTime?: number;
  usageDetails?: Array<{ modelCode?: string; usage?: number }>;
};

type GlmResponse = {
  code?: number;
  success?: boolean;
  msg?: string;
  data?: {
    limits?: GlmLimit[];
    level?: string;
  };
};

// GLM unit values map to time granularity:
//   1 = minute, 2 = hour, 3 = day, 4 = week, 5 = month, 6 = year
function glmQuotaType(limit: GlmLimit): string {
  const label = limit.type === "TIME_LIMIT" ? "req" : "tok";
  const n = limit.number ?? 1;
  switch (limit.unit) {
    case 1: return `${label}_${n}min`;
    case 2: return `${label}_${n}h`;
    case 3: return `${label}_${n}d`;
    case 4: return `${label}_${n}w`;
    case 5: return `${label}_${n}mo`;
    case 6: return `${label}_${n}y`;
    default: return `${label}_unknown`;
  }
}

export const probeGlm: ProbeFn = async (auth) => {
  const account = auth.email ?? "glm";
  if (!auth.access_token) {
    return {
      provider: "glm",
      account,
      status: "error",
      unavailable: true,
      disabled: auth.disabled === true,
      error: "missing access_token",
      windows: [],
    };
  }

  const res = await fetchJson("https://api.z.ai/api/monitor/usage/quota/limit", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${auth.access_token}`,
      Accept: "application/json",
      "User-Agent": "agent-cli-proxy",
    },
  });

  if (!res.ok) {
    return {
      provider: "glm",
      account,
      status: "error",
      unavailable: true,
      disabled: auth.disabled === true,
      error: `HTTP ${res.status}`,
      windows: [],
    };
  }

  const body = res.data as GlmResponse;
  if (!body?.success || !body.data?.limits) {
    return {
      provider: "glm",
      account,
      status: "error",
      unavailable: true,
      disabled: auth.disabled === true,
      error: body?.msg ?? "unexpected response shape",
      windows: [],
    };
  }

  const windows: ProbeWindow[] = [];
  for (const limit of body.data.limits) {
    const pct = normalizePercent(limit.percentage);
    const reset = normalizeReset(limit.nextResetTime);
    if (pct === undefined && !reset) continue;
    windows.push({
      quota_type: glmQuotaType(limit),
      used_pct: pct,
      resets_at: reset,
      raw: limit,
    });
  }

  return {
    provider: "glm",
    account,
    status: "active",
    unavailable: false,
    disabled: auth.disabled === true,
    plan: body.data.level,
    windows,
  };
};
