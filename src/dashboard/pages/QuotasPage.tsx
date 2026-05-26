import { useCallback } from "react";
import { getQuotas } from "../api";
import { usePolling } from "../hooks/usePolling";
import { QuotaCard } from "../components/QuotaCard";

export function QuotasPage() {
  const { data, loading, error, refresh } = usePolling(
    () => getQuotas(),
    30000,
  );

  const handleRefresh = useCallback(async () => {
    await getQuotas(true);
    refresh();
  }, [refresh]);

  return (
    <div>
      <div className="content-header">
        <h2>Quotas</h2>
        <button onClick={handleRefresh}>Refresh</button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {loading && !data && (
        <div className="card-grid">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="card">
              <div className="skeleton skeleton-title" />
              <div className="skeleton skeleton-text" />
              <div className="skeleton skeleton-text" style={{ width: "80%" }} />
            </div>
          ))}
        </div>
      )}

      {data && data.snapshots.length === 0 && (
        <div className="empty-state">No quota snapshots available.</div>
      )}

      {data && data.snapshots.length > 0 && (
        <div className="card-grid">
          {data.snapshots.map((snap) => (
            <QuotaCard key={`${snap.provider}-${snap.account}-${snap.quota_type}`} snapshot={snap} />
          ))}
        </div>
      )}
    </div>
  );
}
