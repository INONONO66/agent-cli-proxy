import type { Usage } from "../../usage";

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function formatCost(n: number): string {
  return `$${n.toFixed(4)}`;
}

interface UsageSummaryProps {
  summary: Usage.DailyUsageSummary;
}

export function UsageSummary({ summary }: UsageSummaryProps) {
  const maxTokens = Math.max(
    1,
    ...summary.breakdown.map((b) => b.total_tokens),
  );

  return (
    <div>
      <div className="stats-row">
        <div className="stat-box">
          <div className="label">Requests</div>
          <div className="value">{formatNumber(summary.requests)}</div>
        </div>
        <div className="stat-box">
          <div className="label">Total Tokens</div>
          <div className="value">{formatNumber(summary.total_tokens)}</div>
        </div>
        <div className="stat-box">
          <div className="label">Cost</div>
          <div className="value">{formatCost(summary.cost_usd)}</div>
        </div>
      </div>

      {summary.breakdown.length > 0 && (
        <div className="card">
          <h4 style={{ fontSize: 13, marginBottom: 12, color: "var(--text-secondary)" }}>
            Model Breakdown
          </h4>
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
              {summary.breakdown.map((row) => (
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
                          style={{ width: `${(row.total_tokens / maxTokens) * 100}%` }}
                        />
                      </div>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
