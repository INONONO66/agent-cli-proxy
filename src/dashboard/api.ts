import type { Usage } from "../usage";

export interface SessionCheck {
  authenticated: boolean;
}

export interface LoginBody {
  password: string;
}

export interface LoginResponse {
  ok: boolean;
  error?: string;
}

export interface LogListResponse {
  logs: Usage.RequestLog[];
  total: number;
}

export interface QuotaListResponse {
  snapshots: Usage.QuotaSnapshot[];
}

export interface QuotaRefreshResponse extends Usage.QuotaRefreshResult {}

export interface AccountListResponse {
  accounts: AuthAccount[];
}

export interface AuthAccount {
  provider: string;
  email?: string;
  expires_at?: string;
  expired?: number;
  is_expired?: boolean;
  refreshed_at?: string;
  [key: string]: unknown;
}

export interface OAuthStartResponse {
  job_id: string;
  provider: string;
  status: string;
}

export interface OAuthJobEvent {
  type: "started" | "url" | "done" | "error" | "cancelled";
  provider?: string;
  url?: string;
  callbackPort?: number;
  sshTunnel?: string;
  success?: boolean;
  message?: string;
}

export interface BreakerListResponse {
  breakers: BreakerSnapshot[];
}

export interface BreakerSnapshot {
  providerId: string;
  state: "closed" | "open" | "half-open";
  failures: number;
  lastFailureAt?: string;
}

export interface CostSummaryResponse {
  month: string;
  rows: CostSummaryRow[];
  totals: {
    accounts: number;
    total_requests: number;
    total_cost_usd: number;
    total_monthly_price_usd: number;
    total_overage_usd: number;
  };
}

export interface CostSummaryRow {
  cliproxy_account: string;
  subscription_code: string | null;
  monthly_price_usd: number;
  total_requests: number;
  total_cost_usd: number;
  computed_overage_usd: number;
}

const BASE = "";

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(options?.method && options.method !== "GET"
      ? { "x-csrf": "1" }
      : {}),
  };
  const res = await fetch(`${BASE}${path}`, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...headers,
      ...(options?.headers as Record<string, string> | undefined),
    },
  });
  if (res.status === 403) {
    window.location.hash = "#/login";
    throw new Error("unauthorized");
  }
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export function getSession(): Promise<SessionCheck> {
  return api<SessionCheck>("/admin/session");
}

export function login(password: string): Promise<LoginResponse> {
  return api<LoginResponse>("/admin/session/login", {
    method: "POST",
    body: JSON.stringify({ password }),
  });
}

export function logout(): Promise<LoginResponse> {
  return api<LoginResponse>("/admin/session/logout", {
    method: "POST",
  });
}

export function getTodayUsage(): Promise<Usage.DailyUsageSummary> {
  return api<Usage.DailyUsageSummary>("/admin/usage/today");
}

export function getUsageRange(
  from: string,
  to: string,
): Promise<Usage.DailyUsageSummary[]> {
  return api<Usage.DailyUsageSummary[]>(
    `/admin/usage/range?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  );
}

export function getModelBreakdown(day: string): Promise<Usage.DailyUsage[]> {
  return api<Usage.DailyUsage[]>(
    `/admin/usage/models?day=${encodeURIComponent(day)}`,
  );
}

export function getProviderBreakdown(
  day: string,
): Promise<Usage.ProviderSummary[]> {
  return api<Usage.ProviderSummary[]>(
    `/admin/usage/providers?day=${encodeURIComponent(day)}`,
  );
}

export function getAccountSummary(
  from?: string,
  to?: string,
): Promise<Usage.AccountSummary[]> {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const qs = params.toString();
  return api<Usage.AccountSummary[]>(
    `/admin/usage/accounts/summary${qs ? `?${qs}` : ""}`,
  );
}

export function getStats(): Promise<Usage.TotalStats> {
  return api<Usage.TotalStats>("/admin/stats");
}

export function getLogs(
  limit: number,
  offset: number,
  tool?: string,
  clientId?: string,
): Promise<Usage.RequestLog[]> {
  const params = new URLSearchParams();
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  if (tool) params.set("tool", tool);
  if (clientId) params.set("client_id", clientId);
  return api<Usage.RequestLog[]>(`/admin/logs?${params.toString()}`);
}

export function getLogById(id: number): Promise<Usage.RequestLog | null> {
  return api<Usage.RequestLog>(`/admin/logs/${id}`);
}

export function getQuotas(refresh?: boolean): Promise<QuotaListResponse> {
  const qs = refresh ? "?refresh=true" : "";
  return api<QuotaListResponse>(`/admin/quotas${qs}`);
}

export function getCostSummary(month: string): Promise<CostSummaryResponse> {
  return api<CostSummaryResponse>(
    `/admin/plans/cost-summary?month=${encodeURIComponent(month)}`,
  );
}

export function getBreakers(): Promise<BreakerListResponse> {
  return api<BreakerListResponse>("/admin/breakers");
}

export function getOAuthAccounts(): Promise<AccountListResponse> {
  return api<AccountListResponse>("/admin/oauth/accounts");
}

export function startOAuthLogin(
  provider: string,
): Promise<OAuthStartResponse> {
  return api<OAuthStartResponse>(`/admin/oauth/${encodeURIComponent(provider)}/start`, {
    method: "POST",
  });
}

export function cancelOAuthJob(jobId: string): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/admin/oauth/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
  });
}
