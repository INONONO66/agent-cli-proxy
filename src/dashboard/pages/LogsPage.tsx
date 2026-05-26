import { useCallback, useEffect, useMemo, useState } from "react";
import { getLogs } from "../api";
import { usePolling } from "../hooks/usePolling";
import { LogTable } from "../components/LogTable";

export function LogsPage() {
  const [limit, setLimit] = useState(50);
  const [offset, setOffset] = useState(0);
  const [tool, setTool] = useState("");
  const [clientId, setClientId] = useState("");
  const [appliedTool, setAppliedTool] = useState("");
  const [appliedClientId, setAppliedClientId] = useState("");

  const fetchLogs = useCallback(() => {
    return getLogs(limit, offset, appliedTool || undefined, appliedClientId || undefined);
  }, [limit, offset, appliedTool, appliedClientId]);

  const { data: logs, loading, error, refresh } = usePolling(fetchLogs, 10000);

  const applyFilters = useCallback(() => {
    setOffset(0);
    setAppliedTool(tool);
    setAppliedClientId(clientId);
  }, [tool, clientId]);

  const clearFilters = useCallback(() => {
    setTool("");
    setClientId("");
    setAppliedTool("");
    setAppliedClientId("");
    setOffset(0);
  }, []);

  const tools = useMemo(() => {
    if (!logs) return [];
    const set = new Set<string>();
    for (const log of logs) set.add(log.tool);
    return Array.from(set).sort();
  }, [logs]);

  useEffect(() => {
    refresh();
  }, [appliedTool, appliedClientId, limit, offset, refresh]);

  return (
    <div>
      <div className="content-header">
        <h2>Request Logs</h2>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="logs-filter">
        <select value={tool} onChange={(e) => setTool(e.target.value)}>
          <option value="">All tools</option>
          {tools.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Client ID"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
        />
        <button onClick={applyFilters}>Apply</button>
        <button onClick={clearFilters}>Clear</button>
      </div>

      <LogTable
        logs={logs ?? []}
        loading={loading}
        limit={limit}
        offset={offset}
        onLimitChange={(n) => { setLimit(n); setOffset(0); }}
        onOffsetChange={setOffset}
      />
    </div>
  );
}
