import { Fragment, useCallback, useMemo, useState } from "react";
import type { Usage } from "../../usage";
import { useLogs, useLogDetail, useCostAudit } from "../hooks/queries";
import { useRoute, navigate } from "../hooks/useRoute";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ArrowLeft } from "lucide-react";
import type { LogQuery } from "../api";

const STATUS_OPTIONS = [
  { label: "All", value: "__all__" },
  { label: "2xx", value: "2xx", min: 200, max: 299 },
  { label: "3xx", value: "3xx", min: 300, max: 399 },
  { label: "4xx", value: "4xx", min: 400, max: 499 },
  { label: "5xx", value: "5xx", min: 500, max: 599 },
] as const;

const LIFECYCLE_OPTIONS = [
  { label: "All", value: "__all__" },
  { label: "Pending", value: "pending" },
  { label: "Completed", value: "completed" },
  { label: "Error", value: "error" },
  { label: "Aborted", value: "aborted" },
];

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const DOT_COLORS: Record<string, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  error: "bg-red-500",
  pending: "bg-muted-foreground",
};

function statusDot(status?: number, lifecycle?: string): string {
  if (lifecycle === "error" || lifecycle === "aborted") return "error";
  if (!status || status >= 500) return "error";
  if (status >= 400) return "warn";
  if (lifecycle === "pending") return "pending";
  return "ok";
}

function LogDetailView({ logId }: { logId: number }) {
  const { data: log, isLoading } = useLogDetail(logId);
  const { data: costAudit } = useCostAudit(logId);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (!log) {
    return (
      <div>
        <Button variant="ghost" size="sm" className="gap-1.5 mb-4" onClick={() => navigate("#/logs")}>
          <ArrowLeft className="size-3.5" /> Back to logs
        </Button>
        <p className="text-muted-foreground">Log not found.</p>
      </div>
    );
  }

  return (
    <div>
      <Button variant="ghost" size="sm" className="gap-1.5 mb-4" onClick={() => navigate("#/logs")}>
        <ArrowLeft className="size-3.5" /> Back to logs
      </Button>

      <h2 className="text-lg font-semibold mb-4">Request #{log.id}</h2>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <Card>
          <CardContent className="p-4 space-y-2">
            <DetailRow label="Provider" value={log.provider} />
            <DetailRow label="Model" value={log.model} mono />
            {log.actual_model && log.actual_model !== log.model && (
              <DetailRow label="Actual Model" value={log.actual_model} mono />
            )}
            {log.actual_provider && log.actual_provider !== log.provider && (
              <DetailRow label="Actual Provider" value={log.actual_provider} />
            )}
            <DetailRow label="Tool" value={log.tool} />
            <DetailRow label="Client" value={log.client_id} mono />
            <DetailRow label="Path" value={log.path} mono />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 space-y-2">
            <DetailRow label="Status" value={String(log.status ?? "—")} />
            <DetailRow label="Lifecycle" value={log.lifecycle_status ?? "—"} />
            <DetailRow label="Cost Status" value={log.cost_status ?? "—"} />
            <DetailRow label="Latency" value={log.latency_ms ? `${log.latency_ms}ms` : "—"} />
            <DetailRow label="Started" value={log.started_at} />
            <DetailRow label="Finished" value={log.finished_at ?? "—"} />
            {log.cliproxy_account && <DetailRow label="Account" value={log.cliproxy_account} mono />}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        <TokenCard label="Prompt" value={log.prompt_tokens} />
        <TokenCard label="Completion" value={log.completion_tokens} />
        <TokenCard label="Cache Read" value={log.cache_read_tokens} />
        <TokenCard label="Total" value={log.total_tokens} />
      </div>

      <Card className="mb-6">
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-semibold">Cost</span>
            <span className="font-mono text-lg font-semibold">${log.cost_usd.toFixed(6)}</span>
          </div>
        </CardContent>
      </Card>

      {costAudit && costAudit.audits.length > 0 && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold mb-3">Cost Audit Trail</h3>
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Model</TableHead>
                    <TableHead>Provider</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {costAudit.audits.map((audit) => (
                    <TableRow key={audit.id}>
                      <TableCell className="text-xs">{audit.calcAt ? formatRelativeTime(audit.calcAt) : "—"}</TableCell>
                      <TableCell><Badge variant="outline" className="text-[10px]">{audit.source ?? "—"}</Badge></TableCell>
                      <TableCell className="font-mono text-xs">{audit.model ?? "—"}</TableCell>
                      <TableCell className="text-xs">{audit.provider ?? "—"}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{audit.baseCostUsd != null ? `$${audit.baseCostUsd.toFixed(6)}` : "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      )}

      {log.error_message && (
        <Alert variant="destructive" className="mb-6">
          <AlertDescription>{log.error_message}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? "font-mono text-xs" : ""}>{value}</span>
    </div>
  );
}

function TokenCard({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">{label}</div>
        <div className="font-mono text-sm font-semibold">{value.toLocaleString()}</div>
      </CardContent>
    </Card>
  );
}

function LogListView() {
  const [limit, setLimit] = useState(50);
  const [offset, setOffset] = useState(0);
  const [tool, setTool] = useState("");
  const [clientId, setClientId] = useState("");
  const [model, setModel] = useState("");
  const [provider, setProvider] = useState("");
  const [status, setStatus] = useState("");
  const [lifecycle, setLifecycle] = useState<Usage.LifecycleStatus | "">("");

  const query = useMemo((): LogQuery => {
    const statusOpt = STATUS_OPTIONS.find((o) => o.value === status);
    return {
      limit,
      offset,
      tool: tool || undefined,
      clientId: clientId || undefined,
      model: model || undefined,
      provider: provider || undefined,
      statusMin: statusOpt && "min" in statusOpt ? statusOpt.min : undefined,
      statusMax: statusOpt && "max" in statusOpt ? statusOpt.max : undefined,
      lifecycleStatus: lifecycle || undefined,
    };
  }, [limit, offset, tool, clientId, model, provider, status, lifecycle]);

  const { data: logs, isLoading, error } = useLogs(query);

  const tools = useMemo(() => {
    if (!logs) return [];
    const set = new Set<string>();
    for (const log of logs) set.add(log.tool);
    return Array.from(set).sort();
  }, [logs]);

  const clearFilters = useCallback(() => {
    setTool("");
    setClientId("");
    setModel("");
    setProvider("");
    setStatus("");
    setLifecycle("");
    setOffset(0);
  }, []);

  const hasPrev = offset > 0;
  const hasNext = (logs?.length ?? 0) >= limit;

  return (
    <div>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-5">
        <h2 className="text-lg font-semibold">Request Logs</h2>
      </div>

      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{error instanceof Error ? error.message : "Failed to load logs"}</AlertDescription>
        </Alert>
      )}

      <div className="flex gap-2 items-center flex-wrap mb-4">
        <Select value={tool || "__all__"} onValueChange={(v) => { setTool(v === "__all__" ? "" : v); setOffset(0); }}>
          <SelectTrigger size="sm" className="min-w-[140px]">
            <SelectValue placeholder="All tools" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All tools</SelectItem>
            {tools.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
          </SelectContent>
        </Select>
        <Input type="text" placeholder="Client ID" className="h-8 text-xs min-w-[140px] max-w-[180px]" value={clientId} onChange={(e) => { setClientId(e.target.value); setOffset(0); }} />
        <Input type="text" placeholder="Model" className="h-8 text-xs min-w-[140px] max-w-[180px]" value={model} onChange={(e) => { setModel(e.target.value); setOffset(0); }} />
        <Select value={status || "__all__"} onValueChange={(v) => { setStatus(v === "__all__" ? "" : v); setOffset(0); }}>
          <SelectTrigger size="sm" className="min-w-[100px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={lifecycle || "__all__"} onValueChange={(v) => { setLifecycle((v === "__all__" ? "" : v) as Usage.LifecycleStatus | ""); setOffset(0); }}>
          <SelectTrigger size="sm" className="min-w-[120px]">
            <SelectValue placeholder="Lifecycle" />
          </SelectTrigger>
          <SelectContent>
            {LIFECYCLE_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={clearFilters}>Clear</Button>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Tool</TableHead>
              <TableHead>Model</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead className="text-right">Tokens In</TableHead>
              <TableHead className="text-right">Tokens Out</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead className="text-right">Latency</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (!logs || logs.length === 0) && (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={`skel-${i}`}>
                  {Array.from({ length: 9 }).map((__, j) => (
                    <TableCell key={j}><Skeleton className="h-3" style={{ width: `${60 + ((i * 10 + j) % 40)}%` }} /></TableCell>
                  ))}
                </TableRow>
              ))
            )}
            {logs?.map((log) => (
              <TableRow
                key={log.id}
                className="cursor-pointer hover:bg-accent/50"
                onClick={() => navigate(`#/logs/${log.id}`)}
              >
                <TableCell className="text-xs">{formatRelativeTime(log.started_at)}</TableCell>
                <TableCell className="text-xs">{log.tool}</TableCell>
                <TableCell><span className="font-mono text-xs">{log.model}</span></TableCell>
                <TableCell className="text-xs">{log.provider}</TableCell>
                <TableCell className="text-right font-mono text-xs">{log.prompt_tokens.toLocaleString()}</TableCell>
                <TableCell className="text-right font-mono text-xs">{log.completion_tokens.toLocaleString()}</TableCell>
                <TableCell className="text-right font-mono text-xs">${log.cost_usd.toFixed(4)}</TableCell>
                <TableCell className="text-right font-mono text-xs">{log.latency_ms ? `${log.latency_ms}ms` : "—"}</TableCell>
                <TableCell>
                  <span className={cn("inline-block w-2 h-2 rounded-full mr-1.5", DOT_COLORS[statusDot(log.status, log.lifecycle_status)])} />
                  <span className="text-xs">{log.status ?? log.lifecycle_status ?? "—"}</span>
                </TableCell>
              </TableRow>
            ))}
            {!isLoading && (!logs || logs.length === 0) && (
              <TableRow>
                <TableCell colSpan={9}>
                  <div className="text-center text-muted-foreground py-12">No logs found.</div>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between mt-4 gap-3 flex-wrap">
        <div className="flex gap-2 items-center">
          <Button variant="outline" size="sm" disabled={!hasPrev} onClick={() => setOffset(Math.max(0, offset - limit))}>Previous</Button>
          <Button variant="outline" size="sm" disabled={!hasNext} onClick={() => setOffset(offset + limit)}>Next</Button>
        </div>
        <div className="text-xs text-muted-foreground">
          Page {Math.floor(offset / limit) + 1} · {limit} per page
        </div>
        <Select value={String(limit)} onValueChange={(v) => { setLimit(Number(v)); setOffset(0); }}>
          <SelectTrigger size="sm" className="w-[100px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[25, 50, 100].map((n) => <SelectItem key={n} value={String(n)}>{n} / page</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

export function LogsPage() {
  const { param } = useRoute();
  const logId = param ? Number(param) : null;

  if (logId && Number.isFinite(logId)) {
    return <LogDetailView logId={logId} />;
  }

  return <LogListView />;
}
