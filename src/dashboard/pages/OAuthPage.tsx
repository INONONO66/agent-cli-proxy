import { useCallback, useState } from "react";
import React from "react";
import { getOAuthAccounts, startOAuthLogin } from "../api";
import { usePolling } from "../hooks/usePolling";
import { AuthAccountList } from "../components/AuthAccountList";
import { OAuthJobPanel } from "../components/OAuthJobPanel";
import type { OAuthStartResponse } from "../api";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";

export function OAuthPage() {
  const fetchAccounts = useCallback(() => getOAuthAccounts(), []);
  const { data, loading, error, refresh } = usePolling(fetchAccounts, 30000);
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
      <div className="flex items-center justify-between gap-3 flex-wrap mb-5">
        <h2 className="text-lg font-semibold">OAuth Accounts</h2>
      </div>

      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {activeJob && (
        <OAuthJobPanel job={activeJob} onDone={handleJobDone} />
      )}

      {loading && !data && (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-4">
                <Skeleton className="h-4 w-3/5 mb-3" />
                <Skeleton className="h-3 w-2/5" />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {data && (
        <AuthAccountList accounts={data.accounts} onRefresh={handleRefresh} />
      )}
    </div>
  );
}
