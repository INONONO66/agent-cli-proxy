import { useCallback, useState } from "react";
import type { Usage } from "../../usage";

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatTokens(n: number): string {
  return n.toLocaleString();
}

function formatCost(n: number): string {
  return `$${n.toFixed(4)}`;
}

function statusDot(status?: number, lifecycle?: string): string {
  if (lifecycle === "error" || lifecycle === "aborted") return "error";
  if (!status || status >= 500) return "error";
  if (status >= 400) return "warn";
  if (lifecycle === "pending") return "pending";
  return "ok";
}

interface LogTableProps {
  logs: Usage.RequestLog[];
  loading: boolean;
  limit: number;
  offset: number;
  onLimitChange: (limit: number) => void;
  onOffsetChange: (offset: number) => void;
}

export function LogTable({ logs, loading, limit, offset, onLimitChange, onOffsetChange }: LogTableProps) {
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const toggleExpand = useCallback((id: number) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  const total = logs.length >= limit ? offset + logs.length + 1 : offset + logs.length;
  const hasPrev = offset > 0;
  const hasNext = logs.length >= limit;

  return (
    <div>
      <div className="log-table-wrap">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Tool</th>
              <th>Client</th>
              <th>Model</th>
              <th>Provider</th>
              <th style={{ textAlign: "right" }}>Tokens In</th>
              <th style={{ textAlign: "right" }}>Tokens Out</th>
              <th style={{ textAlign: "right" }}>Cost</th>
              <th style={{ textAlign: "right" }}>Latency</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {loading && logs.length === 0 && (
              <>
                {Array.from({ length: 5 }).map((_, i) => (
                  <tr key={`skel-${i}`}>
                    {Array.from({ length: 10 }).map((__, j) => (
                      <td key={j}><div className="skeleton skeleton-text" style={{ width: `${60 + Math.random() * 40}%` }} /></td>
                    ))}
                  </tr>
                ))}
              </>
            )}
            {logs.map((log) => (
              <>
                <tr
                  key={log.id}
                  className={`log-row ${expandedId === log.id ? "expanded" : ""}`}
                  onClick={() => toggleExpand(log.id ?? 0)}
                >
                  <td>{formatDate(log.started_at)}</td>
                  <td>{log.tool}</td>
                  <td><span className="mono">{log.client_id}</span></td>
                  <td><span className="mono">{log.model}</span></td>
                  <td>{log.provider}</td>
                  <td style={{ textAlign: "right" }}><span className="mono">{formatTokens(log.prompt_tokens)}</span></td>
                  <td style={{ textAlign: "right" }}><span className="mono">{formatTokens(log.completion_tokens)}</span></td>
                  <td style={{ textAlign: "right" }}><span className="mono">{formatCost(log.cost_usd)}</span></td>
                  <td style={{ textAlign: "right" }}><span className="mono">{log.latency_ms ? `${log.latency_ms}ms` : "—"}</span></td>
                  <td>
                    <span className={`status-dot ${statusDot(log.status, log.lifecycle_status)}`} />
                    {log.status ?? log.lifecycle_status ?? "—"}
                  </td>
                </tr>
                {expandedId === log.id && (
                  <tr key={`${log.id}-detail`}>
                    <td colSpan={10}>
                      <div className="log-detail">
                        <pre>{JSON.stringify(log, null, 2)}</pre>
                      </div>
                    </td>
                  </tr>
                )}
              </>
            ))}
            {!loading && logs.length === 0 && (
              <tr>
                <td colSpan={10}>
                  <div className="empty-state">No logs found.</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="pagination">
        <div className="controls">
          <button disabled={!hasPrev} onClick={() => onOffsetChange(Math.max(0, offset - limit))}>
            Previous
          </button>
          <button disabled={!hasNext} onClick={() => onOffsetChange(offset + limit)}>
            Next
          </button>
        </div>
        <div className="info">
          Page {Math.floor(offset / limit) + 1} · {limit} per page
        </div>
        <select
          value={limit}
          onChange={(e) => onLimitChange(Number(e.target.value))}
        >
          {[25, 50, 100].map((n) => (
            <option key={n} value={n}>{n} / page</option>
          ))}
        </select>
      </div>
    </div>
  );
}
