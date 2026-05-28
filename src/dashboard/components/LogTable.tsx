import { Fragment, useCallback, useState } from "react";
import type { Usage } from "../../usage";
import { cn } from "@/lib/utils";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

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

  const hasPrev = offset > 0;
  const hasNext = logs.length >= limit;

  return (
    <div>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Tool</TableHead>
              <TableHead>Client</TableHead>
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
            {loading && logs.length === 0 && (
              <>
                {Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={`skel-${i}`}>
                    {Array.from({ length: 10 }).map((__, j) => (
                      <TableCell key={j}><Skeleton className="h-3" style={{ width: `${60 + ((i * 10 + j) % 40)}%` }} /></TableCell>
                    ))}
                  </TableRow>
                ))}
              </>
            )}
            {logs.map((log) => (
              <Fragment key={log.id}>
                <TableRow
                  className={cn("cursor-pointer", expandedId === log.id && "bg-accent/50")}
                  onClick={() => toggleExpand(log.id ?? 0)}
                >
                  <TableCell>{formatDate(log.started_at)}</TableCell>
                  <TableCell>{log.tool}</TableCell>
                  <TableCell><span className="font-mono text-xs">{log.client_id}</span></TableCell>
                  <TableCell><span className="font-mono text-xs">{log.model}</span></TableCell>
                  <TableCell>{log.provider}</TableCell>
                  <TableCell className="text-right"><span className="font-mono">{formatTokens(log.prompt_tokens)}</span></TableCell>
                  <TableCell className="text-right"><span className="font-mono">{formatTokens(log.completion_tokens)}</span></TableCell>
                  <TableCell className="text-right"><span className="font-mono">{formatCost(log.cost_usd)}</span></TableCell>
                  <TableCell className="text-right"><span className="font-mono">{log.latency_ms ? `${log.latency_ms}ms` : "—"}</span></TableCell>
                  <TableCell>
                    <span className={cn("inline-block w-2 h-2 rounded-full mr-1.5", DOT_COLORS[statusDot(log.status, log.lifecycle_status)])} />
                    {log.status ?? log.lifecycle_status ?? "—"}
                  </TableCell>
                </TableRow>
                {expandedId === log.id && (
                  <TableRow>
                    <TableCell colSpan={10} className="p-0">
                      <div className="bg-muted/50 p-4 border-t">
                        <pre className="font-mono text-xs text-muted-foreground whitespace-pre-wrap break-all leading-relaxed">{JSON.stringify(log, null, 2)}</pre>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            ))}
            {!loading && logs.length === 0 && (
              <TableRow>
                <TableCell colSpan={10}>
                  <div className="text-center text-muted-foreground py-12">No logs found.</div>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between mt-4 gap-3 flex-wrap">
        <div className="flex gap-2 items-center">
          <Button variant="outline" size="sm" disabled={!hasPrev} onClick={() => onOffsetChange(Math.max(0, offset - limit))}>
            Previous
          </Button>
          <Button variant="outline" size="sm" disabled={!hasNext} onClick={() => onOffsetChange(offset + limit)}>
            Next
          </Button>
        </div>
        <div className="text-xs text-muted-foreground">
          Page {Math.floor(offset / limit) + 1} · {limit} per page
        </div>
        <Select value={String(limit)} onValueChange={(v) => onLimitChange(Number(v))}>
          <SelectTrigger size="sm" className="w-[100px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[25, 50, 100].map((n) => (
              <SelectItem key={n} value={String(n)}>{n} / page</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
