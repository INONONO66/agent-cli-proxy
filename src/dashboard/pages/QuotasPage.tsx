import { useCallback, useMemo } from "react";
import type { Usage } from "../../usage";
import { getQuotas } from "../api";
import { usePolling } from "../hooks/usePolling";
import { AccountQuotaCard } from "../components/AccountQuotaCard";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";

export function QuotasPage() {
  const { data, loading, error, refresh } = usePolling(
    () => getQuotas(),
    30000,
  );

  const handleRefresh = useCallback(async () => {
    await getQuotas(true);
    await refresh();
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
      <div className="flex items-center justify-between gap-3 flex-wrap mb-5">
        <h2 className="text-lg font-semibold">Quotas</h2>
        <Button variant="outline" size="sm" onClick={handleRefresh}>Refresh</Button>
      </div>

      {error && <div className="rounded-lg border border-destructive/50 bg-destructive/10 text-destructive p-3 text-sm mb-4">{error}</div>}

      {loading && !data && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-4">
                <Skeleton className="h-4 w-3/5 mb-3" />
                <Skeleton className="h-3 w-full mb-2" />
                <Skeleton className="h-3 w-4/5" />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {data && groups.length === 0 && (
        <div className="text-center text-muted-foreground py-12">No quota snapshots available.</div>
      )}

      {data && groups.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
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
