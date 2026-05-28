import { useConfig, useProviders, usePricing, useQuotaProbes, useBreakers, useBreakerReset } from "../hooks/queries";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { CheckCircle2, XCircle, RefreshCw } from "lucide-react";

function ConfigSection() {
  const { data, isLoading } = useConfig();

  if (isLoading || !data) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-4 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <ConfigGroup title="Proxy" items={[
        { label: "Host", value: data.proxy.host },
        { label: "Port", value: String(data.proxy.port) },
        { label: "Require API Key", value: data.proxy.proxyRequireApiKey ? "Yes" : "No" },
        { label: "Trust Proxy Headers", value: data.proxy.trustProxyHeaders ? "Yes" : "No" },
      ]} />
      <ConfigGroup title="Upstream" items={[
        { label: "URL", value: data.upstream.cliProxyApiUrl },
        { label: "Timeout", value: `${data.upstream.timeoutMs}ms` },
        { label: "Connect Timeout", value: `${data.upstream.connectTimeoutMs}ms` },
        { label: "Max Retries", value: String(data.upstream.maxRetries) },
      ]} />
      <ConfigGroup title="Intervals" items={[
        { label: "Pricing Refresh", value: formatInterval(data.intervals.pricingRefreshMs) },
        { label: "Cost Backfill", value: formatInterval(data.intervals.costBackfillMs) },
        { label: "Quota Refresh", value: formatInterval(data.intervals.quotaRefreshMs) },
      ]} />
      <ConfigGroup title="Features" items={[
        { label: "Admin API Key", value: data.features.hasAdminApiKey },
        { label: "Management Key", value: data.features.hasMgmtKey },
        { label: "Auth Directory", value: data.features.hasAuthDir },
        { label: "Dashboard Password", value: data.features.hasDashboardPassword },
      ]} />
    </div>
  );
}

function ConfigGroup({ title, items }: { title: string; items: { label: string; value: string | boolean }[] }) {
  return (
    <Card>
      <CardContent className="p-4">
        <h4 className="text-sm font-semibold mb-3">{title}</h4>
        <div className="space-y-2">
          {items.map((item) => (
            <div key={item.label} className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{item.label}</span>
              {typeof item.value === "boolean" ? (
                item.value ? (
                  <CheckCircle2 className="size-4 text-emerald-500" />
                ) : (
                  <XCircle className="size-4 text-muted-foreground/50" />
                )
              ) : (
                <span className="font-mono text-xs">{item.value}</span>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function ProvidersSection() {
  const { data, isLoading } = useProviders();

  if (isLoading || !data) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Paths</TableHead>
              <TableHead>Models</TableHead>
              <TableHead>Custom Upstream</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.providers.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="font-mono text-xs font-semibold">{p.id}</TableCell>
                <TableCell><Badge variant="outline" className="text-[10px]">{p.type}</Badge></TableCell>
                <TableCell className="text-xs">{p.paths.join(", ")}</TableCell>
                <TableCell className="text-xs font-mono">{p.models.length > 0 ? p.models.slice(0, 5).join(", ") + (p.models.length > 5 ? ` +${p.models.length - 5}` : "") : "—"}</TableCell>
                <TableCell>
                  {p.hasCustomUpstream ? (
                    <Badge variant="secondary" className="text-[10px]">Custom</Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground">Default</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function PricingSection() {
  const { data, isLoading } = usePricing();

  if (isLoading || !data) {
    return <Skeleton className="h-20 w-full" />;
  }

  return (
    <Card>
      <CardContent className="p-4">
        <h4 className="text-sm font-semibold mb-3">Pricing Cache</h4>
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Status</span>
            {data.loaded ? (
              <Badge variant="default" className="text-[10px]">Loaded</Badge>
            ) : (
              <Badge variant="destructive" className="text-[10px]">Not loaded</Badge>
            )}
          </div>
          {data.fetchedAt && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Fetched At</span>
              <span className="text-xs">{new Date(data.fetchedAt).toLocaleString()}</span>
            </div>
          )}
          {data.ageMs != null && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Age</span>
              <span className="text-xs font-mono">{formatInterval(data.ageMs)}</span>
            </div>
          )}
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Cache Path</span>
            <span className="text-xs font-mono truncate max-w-[300px]" title={data.cachePath}>{data.cachePath}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function QuotaProbesSection() {
  const { data, isLoading } = useQuotaProbes();

  if (isLoading || !data) {
    return <Skeleton className="h-16 w-full" />;
  }

  return (
    <Card>
      <CardContent className="p-4">
        <h4 className="text-sm font-semibold mb-3">Quota Probes</h4>
        {data.probes.length === 0 ? (
          <p className="text-sm text-muted-foreground">No quota probes registered.</p>
        ) : (
          <div className="flex gap-2 flex-wrap">
            {data.probes.map((probe) => (
              <Badge key={probe} variant="outline" className="text-xs">{probe}</Badge>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function BreakersSection() {
  const { data, isLoading } = useBreakers();
  const resetMutation = useBreakerReset();

  if (isLoading || !data) {
    return <Skeleton className="h-20 w-full" />;
  }

  if (data.breakers.length === 0) {
    return (
      <Card>
        <CardContent className="p-4">
          <p className="text-sm text-muted-foreground">No circuit breakers active.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Provider</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Failures</TableHead>
              <TableHead>Last Failure</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.breakers.map((b) => (
              <TableRow key={b.providerId}>
                <TableCell className="font-mono text-xs">{b.providerId}</TableCell>
                <TableCell>
                  <Badge
                    variant={b.state === "closed" ? "default" : b.state === "open" ? "destructive" : "secondary"}
                    className="text-[10px]"
                  >
                    {b.state}
                  </Badge>
                </TableCell>
                <TableCell className="font-mono text-xs">{b.failures}</TableCell>
                <TableCell className="text-xs">{b.lastFailureAt ? new Date(b.lastFailureAt).toLocaleString() : "—"}</TableCell>
                <TableCell>
                  {b.state !== "closed" && (
                    <Button
                      variant="outline"
                      size="xs"
                      className="gap-1"
                      onClick={() => resetMutation.mutate(b.providerId)}
                      disabled={resetMutation.isPending}
                    >
                      <RefreshCw className={cn("size-3", resetMutation.isPending && "animate-spin")} />
                      Reset
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function formatInterval(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

export function SystemPage() {
  return (
    <div>
      <h2 className="text-lg font-semibold mb-5">System</h2>

      <Tabs defaultValue="config">
        <TabsList>
          <TabsTrigger value="config">Configuration</TabsTrigger>
          <TabsTrigger value="providers">Providers</TabsTrigger>
          <TabsTrigger value="pricing">Pricing</TabsTrigger>
          <TabsTrigger value="breakers">Circuit Breakers</TabsTrigger>
        </TabsList>
        <TabsContent value="config" className="space-y-4">
          <ConfigSection />
          <QuotaProbesSection />
        </TabsContent>
        <TabsContent value="providers">
          <ProvidersSection />
        </TabsContent>
        <TabsContent value="pricing">
          <PricingSection />
        </TabsContent>
        <TabsContent value="breakers">
          <BreakersSection />
        </TabsContent>
      </Tabs>
    </div>
  );
}
