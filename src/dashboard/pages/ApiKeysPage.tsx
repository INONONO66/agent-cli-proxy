import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchApiKeys,
  createApiKey,
  revokeApiKey,
  fetchApiKeyUsage,
  updateApiKey,
  getQuotas,
} from "../api";
import { usePolling } from "../hooks/usePolling";
import type { ApiKey, ApiKeyUsageResponse } from "../api";
import { Num } from "../utils/numbers";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const knownProviders = ["anthropic", "openai", "kimi", "xai"];
const fallbackAccounts = ["ino@timetreeapp.com", "openai.hatbox581@passmail.net"];

export function ApiKeysPage() {
  const { data, loading, error, refresh } = usePolling(fetchApiKeys, 30000);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newAccounts, setNewAccounts] = useState("");
  const [newProviders, setNewProviders] = useState<string[]>([]);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [usageById, setUsageById] = useState<Record<number, ApiKeyUsageResponse>>({});
  const [usageLoading, setUsageLoading] = useState<Record<number, boolean>>({});
  const [copied, setCopied] = useState(false);
  const [accountOptions, setAccountOptions] = useState<string[]>(fallbackAccounts);
  const [editingKey, setEditingKey] = useState<ApiKey | null>(null);
  const [editAccounts, setEditAccounts] = useState("");
  const [editProviders, setEditProviders] = useState<string[]>([]);
  const [savingEdit, setSavingEdit] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getQuotas()
      .then((res) => {
        if (cancelled) return;
        const accounts = res.snapshots
          .map((snapshot) => snapshot.account)
          .filter((account): account is string => typeof account === "string" && account.length > 0);
        setAccountOptions(Array.from(new Set([...fallbackAccounts, ...accounts])));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const providerOptions = useMemo(() => knownProviders, []);

  const handleCreate = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const name = newName.trim();
      if (!name) return;
      setCreating(true);
      try {
        const res = await createApiKey(name, {
          allowedAccounts: parseCsv(newAccounts),
          allowedProviders: newProviders,
        });
        setCreatedKey(res.key);
        setNewName("");
        setNewAccounts("");
        setNewProviders([]);
        refresh();
      } catch (err) {
        alert(err instanceof Error ? err.message : "Failed to create key");
      } finally {
        setCreating(false);
      }
    },
    [newAccounts, newName, newProviders, refresh],
  );

  const handleCopy = useCallback(async () => {
    if (!createdKey) return;
    try {
      await navigator.clipboard.writeText(createdKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }, [createdKey]);

  const closeModal = useCallback(() => {
    setCreatedKey(null);
    setCopied(false);
  }, []);

  const handleRevoke = useCallback(
    async (id: number, name: string) => {
      if (!window.confirm(`Revoke API key "${name}"? This cannot be undone.`)) return;
      try {
        await revokeApiKey(id);
        refresh();
      } catch (err) {
        alert(err instanceof Error ? err.message : "Failed to revoke key");
      }
    },
    [refresh],
  );

  const openEdit = useCallback((key: ApiKey) => {
    setEditingKey(key);
    setEditAccounts((key.allowedAccounts ?? []).join(", "));
    setEditProviders(key.allowedProviders ?? []);
  }, []);

  const closeEdit = useCallback(() => {
    setEditingKey(null);
    setEditAccounts("");
    setEditProviders([]);
  }, []);

  const handleSaveEdit = useCallback(async () => {
    if (!editingKey) return;
    setSavingEdit(true);
    try {
      await updateApiKey(editingKey.id, {
        allowedAccounts: parseCsv(editAccounts),
        allowedProviders: editProviders,
      });
      closeEdit();
      refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to update key");
    } finally {
      setSavingEdit(false);
    }
  }, [closeEdit, editAccounts, editProviders, editingKey, refresh]);

  const toggleUsage = useCallback(
    async (id: number) => {
      if (expandedId === id) {
        setExpandedId(null);
        return;
      }
      setExpandedId(id);
      if (usageById[id]) return;
      setUsageLoading((prev) => ({ ...prev, [id]: true }));
      try {
        const usage = await fetchApiKeyUsage(id);
        setUsageById((prev) => ({ ...prev, [id]: usage }));
      } catch (err) {
        alert(err instanceof Error ? err.message : "Failed to load usage");
      } finally {
        setUsageLoading((prev) => ({ ...prev, [id]: false }));
      }
    },
    [expandedId, usageById],
  );

  const keys: ApiKey[] = data?.apiKeys ?? [];

  return (
    <div>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-5">
        <h2 className="text-lg font-semibold">API Keys</h2>
      </div>

      {error && <div className="rounded-lg border border-destructive/50 bg-destructive/10 text-destructive p-3 text-sm mb-4">{error}</div>}

      <Card className="mb-5">
        <CardContent className="p-4">
          <form onSubmit={handleCreate} className="flex gap-3 items-start flex-wrap">
            <Input
              type="text"
              placeholder="Key name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              disabled={creating}
              className="min-w-[200px] flex-1"
            />
            <RestrictionEditor
              accounts={newAccounts}
              providers={newProviders}
              accountOptions={accountOptions}
              providerOptions={providerOptions}
              disabled={creating}
              onAccountsChange={setNewAccounts}
              onProvidersChange={setNewProviders}
            />
            <Button type="submit" disabled={creating || !newName.trim()}>
              {creating ? "Creating..." : "Create Key"}
            </Button>
          </form>
        </CardContent>
      </Card>

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

      {keys.length === 0 && !loading && (
        <div className="text-center text-muted-foreground py-12">No API keys yet.</div>
      )}

      {keys.length > 0 && (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Key Prefix</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Last Used</TableHead>
                <TableHead>Requests</TableHead>
                <TableHead>Allowed Accounts</TableHead>
                <TableHead>Allowed Providers</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((key) => (
                <React.Fragment key={key.id}>
                  <TableRow className={key.revokedAt ? "opacity-50" : undefined}>
                    <TableCell>
                      <span className="font-semibold">{key.name}</span>
                      {key.revokedAt && (
                        <Badge variant="secondary" className="ml-2 text-[10px]">Revoked</Badge>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{key.keyPrefix}***</TableCell>
                    <TableCell>{formatDate(key.createdAt)}</TableCell>
                    <TableCell>{key.lastUsedAt ? formatDate(key.lastUsedAt) : "—"}</TableCell>
                    <TableCell><Num value={key.requestCount} /></TableCell>
                    <TableCell>{formatRestriction(key.allowedAccounts)}</TableCell>
                    <TableCell>{formatRestriction(key.allowedProviders)}</TableCell>
                    <TableCell>
                      <div className="flex gap-1.5">
                        <Button variant="outline" size="xs" onClick={() => toggleUsage(key.id)} disabled={!!key.revokedAt}>
                          {expandedId === key.id ? "Hide" : "Usage"}
                        </Button>
                        {!key.revokedAt && (
                          <>
                            <Button variant="outline" size="xs" onClick={() => openEdit(key)}>Edit</Button>
                            <Button variant="destructive" size="xs" onClick={() => handleRevoke(key.id, key.name)}>
                              Revoke
                            </Button>
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                  {expandedId === key.id && (
                    <TableRow>
                      <TableCell colSpan={8} className="p-0">
                        <div className="bg-muted/50 p-4 border-t">
                          {usageLoading[key.id] ? (
                            <Skeleton className="h-3 w-2/5" />
                          ) : (
                            <div className="flex gap-6 flex-wrap">
                              <UsageMetric label="Requests" value={<Num value={usageById[key.id]?.requestCount ?? 0} />} />
                              <UsageMetric label="Tokens" value={<Num value={usageById[key.id]?.totalTokens ?? 0} />} />
                              <UsageMetric label="Cost" value={<Num value={usageById[key.id]?.totalCostUsd ?? 0} format="cost" />} />
                            </div>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </React.Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={!!createdKey} onOpenChange={() => closeModal()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>API Key Created</DialogTitle>
            <DialogDescription>Copy this key now. It will not be shown again.</DialogDescription>
          </DialogHeader>
          <div className="rounded-md border bg-muted/50 p-3 font-mono text-xs break-all">
            {createdKey}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={handleCopy} disabled={copied}>
              {copied ? "Copied!" : "Copy to Clipboard"}
            </Button>
            <Button onClick={closeModal}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editingKey} onOpenChange={() => closeEdit()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit API Key Restrictions</DialogTitle>
            <DialogDescription>Empty accounts or providers means unrestricted.</DialogDescription>
          </DialogHeader>
          <RestrictionEditor
            accounts={editAccounts}
            providers={editProviders}
            accountOptions={accountOptions}
            providerOptions={providerOptions}
            disabled={savingEdit}
            onAccountsChange={setEditAccounts}
            onProvidersChange={setEditProviders}
          />
          <DialogFooter>
            <Button variant="outline" onClick={closeEdit} disabled={savingEdit}>Cancel</Button>
            <Button onClick={handleSaveEdit} disabled={savingEdit}>
              {savingEdit ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface RestrictionEditorProps {
  readonly accounts: string;
  readonly providers: string[];
  readonly accountOptions: readonly string[];
  readonly providerOptions: readonly string[];
  readonly disabled: boolean;
  readonly onAccountsChange: (value: string) => void;
  readonly onProvidersChange: (value: string[]) => void;
}

function RestrictionEditor(props: RestrictionEditorProps) {
  return (
    <div className="flex flex-col gap-2 min-w-[280px]">
      <Input
        type="text"
        placeholder="Allowed accounts (comma-separated)"
        value={props.accounts}
        onChange={(e) => props.onAccountsChange(e.target.value)}
        disabled={props.disabled}
        list="api-key-account-options"
      />
      <datalist id="api-key-account-options">
        {props.accountOptions.map((account) => (
          <option key={account} value={account} />
        ))}
      </datalist>
      <div className="flex gap-2 flex-wrap">
        {props.providerOptions.map((provider) => (
          <label key={provider} className="flex items-center gap-1 text-xs cursor-pointer">
            <input
              type="checkbox"
              className="rounded border-input"
              checked={props.providers.includes(provider)}
              disabled={props.disabled}
              onChange={() => props.onProvidersChange(toggleSelection(props.providers, provider))}
            />
            {provider}
          </label>
        ))}
      </div>
    </div>
  );
}

interface UsageMetricProps {
  readonly label: string;
  readonly value: React.ReactNode;
}

function UsageMetric(props: UsageMetricProps) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{props.label}</div>
      <div className="font-mono text-lg font-semibold">{props.value}</div>
    </div>
  );
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function parseCsv(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function formatRestriction(values: readonly string[] | null): string {
  return values && values.length > 0 ? values.join(", ") : "All";
}

function toggleSelection(values: readonly string[], value: string): string[] {
  return values.includes(value)
    ? values.filter((item) => item !== value)
    : [...values, value];
}
