type SessionResponse = {
  readonly authenticated?: boolean;
  readonly loginConfigured?: boolean;
};

type ReadyResponse = {
  readonly status?: string;
  readonly checks?: Record<string, { readonly status?: string }>;
};

type TodayResponse = {
  readonly requests?: number;
  readonly total_tokens?: number;
  readonly cost_usd?: number;
};

type StatsResponse = {
  readonly total_requests?: number;
  readonly total_tokens?: number;
  readonly total_cost_usd?: number;
};

type TrendResponse = {
  readonly buckets?: Array<{ readonly bucket?: string; readonly requests?: number; readonly cost_usd?: number }>;
};

type ProviderResponse = {
  readonly provider?: string;
  readonly request_count?: number;
  readonly total_tokens?: number;
  readonly cost_usd?: number;
};

type RequestLog = {
  readonly started_at?: string;
  readonly tool?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly lifecycle_status?: string;
  readonly status?: number;
  readonly cost_usd?: number;
};

const elements = {
  loginView: byId("login-view"),
  dashboardView: byId("dashboard-view"),
  loginForm: byId<HTMLFormElement>("login-form"),
  password: byId<HTMLInputElement>("password"),
  loginError: byId("login-error"),
  refresh: byId<HTMLButtonElement>("refresh"),
  logout: byId<HTMLButtonElement>("logout"),
  alert: byId("alert"),
  todayRequests: byId("today-requests"),
  totalRequests: byId("total-requests"),
  todayTokens: byId("today-tokens"),
  totalTokens: byId("total-tokens"),
  todayCost: byId("today-cost"),
  totalCost: byId("total-cost"),
  readyState: byId("ready-state"),
  readyDetail: byId("ready-detail"),
  trendTotal: byId("trend-total"),
  trendChart: byId("trend-chart"),
  providerList: byId("provider-list"),
  requestLog: byId<HTMLTableSectionElement>("request-log"),
};

elements.loginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void login();
});
elements.refresh.addEventListener("click", () => void loadDashboard());
elements.logout.addEventListener("click", () => void logout());

void boot();

async function boot(): Promise<void> {
  try {
    const session = await getJson<SessionResponse>("/api/admin/session");
    if (session.authenticated || !session.loginConfigured) {
      showDashboard();
      await loadDashboard();
      return;
    }
    showLogin();
  } catch (err) {
    showLogin();
    showLoginError(err instanceof Error ? err.message : String(err));
  }
}

async function login(): Promise<void> {
  hideLoginError();
  const res = await fetch("/api/admin/session/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: elements.password.value }),
  });
  if (!res.ok) {
    showLoginError("Invalid password");
    return;
  }
  elements.password.value = "";
  showDashboard();
  await loadDashboard();
}

async function logout(): Promise<void> {
  await fetch("/api/admin/session/logout", { method: "POST" });
  showLogin();
}

async function loadDashboard(): Promise<void> {
  hideAlert();
  try {
    const [ready, today, stats, trend, providers, logs] = await Promise.all([
      getJson<ReadyResponse>("/api/ready"),
      getJson<TodayResponse>("/api/admin/usage/today"),
      getJson<StatsResponse>("/api/admin/stats"),
      getJson<TrendResponse>("/api/admin/usage/trend?hours=24"),
      getJson<ProviderResponse[]>(`/api/admin/usage/providers?day=${todayString()}`),
      getJson<RequestLog[]>("/api/admin/logs?limit=12&offset=0"),
    ]);
    renderSummary(today, stats, ready);
    renderTrend(trend.buckets ?? []);
    renderProviders(providers);
    renderLogs(logs);
  } catch (err) {
    showAlert(err instanceof Error ? err.message : String(err));
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${path} returned HTTP ${res.status}`);
  return await res.json() as T;
}

function renderSummary(today: TodayResponse, stats: StatsResponse, ready: ReadyResponse): void {
  elements.todayRequests.textContent = number(today.requests);
  elements.totalRequests.textContent = `${number(stats.total_requests)} total`;
  elements.todayTokens.textContent = compact(today.total_tokens);
  elements.totalTokens.textContent = `${compact(stats.total_tokens)} total`;
  elements.todayCost.textContent = money(today.cost_usd);
  elements.totalCost.textContent = `${money(stats.total_cost_usd)} total`;
  elements.readyState.textContent = ready.status ?? "unknown";
  elements.readyDetail.textContent = Object.entries(ready.checks ?? {}).map(([name, check]) => `${name}:${check.status ?? "unknown"}`).join(" · ") || "no checks";
}

function renderTrend(buckets: NonNullable<TrendResponse["buckets"]>): void {
  elements.trendChart.textContent = "";
  const total = buckets.reduce((sum, bucket) => sum + (bucket.requests ?? 0), 0);
  elements.trendTotal.textContent = `${number(total)} requests`;
  if (buckets.length === 0) {
    elements.trendChart.innerHTML = `<div class="empty">No usage buckets.</div>`;
    return;
  }
  const max = Math.max(...buckets.map((bucket) => bucket.requests ?? 0), 1);
  for (const bucket of buckets.slice(-24)) {
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.style.height = `${Math.max(4, ((bucket.requests ?? 0) / max) * 100)}%`;
    bar.title = `${bucket.bucket ?? "bucket"}: ${number(bucket.requests)} requests, ${money(bucket.cost_usd)}`;
    elements.trendChart.append(bar);
  }
}

function renderProviders(providers: ProviderResponse[]): void {
  elements.providerList.textContent = "";
  if (providers.length === 0) {
    elements.providerList.innerHTML = `<div class="empty">No provider usage today.</div>`;
    return;
  }
  for (const provider of providers.slice(0, 8)) {
    const row = document.createElement("div");
    row.className = "stack-row";
    row.innerHTML = `<div><strong>${escapeHtml(provider.provider ?? "unknown")}</strong><br><small>${compact(provider.total_tokens)} tokens · ${number(provider.request_count)} requests</small></div><span>${money(provider.cost_usd)}</span>`;
    elements.providerList.append(row);
  }
}

function renderLogs(logs: RequestLog[]): void {
  elements.requestLog.textContent = "";
  if (logs.length === 0) {
    elements.requestLog.innerHTML = `<tr><td colspan="6" class="empty">No request logs.</td></tr>`;
    return;
  }
  for (const log of logs) {
    const row = document.createElement("tr");
    row.innerHTML = `<td>${formatTime(log.started_at)}</td><td>${escapeHtml(log.tool ?? "unknown")}</td><td>${escapeHtml(log.provider ?? "unknown")}</td><td>${escapeHtml(log.model ?? "unknown")}</td><td><span class="badge">${escapeHtml(log.lifecycle_status ?? String(log.status ?? "--"))}</span></td><td>${money(log.cost_usd)}</td>`;
    elements.requestLog.append(row);
  }
}

function showLogin(): void {
  elements.dashboardView.classList.add("hidden");
  elements.loginView.classList.remove("hidden");
}

function showDashboard(): void {
  elements.loginView.classList.add("hidden");
  elements.dashboardView.classList.remove("hidden");
}

function showAlert(message: string): void {
  elements.alert.textContent = message;
  elements.alert.classList.remove("hidden");
}

function hideAlert(): void {
  elements.alert.classList.add("hidden");
}

function showLoginError(message: string): void {
  elements.loginError.textContent = message;
  elements.loginError.classList.remove("hidden");
}

function hideLoginError(): void {
  elements.loginError.classList.add("hidden");
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatTime(value: string | undefined): string {
  if (!value) return "--";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function number(value: number | undefined): string {
  return new Intl.NumberFormat().format(value ?? 0);
}

function compact(value: number | undefined): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value ?? 0);
}

function money(value: number | undefined): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(value ?? 0);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[char] ?? char);
}
