import { useCallback, useState } from "react";
import { getOAuthAccounts, startOAuthLogin } from "../api";
import { usePolling } from "../hooks/usePolling";
import { AuthAccountList } from "../components/AuthAccountList";
import { OAuthJobPanel } from "../components/OAuthJobPanel";
import type { OAuthStartResponse } from "../api";

export function OAuthPage() {
  const { data, loading, error, refresh } = usePolling(getOAuthAccounts, 30000);
  const [activeJob, setActiveJob] = useState<OAuthStartResponse | null>(null);

  const handleRefresh = useCallback(
    async (provider: string) => {
      try {
        const job = await startOAuthLogin(provider);
        setActiveJob(job);
      } catch (err) {
        alert(err instanceof Error ? err.message : "Failed to start login");
      }
    },
    [],
  );

  const handleJobDone = useCallback(() => {
    setActiveJob(null);
    refresh();
  }, [refresh]);

  return (
    <div>
      <div className="content-header">
        <h2>OAuth Accounts</h2>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {activeJob && (
        <OAuthJobPanel job={activeJob} onDone={handleJobDone} />
      )}

      {loading && !data && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="card">
              <div className="skeleton skeleton-title" />
              <div className="skeleton skeleton-text" style={{ width: "60%" }} />
            </div>
          ))}
        </div>
      )}

      {data && (
        <AuthAccountList accounts={data.accounts} onRefresh={handleRefresh} />
      )}
    </div>
  );
}
