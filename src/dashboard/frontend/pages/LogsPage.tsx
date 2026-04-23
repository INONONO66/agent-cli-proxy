import React, { useState } from "react";
import { api, RequestLog, LokiStream } from "../lib/api";
import { useFetch, formatTokens, formatCost, formatDate, nanoToMs } from "../lib/hooks";

type TabId = "system" | "requests";
type TimeRange = "1h" | "6h" | "24h" | "7d";

const TIME_RANGE_LABELS: Record<TimeRange, string> = {
  "1h": "Last 1 hour",
  "6h": "Last 6 hours",
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
};

function timeRangeToBoundaries(range: TimeRange): { start: string; end: string } {
  const now = new Date();
  const end = Math.floor(now.getTime() / 1000);
  const offsets: Record<TimeRange, number> = {
    "1h": 3600,
    "6h": 21600,
    "24h": 86400,
    "7d": 604800,
  };
  const start = end - offsets[range];
  return {
    start: `${start}000000000`,
    end: `${end}000000000`,
  };
}

function detectLevel(line: string): "error" | "warn" | "info" {
  const lower = line.toLowerCase();
  if (lower.includes("error") || lower.includes("err ") || lower.includes("fatal") || lower.includes("critical")) {
    return "error";
  }
  if (lower.includes("warn") || lower.includes("warning")) {
    return "warn";
  }
  return "info";
}

interface LogEntry {
  ts: string;
  line: string;
  level: "error" | "warn" | "info";
}

function flattenLokiStreams(streams: LokiStream[]): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const stream of streams) {
    for (const [nanoTs, line] of stream.values) {
      entries.push({
        ts: nanoToMs(nanoTs),
        line,
        level: detectLevel(line),
      });
    }
  }
  return entries.sort((a, b) => b.ts.localeCompare(a.ts));
}

function SystemLogsTab() {
  const [query, setQuery] = useState(`{unit="agent-cli-proxy.service"}`);
  const [timeRange, setTimeRange] = useState<TimeRange>("1h");
  const [submittedQuery, setSubmittedQuery] = useState(query);
  const [submittedRange, setSubmittedRange] = useState<TimeRange>(timeRange);

  const { start, end } = timeRangeToBoundaries(submittedRange);

  const { data, loading, error } = useFetch(
    () => api.logs.queryRange(submittedQuery, start, end, 500),
    [submittedQuery, submittedRange]
  );

  const entries = data ? flattenLokiStreams(data.data.result) : [];

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setSubmittedQuery(query);
    setSubmittedRange(timeRange);
  }

  return (
    <div>
      <form onSubmit={handleSearch}>
        <div className="log-toolbar">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder='LogQL query e.g. {unit="agent-cli-proxy.service"}'
            style={{ flex: 1, minWidth: "300px" }}
          />
          <select
            value={timeRange}
            onChange={(e) => setTimeRange(e.target.value as TimeRange)}
            style={{ width: "auto" }}
          >
            {(Object.entries(TIME_RANGE_LABELS) as [TimeRange, string][]).map(([val, label]) => (
              <option key={val} value={val}>{label}</option>
            ))}
          </select>
          <button type="submit" className="btn btn-secondary btn-sm">
            Query
          </button>
        </div>
      </form>

      {error && <div className="error-state">{error}</div>}

      <div className="log-container">
        {loading ? (
          <div className="loading-spinner">
            <div className="spinner" />
            <span>Fetching logs...</span>
          </div>
        ) : entries.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">📋</div>
            <div className="empty-state-text">No log entries found</div>
          </div>
        ) : (
          <div className="log-list">
            {entries.map((entry, idx) => (
              <div key={idx} className="log-entry">
                <span className="log-ts">{entry.ts}</span>
                <span className={`log-line level-${entry.level}`}>{entry.line}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const TOOL_OPTIONS = ["", "opencode", "openclaw", "hermes-agent"];

interface RequestRowProps {
  log: RequestLog;
  expanded: boolean;
  onToggle: () => void;
}

function RequestRow({ log, expanded, onToggle }: RequestRowProps) {
  const status = log.status ?? (log.error_code ? 500 : 200);
  const badgeClass =
    status >= 500 ? "badge-red" :
    status >= 400 ? "badge-yellow" :
    "badge-green";

  return (
    <>
      <tr onClick={onToggle}>
        <td className="mono muted">{formatDate(log.started_at)}</td>
        <td>
          <span className="badge badge-blue">{log.tool || "unknown"}</span>
        </td>
        <td className="mono">{log.client_id || "—"}</td>
        <td className="mono muted" style={{ fontSize: "11px" }}>{log.model}</td>
        <td className="mono">{formatTokens(log.total_tokens)}</td>
        <td className="mono">{formatCost(log.cost_usd)}</td>
        <td>
          <span className={`badge ${badgeClass}`}>{status}</span>
        </td>
        <td className="mono muted">{log.latency_ms != null ? `${log.latency_ms}ms` : "—"}</td>
      </tr>
      {expanded && (
        <tr className="expanded-row">
          <td colSpan={8}>
            <div className="expanded-content">
              <div className="expanded-grid">
                <div className="expanded-field">
                  <span className="expanded-label">Provider</span>
                  <span className="expanded-value">{log.provider}</span>
                </div>
                <div className="expanded-field">
                  <span className="expanded-label">Path</span>
                  <span className="expanded-value">{log.path}</span>
                </div>
                <div className="expanded-field">
                  <span className="expanded-label">Prompt Tokens</span>
                  <span className="expanded-value">{log.prompt_tokens.toLocaleString()}</span>
                </div>
                <div className="expanded-field">
                  <span className="expanded-label">Completion Tokens</span>
                  <span className="expanded-value">{log.completion_tokens.toLocaleString()}</span>
                </div>
                <div className="expanded-field">
                  <span className="expanded-label">Cache Read</span>
                  <span className="expanded-value">{log.cache_read_tokens.toLocaleString()}</span>
                </div>
                <div className="expanded-field">
                  <span className="expanded-label">Cache Write</span>
                  <span className="expanded-value">{log.cache_creation_tokens.toLocaleString()}</span>
                </div>
                <div className="expanded-field">
                  <span className="expanded-label">Streamed</span>
                  <span className="expanded-value">{log.streamed ? "Yes" : "No"}</span>
                </div>
                <div className="expanded-field">
                  <span className="expanded-label">Incomplete</span>
                  <span className="expanded-value">{log.incomplete ? "Yes" : "No"}</span>
                </div>
                {log.error_code && (
                  <div className="expanded-field">
                    <span className="expanded-label">Error Code</span>
                    <span className="expanded-value" style={{ color: "var(--accent-red)" }}>
                      {log.error_code}
                    </span>
                  </div>
                )}
                <div className="expanded-field">
                  <span className="expanded-label">Finished At</span>
                  <span className="expanded-value">{log.finished_at ? formatDate(log.finished_at) : "—"}</span>
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

const PAGE_SIZE = 50;

function RequestLogsTab() {
  const [tool, setTool] = useState("");
  const [clientId, setClientId] = useState("");
  const [offset, setOffset] = useState(0);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const [submittedTool, setSubmittedTool] = useState("");
  const [submittedClientId, setSubmittedClientId] = useState("");

  const { data, loading, error } = useFetch(
    () =>
      api.usage.logs({
        limit: PAGE_SIZE,
        offset,
        tool: submittedTool || undefined,
        client_id: submittedClientId || undefined,
      }),
    [submittedTool, submittedClientId, offset]
  );

  function handleFilter(e: React.FormEvent) {
    e.preventDefault();
    setOffset(0);
    setSubmittedTool(tool);
    setSubmittedClientId(clientId);
    setExpandedId(null);
  }

  const logs = data ?? [];

  return (
    <div>
      <form onSubmit={handleFilter}>
        <div className="filter-row">
          <select value={tool} onChange={(e) => setTool(e.target.value)}>
            <option value="">All tools</option>
            {TOOL_OPTIONS.filter(Boolean).map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <input
            type="text"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="Client ID filter..."
            style={{ width: "200px" }}
          />
          <button type="submit" className="btn btn-secondary btn-sm">
            Filter
          </button>
        </div>
      </form>

      {error && <div className="error-state">{error}</div>}

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        {loading ? (
          <div className="loading-spinner">
            <div className="spinner" />
            <span>Loading request logs...</span>
          </div>
        ) : logs.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">📋</div>
            <div className="empty-state-text">No request logs found</div>
          </div>
        ) : (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Tool</th>
                  <th>Client ID</th>
                  <th>Model</th>
                  <th>Tokens</th>
                  <th>Cost</th>
                  <th>Status</th>
                  <th>Latency</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log, idx) => {
                  const rowId = log.id ?? idx;
                  return (
                    <RequestRow
                      key={rowId}
                      log={log}
                      expanded={expandedId === rowId}
                      onToggle={() =>
                        setExpandedId(expandedId === rowId ? null : rowId)
                      }
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="pagination">
          <span className="pagination-info">
            Showing {offset + 1}–{offset + logs.length}
          </span>
          <div className="pagination-controls">
            <button
              className="btn btn-secondary btn-sm"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              Previous
            </button>
            <button
              className="btn btn-secondary btn-sm"
              disabled={logs.length < PAGE_SIZE}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function LogsPage() {
  const [activeTab, setActiveTab] = useState<TabId>("system");

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Logs</h1>
        <p className="page-subtitle">System logs from Loki and proxy request history</p>
      </div>

      <div className="tabs">
        <button
          className={`tab ${activeTab === "system" ? "active" : ""}`}
          onClick={() => setActiveTab("system")}
        >
          System Logs
        </button>
        <button
          className={`tab ${activeTab === "requests" ? "active" : ""}`}
          onClick={() => setActiveTab("requests")}
        >
          Request Logs
        </button>
      </div>

      {activeTab === "system" ? <SystemLogsTab /> : <RequestLogsTab />}
    </div>
  );
}
