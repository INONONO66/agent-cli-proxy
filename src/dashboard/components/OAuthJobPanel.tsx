import { useCallback, useState } from "react";
import { useSSE } from "../hooks/useSSE";
import { cancelOAuthJob } from "../api";
import type { OAuthStartResponse } from "../api";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface OAuthJobPanelProps {
  job: OAuthStartResponse;
  onDone: () => void;
}

const STEPS = [
  { key: "started", label: "Starting" },
  { key: "url", label: "Waiting for URL" },
  { key: "auth_ready", label: "Auth URL ready" },
  { key: "ssh_needed", label: "SSH tunnel needed" },
  { key: "done", label: "Completed" },
];

function stepIndex(type: string | undefined): number {
  if (type === "started") return 0;
  if (type === "url") return 1;
  if (type === "done") return 4;
  if (type === "error") return 4;
  if (type === "cancelled") return 4;
  return -1;
}

function useCopyFeedback(duration = 2000): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(
    (text: string) => {
      void navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), duration);
      });
    },
    [duration],
  );
  return [copied, copy];
}

export function OAuthJobPanel({ job, onDone }: OAuthJobPanelProps) {
  const { events, connected } = useSSE(
    `/admin/oauth/jobs/${encodeURIComponent(job.job_id)}/events`,
  );

  const latest = events[events.length - 1];
  const urlEvent = events.find((e) => e.type === "url");
  const doneEvent = events.find((e) => e.type === "done");
  const errorEvent = events.find((e) => e.type === "error");
  const cancelledEvent = events.find((e) => e.type === "cancelled");

  const isTerminal = !!doneEvent || !!errorEvent || !!cancelledEvent;
  const currentStep = stepIndex(latest?.type);

  const [sshCopied, copySsh] = useCopyFeedback();
  const [urlCopied, copyUrl] = useCopyFeedback();

  const handleCancel = useCallback(async () => {
    await cancelOAuthJob(job.job_id);
    onDone();
  }, [job.job_id, onDone]);

  return (
    <Card className="mb-5">
      <CardContent className="p-5">
        <div className="flex items-center gap-1 mb-3">
          {STEPS.map((step, idx) => {
            const isActive = idx === currentStep;
            const isPast = idx < currentStep;
            const isFailed = isTerminal && !doneEvent && idx === 4;
            return (
              <div
                key={step.key}
                className={cn(
                  "flex items-center gap-1.5 text-[11px]",
                  isActive ? "text-primary font-semibold" : "",
                  isPast ? "text-emerald-500" : "",
                  isFailed ? "text-destructive" : "",
                  !isActive && !isPast && !isFailed ? "text-muted-foreground opacity-50" : "",
                )}
              >
                <div className={cn(
                  "w-5 h-5 rounded-full border flex items-center justify-center text-[10px] shrink-0",
                  isPast && "border-emerald-500 bg-emerald-500/15",
                  isFailed && "border-destructive bg-destructive/15",
                  isActive && "border-primary",
                )}>
                  {isPast ? "✓" : isFailed ? "✕" : isActive && !isTerminal ? <div className="w-2.5 h-2.5 border-[1.5px] border-border border-t-primary rounded-full animate-spin" /> : idx + 1}
                </div>
                <span>{step.label}</span>
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-2 mb-3 mt-3">
          {!isTerminal && <div className="w-4 h-4 border-2 border-border border-t-primary rounded-full animate-spin" />}
          {doneEvent && <span className="text-emerald-500">✓</span>}
          {errorEvent && <span className="text-destructive">✕</span>}
          {cancelledEvent && <span className="text-muted-foreground">⊘</span>}
          <span className="text-sm">
            {latest?.type === "started" && "Waiting for OAuth URL..."}
            {latest?.type === "url" && "Open the URL to authenticate"}
            {latest?.type === "done" && (latest.success ? "Login complete" : "Login failed")}
            {latest?.type === "error" && (latest.message || "Error")}
            {latest?.type === "cancelled" && "Cancelled"}
            {!latest && (connected ? "Connecting..." : "Reconnecting...")}
          </span>
        </div>

        {urlEvent?.url && (
          <div>
            <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
              <span>OAuth URL</span>
              <Button variant="ghost" size="xs" onClick={() => copyUrl(urlEvent.url ?? "")}>
                {urlCopied ? "Copied!" : "Copy"}
              </Button>
            </div>
            <div className="rounded-md border bg-muted/50 p-3 my-2 break-all text-sm">
              <a href={urlEvent.url} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                {urlEvent.url}
              </a>
            </div>
          </div>
        )}

        {urlEvent?.sshTunnel && (
          <div>
            <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
              <span>SSH Tunnel</span>
              <Button variant="ghost" size="xs" onClick={() => copySsh(urlEvent.sshTunnel ?? "")}>
                {sshCopied ? "Copied!" : "Copy"}
              </Button>
            </div>
            <div className="rounded-md border bg-muted/50 p-3 my-2 font-mono text-xs flex items-center justify-between gap-2">
              <code className="break-all">{urlEvent.sshTunnel}</code>
            </div>
          </div>
        )}

        <div className="flex gap-2 mt-3">
          {!isTerminal && (
            <Button variant="destructive" size="sm" onClick={handleCancel}>
              Cancel
            </Button>
          )}
          {isTerminal && (
            <Button variant="outline" size="sm" onClick={onDone}>Dismiss</Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
