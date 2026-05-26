import { useCallback, useState } from "react";
import { useSSE } from "../hooks/useSSE";
import { cancelOAuthJob } from "../api";
import type { OAuthStartResponse } from "../api";

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
  const hasSshTunnel = !!urlEvent?.sshTunnel;

  const [sshCopied, copySsh] = useCopyFeedback();
  const [urlCopied, copyUrl] = useCopyFeedback();

  const handleCancel = useCallback(async () => {
    await cancelOAuthJob(job.job_id);
    onDone();
  }, [job.job_id, onDone]);

  return (
    <div className="oauth-job-panel">
      <div className="status-steps">
        {STEPS.map((step, idx) => {
          const isActive = idx === currentStep;
          const isPast = idx < currentStep;
          const isFailed = isTerminal && !doneEvent && idx === 4;
          return (
            <div
              key={step.key}
              className={`status-step ${isActive ? "active" : ""} ${isPast ? "past" : ""} ${isFailed ? "failed" : ""}`}
            >
              <div className="step-dot">
                {isPast ? "✓" : isFailed ? "✕" : isActive && !isTerminal ? <div className="spinner" /> : idx + 1}
              </div>
              <div className="step-label">{step.label}</div>
            </div>
          );
        })}
      </div>

      <div className="status-line" style={{ marginTop: 12 }}>
        {!isTerminal && <div className="spinner" />}
        {doneEvent && <span style={{ color: "var(--accent-green)" }}>✓</span>}
        {errorEvent && <span style={{ color: "var(--accent-red)" }}>✕</span>}
        {cancelledEvent && <span style={{ color: "var(--text-muted)" }}>⊘</span>}
        <span>
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
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 4, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span>OAuth URL</span>
            <button
              onClick={() => copyUrl(urlEvent.url ?? "")}
              style={{ fontSize: 11, padding: "2px 8px" }}
            >
              {urlCopied ? "Copied!" : "Copy"}
            </button>
          </div>
          <div className="url-box">
            <a href={urlEvent.url} target="_blank" rel="noreferrer">
              {urlEvent.url}
            </a>
          </div>
        </div>
      )}

      {urlEvent?.sshTunnel && (
        <div>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 4, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span>SSH Tunnel</span>
            <button
              onClick={() => copySsh(urlEvent.sshTunnel ?? "")}
              style={{ fontSize: 11, padding: "2px 8px" }}
            >
              {sshCopied ? "Copied!" : "Copy"}
            </button>
          </div>
          <div className="ssh-box">
            <code>{urlEvent.sshTunnel}</code>
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        {!isTerminal && (
          <button className="danger" onClick={handleCancel}>
            Cancel
          </button>
        )}
        {isTerminal && (
          <button onClick={onDone}>Dismiss</button>
        )}
      </div>
    </div>
  );
}
