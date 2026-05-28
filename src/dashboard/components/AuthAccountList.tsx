import type { AuthAccount } from "../api";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

function resolveProvider(account: AuthAccount): string {
  return account.type ?? account.provider ?? "unknown";
}

function providerBadgeClass(provider: string): string {
  const p = provider.toLowerCase();
  if (p.includes("claude")) return "border-orange-500/50 text-orange-400";
  if (p.includes("codex")) return "border-emerald-500/50 text-emerald-400";
  if (p.includes("kimi")) return "border-blue-500/50 text-blue-400";
  if (p.includes("xai")) return "border-red-500/50 text-red-400";
  if (p.includes("google")) return "border-amber-500/50 text-amber-400";
  if (p.includes("antigravity")) return "border-yellow-500/50 text-yellow-400";
  return "border-muted-foreground/50 text-muted-foreground";
}

function expiryStatus(account: AuthAccount): { label: string; variant: "default" | "secondary" | "destructive" } {
  if (account.is_expired) return { label: "Expired", variant: "destructive" };

  const raw = account.expired ?? account.expires_at;
  if (!raw) return { label: "Active", variant: "default" };

  const ms = Date.parse(String(raw));
  if (!Number.isFinite(ms)) return { label: "Active", variant: "default" };

  const diff = ms - Date.now();
  if (diff <= 0) return { label: "Expired", variant: "destructive" };
  if (diff < 3600000) return { label: "Expiring Soon", variant: "secondary" };
  return { label: "Active", variant: "default" };
}

function formatRelativeTime(iso: string | undefined): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const diff = Date.now() - ms;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

interface AuthAccountListProps {
  accounts: AuthAccount[];
  onRefresh: (provider: string) => void;
}

export function AuthAccountList({ accounts, onRefresh }: AuthAccountListProps) {
  if (accounts.length === 0) {
    return (
      <div className="text-center text-muted-foreground py-12">No OAuth accounts configured.</div>
    );
  }

  const grouped = new Map<string, AuthAccount[]>();
  for (const account of accounts) {
    const provider = resolveProvider(account);
    const list = grouped.get(provider) ?? [];
    list.push(account);
    grouped.set(provider, list);
  }

  const providers = Array.from(grouped.keys()).sort();

  return (
    <div className="flex flex-col gap-6">
      {providers.map((provider, idx) => (
        <div key={provider}>
          {idx > 0 && <Separator className="mb-6" />}
          <div className="flex items-center gap-2 mb-3 text-sm font-semibold uppercase tracking-wide">
            <Badge variant="outline" className={cn("text-[11px]", providerBadgeClass(provider))}>
              {provider}
            </Badge>
            <span className="text-muted-foreground text-xs font-normal">
              {grouped.get(provider)?.length} account(s)
            </span>
          </div>
          <div className="flex flex-col gap-3">
            {grouped.get(provider)?.map((account, i) => {
              const st = expiryStatus(account);
              const email = account.email ?? "Unknown";
              const lastRefresh = account.last_refresh ?? account.refreshed_at;
              return (
                <Card key={account.email ?? i}>
                  <CardContent className="flex items-center justify-between gap-3 flex-wrap p-4">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium">{email}</div>
                      <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                        <Badge variant={st.variant} className="text-[10px] px-1.5 py-0">{st.label}</Badge>
                        {lastRefresh && (
                          <span>Last Refreshed: {formatRelativeTime(lastRefresh)}</span>
                        )}
                      </div>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => onRefresh(provider)}>
                      Refresh Login
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
