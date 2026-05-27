import { useCallback, useEffect, useMemo, useState } from "react";
import type { Usage } from "../../usage";
import { getLogs } from "../api";
import { usePolling } from "../hooks/usePolling";
import { LogTable } from "../components/LogTable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const PROVIDERS = ["anthropic", "openai", "kimi", "xai"];

const STATUS_OPTIONS = [
  { label: "All", value: "" },
  { label: "2xx", value: "2xx", min: 200, max: 299 },
  { label: "3xx", value: "3xx", min: 300, max: 399 },
  { label: "4xx", value: "4xx", min: 400, max: 499 },
  { label: "5xx", value: "5xx", min: 500, max: 599 },
] as const;

const LIFECYCLE_OPTIONS: { label: string; value: Usage.LifecycleStatus | "" }[] = [
  { label: "All", value: "" },
  { label: "Pending", value: "pending" },
  { label: "Completed", value: "completed" },
  { label: "Error", value: "error" },
  { label: "Aborted", value: "aborted" },
];

function getHashParams(): URLSearchParams {
  const hash = window.location.hash;
  const qs = hash.includes("?") ? hash.split("?")[1] : "";
  return new URLSearchParams(qs);
}

function buildHash(params: URLSearchParams): string {
  const qs = params.toString();
  return qs ? `#/logs/?${qs}` : "#/logs";
}

export function LogsPage() {
  const initialParams = useMemo(() => getHashParams(), []);

  const [limit, setLimit] = useState(50);
  const [offset, setOffset] = useState(0);

  const [tool, setTool] = useState(initialParams.get("tool") ?? "");
  const [clientId, setClientId] = useState(initialParams.get("client_id") ?? "");
  const [model, setModel] = useState(initialParams.get("model") ?? "");
  const [provider, setProvider] = useState(initialParams.get("provider") ?? "");
  const [status, setStatus] = useState(initialParams.get("status") ?? "");
  const [lifecycle, setLifecycle] = useState<Usage.LifecycleStatus | "">(
    (initialParams.get("lifecycle_status") as Usage.LifecycleStatus | "") ?? "",
  );

  const [appliedTool, setAppliedTool] = useState(initialParams.get("tool") ?? "");
  const [appliedClientId, setAppliedClientId] = useState(initialParams.get("client_id") ?? "");
  const [appliedModel, setAppliedModel] = useState(initialParams.get("model") ?? "");
  const [appliedProvider, setAppliedProvider] = useState(initialParams.get("provider") ?? "");
  const [appliedStatus, setAppliedStatus] = useState(initialParams.get("status") ?? "");
  const [appliedLifecycle, setAppliedLifecycle] = useState<Usage.LifecycleStatus | "">(
    (initialParams.get("lifecycle_status") as Usage.LifecycleStatus | "") ?? "",
  );

  const fetchLogs = useCallback(() => {
    let statusMin: number | undefined;
    let statusMax: number | undefined;
    if (appliedStatus) {
      const opt = STATUS_OPTIONS.find((o) => o.value === appliedStatus);
      if (opt?.value) {
        statusMin = opt.min;
        statusMax = opt.max;
      }
    }
    return getLogs({
      limit,
      offset,
      tool: appliedTool || undefined,
      clientId: appliedClientId || undefined,
      model: appliedModel || undefined,
      provider: appliedProvider || undefined,
      statusMin,
      statusMax,
      lifecycleStatus: appliedLifecycle || undefined,
    });
  }, [limit, offset, appliedTool, appliedClientId, appliedModel, appliedProvider, appliedStatus, appliedLifecycle]);

  const { data: logs, loading, error, refresh } = usePolling(fetchLogs, 10000);

  const applyFilters = useCallback(() => {
    setOffset(0);
    setAppliedTool(tool);
    setAppliedClientId(clientId);
    setAppliedModel(model);
    setAppliedProvider(provider);
    setAppliedStatus(status);
    setAppliedLifecycle(lifecycle);

    const params = new URLSearchParams();
    if (tool) params.set("tool", tool);
    if (clientId) params.set("client_id", clientId);
    if (model) params.set("model", model);
    if (provider) params.set("provider", provider);
    if (status) params.set("status", status);
    if (lifecycle) params.set("lifecycle_status", lifecycle);
    window.location.hash = buildHash(params);
  }, [tool, clientId, model, provider, status, lifecycle]);

  const clearFilters = useCallback(() => {
    setTool("");
    setClientId("");
    setModel("");
    setProvider("");
    setStatus("");
    setLifecycle("");
    setAppliedTool("");
    setAppliedClientId("");
    setAppliedModel("");
    setAppliedProvider("");
    setAppliedStatus("");
    setAppliedLifecycle("");
    setOffset(0);
    window.location.hash = "#/logs";
  }, []);

  useEffect(() => {
    function onHashChange() {
      const params = getHashParams();
      const nextTool = params.get("tool") ?? "";
      const nextClientId = params.get("client_id") ?? "";
      const nextModel = params.get("model") ?? "";
      const nextProvider = params.get("provider") ?? "";
      const nextStatus = params.get("status") ?? "";
      const nextLifecycle = (params.get("lifecycle_status") as Usage.LifecycleStatus | "") ?? "";

      setTool(nextTool);
      setClientId(nextClientId);
      setModel(nextModel);
      setProvider(nextProvider);
      setStatus(nextStatus);
      setLifecycle(nextLifecycle);

      setAppliedTool(nextTool);
      setAppliedClientId(nextClientId);
      setAppliedModel(nextModel);
      setAppliedProvider(nextProvider);
      setAppliedStatus(nextStatus);
      setAppliedLifecycle(nextLifecycle);
      setOffset(0);
    }

    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    refresh();
  }, [appliedTool, appliedClientId, appliedModel, appliedProvider, appliedStatus, appliedLifecycle, limit, offset, refresh]);

  const tools = useMemo(() => {
    if (!logs) return [];
    const set = new Set<string>();
    for (const log of logs) set.add(log.tool);
    return Array.from(set).sort();
  }, [logs]);

  const selectClass = "h-8 rounded-md border border-input bg-transparent px-2 text-xs min-w-[140px]";

  return (
    <div>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-5">
        <h2 className="text-lg font-semibold">Request Logs</h2>
      </div>

      {error && <div className="rounded-lg border border-destructive/50 bg-destructive/10 text-destructive p-3 text-sm mb-4">{error}</div>}

      <div className="flex gap-2 items-center flex-wrap mb-4">
        <select className={selectClass} value={tool} onChange={(e) => setTool(e.target.value)}>
          <option value="">All tools</option>
          {tools.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <Input
          type="text"
          placeholder="Client ID"
          className="h-8 text-xs min-w-[140px] max-w-[180px]"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
        />
        <Input
          type="text"
          placeholder="Model"
          className="h-8 text-xs min-w-[140px] max-w-[180px]"
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />
        <select className={selectClass} value={provider} onChange={(e) => setProvider(e.target.value)}>
          <option value="">All providers</option>
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <select className={selectClass} value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <select className={selectClass} value={lifecycle} onChange={(e) => setLifecycle(e.target.value as Usage.LifecycleStatus | "")}>
          {LIFECYCLE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <Button variant="default" size="sm" onClick={applyFilters}>Apply</Button>
        <Button variant="outline" size="sm" onClick={clearFilters}>Clear Filters</Button>
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
