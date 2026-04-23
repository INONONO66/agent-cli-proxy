export interface DailyUsageSummary {
  date: string;
  requests: number;
  total_tokens: number;
  cost_usd: number;
  breakdown: DailyUsage[];
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

export interface RequestLog {
  id?: number;
  provider: string;
  model: string;
  tool: string;
  client_id: string;
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
}

export interface TotalStats {
  total_requests: number;
  total_tokens: number;
  total_cost_usd: number;
  first_request_at: string | null;
  last_request_at: string | null;
}

export interface PrometheusResult {
  metric: Record<string, string>;
  value?: [number, string];
  values?: Array<[number, string]>;
}

export interface PrometheusResponse {
  status: string;
  data: {
    resultType: string;
    result: PrometheusResult[];
  };
}

export interface LokiStream {
  stream: Record<string, string>;
  values: Array<[string, string]>;
}

export interface LokiResponse {
  status: string;
  data: {
    resultType: string;
    result: LokiStream[];
  };
}

export interface HealthResponse {
  services: Record<string, "up" | "down">;
}

export interface AuthCheckResponse {
  authenticated: boolean;
  username?: string;
}

export interface LoginResponse {
  ok: boolean;
  error?: string;
}

const BASE = "/api/dashboard";

async function get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const url = new URL(BASE + path, window.location.origin);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url.toString(), { credentials: "same-origin" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  auth: {
    async login(username: string, password: string): Promise<LoginResponse> {
      try {
        return await post<LoginResponse>("/auth/login", { username, password });
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Login failed" };
      }
    },

    async logout(): Promise<void> {
      await post<void>("/auth/logout", {});
    },

    async check(): Promise<AuthCheckResponse> {
      try {
        return await get<AuthCheckResponse>("/auth/check");
      } catch {
        return { authenticated: false };
      }
    },
  },

  usage: {
    today(): Promise<DailyUsageSummary> {
      return get<DailyUsageSummary>("/usage/today");
    },

    range(from: string, to: string): Promise<DailyUsageSummary[]> {
      return get<DailyUsageSummary[]>("/usage/range", { from, to });
    },

    models(day?: string): Promise<DailyUsage[]> {
      return get<DailyUsage[]>("/usage/models", day ? { day } : undefined);
    },

    logs(params?: {
      limit?: number;
      offset?: number;
      tool?: string;
      client_id?: string;
    }): Promise<RequestLog[]> {
      return get<RequestLog[]>("/usage/logs", params as Record<string, string | number | undefined>);
    },

    logDetail(id: number): Promise<RequestLog> {
      return get<RequestLog>(`/usage/logs/${id}`);
    },

    stats(): Promise<TotalStats> {
      return get<TotalStats>("/usage/stats");
    },
  },

  metrics: {
    query(promql: string, time?: number): Promise<PrometheusResponse> {
      return get<PrometheusResponse>("/metrics/query", { query: promql, time: time?.toString() });
    },

    queryRange(promql: string, start: number, end: number, step: number): Promise<PrometheusResponse> {
      return get<PrometheusResponse>("/metrics/query_range", {
        query: promql,
        start: start.toString(),
        end: end.toString(),
        step: step.toString(),
      });
    },
  },

  logs: {
    queryRange(logql: string, start: string, end: string, limit = 500): Promise<LokiResponse> {
      return get<LokiResponse>("/logs/query_range", {
        query: logql,
        start,
        end,
        limit: limit.toString(),
      });
    },
  },

  health: {
    check(): Promise<HealthResponse> {
      return get<HealthResponse>("/health");
    },
  },
};
