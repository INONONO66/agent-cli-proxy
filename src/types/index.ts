export interface RequestLog {
  id?: number;
  provider: string;
  model: string;
  path: string;
  streamed: number;
  status?: number;
  prompt_tokens: number;
  completion_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
  cost_usd: number;
  incomplete: number;
  error_code?: string;
  latency_ms?: number;
  started_at: string;
  finished_at?: string;
  meta_json?: string;
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

export interface TotalStats {
  total_requests: number;
  total_tokens: number;
  total_cost_usd: number;
  first_request_at: string | null;
  last_request_at: string | null;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
  incomplete: boolean;
}
