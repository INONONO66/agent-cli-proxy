import type { AuthFile, ProbeFn, ProbeWindow } from "../types";
import { fetchJson, normalizePercent } from "../helpers";

// xAI has no per-request usage-% endpoint like Claude/Codex.
// Instead we combine the Management API's prepaid balance and spending limit
// to derive a "credit usage" percentage:
//   used_pct = (spending_limit - balance) / spending_limit * 100
//
// Auth file shape:
//   { "type": "xai", "email": "...", "access_token": "<management_api_key>", "team_id": "<team_id>" }
//
// The access_token must be a Management API key (not an inference key).
// Obtain it from https://console.x.ai/team/default/management-keys

const MGMT_BASE = "https://management-api.x.ai/v1/billing/teams";

type UsdCents = { val?: string };

type BalanceResponse = {
  total?: UsdCents;
};

type SpendingLimitsResponse = {
  spendingLimits?: {
    effectiveSl?: UsdCents;
    effectiveHardSl?: UsdCents;
    softSl?: UsdCents;
  };
};

type InvoicePreviewResponse = {
  coreInvoice?: {
    amountAfterVat?: string;
    prepaidCredits?: UsdCents;
    prepaidCreditsUsed?: UsdCents;
  };
  effectiveSpendingLimit?: string;
  billingCycle?: { year?: number; month?: number };
};

function centsToUsd(val: string | undefined): number | undefined {
  if (val === undefined) return undefined;
  const n = Number(val);
  return Number.isFinite(n) ? n / 100 : undefined;
}

export const probeXai: ProbeFn = async (auth) => {
  const account = auth.email ?? "xai";
  const teamId = (auth as { team_id?: string }).team_id;

  if (!auth.access_token) {
    return {
      provider: "xai",
      account,
      status: "error",
      unavailable: true,
      disabled: auth.disabled === true,
      error: "missing access_token (management API key)",
      windows: [],
    };
  }
  if (!teamId) {
    return {
      provider: "xai",
      account,
      status: "error",
      unavailable: true,
      disabled: auth.disabled === true,
      error: "missing team_id in auth file",
      windows: [],
    };
  }

  const headers = {
    Authorization: `Bearer ${auth.access_token}`,
    Accept: "application/json",
    "User-Agent": "agent-cli-proxy",
  };

  // fetch balance + spending limits + invoice preview in parallel
  const [balanceRes, limitsRes, previewRes] = await Promise.all([
    fetchJson(`${MGMT_BASE}/${teamId}/prepaid/balance`, { method: "GET", headers }),
    fetchJson(`${MGMT_BASE}/${teamId}/postpaid/spending-limits`, { method: "GET", headers }),
    fetchJson(`${MGMT_BASE}/${teamId}/postpaid/invoice/preview`, { method: "GET", headers }),
  ]);

  if (!balanceRes.ok && !previewRes.ok) {
    return {
      provider: "xai",
      account,
      status: "error",
      unavailable: true,
      disabled: auth.disabled === true,
      error: `management API error: balance HTTP ${balanceRes.status}, preview HTTP ${previewRes.status}`,
      windows: [],
    };
  }

  const windows: ProbeWindow[] = [];

  // prepaid credit balance
  const balance = balanceRes.data as BalanceResponse | null;
  const balanceCents = balance?.total?.val;
  const balanceUsd = centsToUsd(balanceCents);
  if (balanceUsd !== undefined) {
    windows.push({
      quota_type: "prepaid_balance",
      // negative val = credits remaining (xAI uses negative for available balance)
      used_pct: undefined,
      raw: balance,
    });
  }

  // spending limit utilization from invoice preview
  const preview = previewRes.data as InvoicePreviewResponse | null;
  const limitCents = preview?.effectiveSpendingLimit;
  const usedCents = preview?.coreInvoice?.amountAfterVat;
  const limitUsd = centsToUsd(limitCents);
  const usedUsd = centsToUsd(usedCents);

  if (limitUsd !== undefined && limitUsd > 0 && usedUsd !== undefined) {
    const pct = (usedUsd / limitUsd) * 100;
    windows.push({
      quota_type: "monthly_spend",
      used_pct: normalizePercent(pct),
      raw: { spending_limit_usd: limitUsd, used_usd: usedUsd, billing_cycle: preview?.billingCycle },
    });
  }

  // spending limits metadata
  const limits = limitsRes.data as SpendingLimitsResponse | null;
  const softLimitUsd = centsToUsd(limits?.spendingLimits?.softSl?.val);
  const hardLimitUsd = centsToUsd(limits?.spendingLimits?.effectiveHardSl?.val);

  // tier info from limit thresholds
  let plan: string | undefined;
  if (hardLimitUsd !== undefined) {
    plan = `limit_$${hardLimitUsd.toFixed(0)}`;
  }

  return {
    provider: "xai",
    account,
    status: "active",
    unavailable: false,
    disabled: auth.disabled === true,
    plan,
    windows,
  };
};
