import { useCallback, useMemo, useState } from "react";
import {
  getAccountSummary,
  getCostSummary,
  getModelBreakdown,
  getProviderBreakdown,
  getStats,
  getTodayUsage,
  getUsageRange,
} from "../api";
import { usePolling } from "../hooks/usePolling";
import { UsageSummary } from "../components/UsageSummary";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function formatCost(n: number): string {
  return `$${n.toFixed(4)}`;
}

export function UsagePage() {
  const [from, setFrom] = useState(todayIso());
  const [to, setTo] = useState(todayIso());
  const [month, setMonth] = useState(currentMonth());

  const { data: today } = usePolling(getTodayUsage, 30000);
  const { data: range } = usePolling(
    useCallback(() => getUsageRange(from, to), [from, to]),
    30000,
  );
  const { data: modelBreakdown } = usePolling(
    useCallback(() => getModelBreakdown(from), [from]),
    30000,
  );
  const { data: providerBreakdown } = usePolling(
    useCallback(() => getProviderBreakdown(from), [from]),
    30000,
  );
  const { data: stats } = usePolling(getStats, 30000);
  const { data: costSummary } = usePolling(
    useCallback(() => getCostSummary(month), [month]),
    30000,
  );

  const maxModelTokens = useMemo(
    () => Math.max(1, ...(modelBreakdown ?? []).map((m) => m.total_tokens)),
    [modelBreakdown],
  );
  const maxProviderTokens = useMemo(
    () => Math.max(1, ...(providerBreakdown ?? []).map((p) => p.total_tokens)),
    [providerBreakdown],
  );

  return (
    <div>
      <div className="content-header">
        <h2>Usage & Cost</h2>
      </div>

      {today && <UsageSummary summary={today} />}

      <div className="section">
        <h3>Date Range</h3>
        <div className="date-range">
          <label>From</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <label>To</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>

      {range && range.length > 0 && (
        <div className="section">
          <h3>Daily Overview</h3>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th style={{ textAlign: "right" }}>Requests</th>
                  <th style={{ textAlign: "right" }}>Tokens</th>
                  <th style={{ textAlign: "right" }}>Cost</th>
                </tr>
              </thead>
              <tbody>
                {range.map((day) => (
                  <tr key={day.date}>
                    <td>{day.date}</td>
                    <td style={{ textAlign: "right" }}><span className="mono">{formatNumber(day.requests)}</span></td>
                    <td style={{ textAlign: "right" }}><span className="mono">{formatNumber(day.total_tokens)}</span></td>
                    <td style={{ textAlign: "right" }}><span className="mono">{formatCost(day.cost_usd)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {modelBreakdown && modelBreakdown.length > 0 && (
        <div className="section">
          <h3>Model Breakdown ({from})</h3>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Provider</th>
                  <th style={{ textAlign: "right" }}>Requests</th>
                  <th style={{ textAlign: "right" }}>Tokens</th>
                  <th style={{ textAlign: "right" }}>Cost</th>
                  <th style={{ width: 140 }}></th>
                </tr>
              </thead>
              <tbody>
                {modelBreakdown.map((row) => (
                  <tr key={`${row.provider}-${row.model}`}>
                    <td><span className="mono">{row.model}</span></td>
                    <td>{row.provider}</td>
                    <td style={{ textAlign: "right" }}><span className="mono">{formatNumber(row.request_count)}</span></td>
                    <td style={{ textAlign: "right" }}><span className="mono">{formatNumber(row.total_tokens)}</span></td>
                    <td style={{ textAlign: "right" }}><span className="mono">{formatCost(row.cost_usd)}</span></td>
                    <td>
                      <div className="bar-cell">
                        <div className="bar-track">
                          <div
                            className="bar-fill"
                            style={{ width: `${(row.total_tokens / maxModelTokens) * 100}%` }}
                          />
                        </div>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {providerBreakdown && providerBreakdown.length > 0 && (
        <div className="section">
          <h3>Provider Breakdown ({from})</h3>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>Provider</th>
                  <th style={{ textAlign: "right" }}>Requests</th>
                  <th style={{ textAlign: "right" }}>Tokens</th>
                  <th style={{ textAlign: "right" }}>Cost</th>
                  <th style={{ width: 140 }}></th>
                </tr>
              </thead>
              <tbody>
                {providerBreakdown.map((row) => (
                  <tr key={row.provider}>
                    <td>{row.provider}</td>
                    <td style={{ textAlign: "right" }}><span className="mono">{formatNumber(row.request_count)}</span></td>
                    <td style={{ textAlign: "right" }}><span className="mono">{formatNumber(row.total_tokens)}</span></td>
                    <td style={{ textAlign: "right" }}><span className="mono">{formatCost(row.cost_usd)}</span></td>
                    <td>
                      <div className="bar-cell">
                        <div className="bar-track">
                          <div
                            className="bar-fill"
                            style={{ width: `${(row.total_tokens / maxProviderTokens) * 100}%` }}
                          />
                        </div>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="section">
        <h3>Monthly Cost Summary</h3>
        <div className="date-range">
          <label>Month</label>
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
          />
        </div>
      </div>

      {costSummary && (
        <div className="section">
          <div className="stats-row">
            <div className="stat-box">
              <div className="label">Accounts</div>
              <div className="value">{formatNumber(costSummary.totals.accounts)}</div>
            </div>
            <div className="stat-box">
              <div className="label">Requests</div>
              <div className="value">{formatNumber(costSummary.totals.total_requests)}</div>
            </div>
            <div className="stat-box">
              <div className="label">Total Cost</div>
              <div className="value">{formatCost(costSummary.totals.total_cost_usd)}</div>
            </div>
            <div className="stat-box">
              <div className="label">Overage</div>
              <div className="value" style={{ color: costSummary.totals.total_overage_usd > 0 ? "var(--accent-red)" : undefined }}>
                {formatCost(costSummary.totals.total_overage_usd)}
              </div>
            </div>
          </div>

          {costSummary.rows.length > 0 && (
            <div className="card">
              <table>
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Plan</th>
                    <th style={{ textAlign: "right" }}>Monthly Price</th>
                    <th style={{ textAlign: "right" }}>Requests</th>
                    <th style={{ textAlign: "right" }}>Cost</th>
                    <th style={{ textAlign: "right" }}>Overage</th>
                  </tr>
                </thead>
                <tbody>
                  {costSummary.rows.map((row) => (
                    <tr key={row.cliproxy_account}>
                      <td>{row.cliproxy_account}</td>
                      <td>{row.subscription_code ?? "—"}</td>
                      <td style={{ textAlign: "right" }}><span className="mono">{formatCost(row.monthly_price_usd)}</span></td>
                      <td style={{ textAlign: "right" }}><span className="mono">{formatNumber(row.total_requests)}</span></td>
                      <td style={{ textAlign: "right" }}><span className="mono">{formatCost(row.total_cost_usd)}</span></td>
                      <td
                        style={{
                          textAlign: "right",
                          color: row.computed_overage_usd > 0 ? "var(--accent-red)" : undefined,
                        }}
                      >
                        <span className="mono">{formatCost(row.computed_overage_usd)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {stats && (
        <div className="section">
          <h3>All-Time Statistics</h3>
          <div className="stats-row">
            <div className="stat-box">
              <div className="label">Total Requests</div>
              <div className="value">{formatNumber(stats.total_requests)}</div>
            </div>
            <div className="stat-box">
              <div className="label">Total Tokens</div>
              <div className="value">{formatNumber(stats.total_tokens)}</div>
            </div>
            <div className="stat-box">
              <div className="label">Total Cost</div>
              <div className="value">{formatCost(stats.total_cost_usd)}</div>
            </div>
          </div>
          {stats.first_request_at && (
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>
              First request: {new Date(stats.first_request_at).toLocaleDateString()} · Last request:{" "}
              {stats.last_request_at ? new Date(stats.last_request_at).toLocaleDateString() : "—"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
