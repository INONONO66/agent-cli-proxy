import { useCallback } from "react";
import { useSSE } from "../hooks/useSSE";
import { cancelOAuthJob } from "../api";
import type { OAuthStartResponse } from "../api";

interface OAuthJobPanelProps {
  job: OAuthStartResponse;
  onDone: () => void;
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

  const handleCancel = useCallback(async () => {
    await cancelOAuthJob(job.job_id);
    onDone();
  }, [job.job_id, onDone]);

  const handleCopy = useCallback((text: string) => {
    void navigator.clipboard.writeText(text);
  }, []);

  return (
    <div className="oauth-job-panel">
      <div className="status-line">
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
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 4 }}>
            OAuth URL
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
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 4 }}>
            SSH Tunnel
          </div>
          <div className="ssh-box">
            <code>{urlEvent.sshTunnel}</code>
            <button onClick={() => handleCopy(urlEvent.sshTunnel ?? "")}>Copy</button>
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
