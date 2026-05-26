import { useCallback, useMemo } from "react";
import type { Usage } from "../../usage";
import { getQuotas } from "../api";
import { usePolling } from "../hooks/usePolling";
import { AccountQuotaCard } from "../components/AccountQuotaCard";

export function QuotasPage() {
  const { data, loading, error, refresh } = usePolling(
    () => getQuotas(),
    30000,
  );

  const handleRefresh = useCallback(async () => {
    await getQuotas(true);
    refresh();
  }, [refresh]);

  const groups = useMemo(() => {
    if (!data) return [];
    const map = new Map<
      string,
      { provider: string; account: string; snapshots: Usage.QuotaSnapshot[] }
    >();
    for (const snap of data.snapshots) {
      const key = `${snap.provider}\u2014${snap.account}`;
      const group = map.get(key);
      if (group) {
        group.snapshots.push(snap);
      } else {
        map.set(key, {
          provider: snap.provider,
          account: snap.account,
          snapshots: [snap],
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => {
      const pa = a.provider.toLowerCase();
      const pb = b.provider.toLowerCase();
      if (pa !== pb) return pa.localeCompare(pb);
      return a.account.toLowerCase().localeCompare(b.account.toLowerCase());
    });
  }, [data]);

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

      {data && groups.length === 0 && (
        <div className="empty-state">No quota snapshots available.</div>
      )}

      {data && groups.length > 0 && (
        <div className="card-grid">
          {groups.map((group) => (
            <AccountQuotaCard
              key={`${group.provider}\u2014${group.account}`}
              provider={group.provider}
              account={group.account}
              snapshots={group.snapshots}
            />
          ))}
        </div>
      )}
    </div>
  );
}
