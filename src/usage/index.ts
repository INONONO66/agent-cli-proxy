export type TokenUsage = Usage.TokenUsage;

export namespace Usage {
  export interface TokenUsage {
    prompt_tokens: number;
    completion_tokens: number;
    cache_creation_tokens: number;
    cache_read_tokens: number;
    reasoning_tokens?: number;
    total_tokens: number;
    incomplete: boolean;
  }

  export interface RequestLog {
    id?: number;
    request_id?: string;
    provider: string;
    model: string;
    actual_model?: string;
    tool: string;
    client_id: string;
    path: string;
    streamed: number;
    status?: number;
    prompt_tokens: number;
    completion_tokens: number;
    cache_creation_tokens: number;
    cache_read_tokens: number;
    reasoning_tokens?: number;
    total_tokens: number;
    cost_usd: number;
    incomplete: number;
    error_code?: string;
    latency_ms?: number;
    started_at: string;
    finished_at?: string;
    meta_json?: string;
    cliproxy_account?: string;
    cliproxy_auth_index?: string;
    cliproxy_source?: string;
    correlated_at?: string;
    user_agent?: string;
    source_ip?: string;
  }

  export interface DailyUsage {
    day: string;
    provider: string;
    model: string;
    request_count: number;
    prompt_tokens: number;
    completion_tokens: number;
    cache_creation_tokens: number;
    cache_read_tokens: number;
    total_tokens: number;
    cost_usd: number;
  }

  export interface DailyAccountUsage {
    day: string;
    provider: string;
    model: string;
    cliproxy_account: string;
    cliproxy_auth_index?: string;
    request_count: number;
    prompt_tokens: number;
    completion_tokens: number;
    cache_creation_tokens: number;
    cache_read_tokens: number;
    reasoning_tokens: number;
    total_tokens: number;
    cost_usd: number;
  }

  export interface DailyUsageSummary {
    date: string;
    requests: number;
    total_tokens: number;
    cost_usd: number;
    breakdown: DailyUsage[];
  }

  export interface ProviderSummary {
    provider: string;
    request_count: number;
    total_tokens: number;
    cost_usd: number;
  }

  export interface AccountSummary {
    cliproxy_account: string;
    cliproxy_auth_index?: string;
    provider: string;
    request_count: number;
    total_tokens: number;
    cost_usd: number;
  }

  export interface TotalStats {
    total_requests: number;
    total_tokens: number;
    total_cost_usd: number;
    first_request_at: string | null;
    last_request_at: string | null;
  }

  export interface QuotaSnapshot {
    id?: number;
    timestamp: string;
    provider: string;
    account: string;
    quota_type: string;
    used_pct?: number | null;
    remaining?: number | null;
    remaining_raw?: string | null;
    resets_at?: string | null;
    raw_json?: string | null;
  }

  export interface AccountQuotaReport {
    provider: string;
    account: string;
    auth_index?: string;
    status: string;
    unavailable: boolean;
    disabled: boolean;
    plan?: string;
    refreshed_at?: string;
    error?: string;
    windows: QuotaSnapshot[];
    local_usage: {
      five_hour: AccountUsageWindow;
      seven_day: AccountUsageWindow;
    };
  }

  export interface AccountUsageWindow {
    since: string;
    requests: number;
    total_tokens: number;
    cost_usd: number;
  }

  export interface QuotaRefreshResult {
    timestamp: string;
    accounts: AccountQuotaReport[];
    inserted: number;
  }
}
