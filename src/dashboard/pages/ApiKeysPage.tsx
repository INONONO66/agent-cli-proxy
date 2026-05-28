import React, { useCallback, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createApiKey, revokeApiKey, updateApiKey } from "../api";
import { useApiKeys, useApiKeyUsage, useProviders, useQuotas } from "../hooks/queries";
import type { ApiKey } from "../api";
import { Num } from "../utils/numbers";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

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
      />
      <div className="flex gap-3 flex-wrap">
        {props.providerOptions.map((provider) => (
          <div key={provider} className="flex items-center gap-1.5">
            <Checkbox
              id={`provider-${provider}`}
              checked={props.providers.includes(provider)}
              disabled={props.disabled}
              onCheckedChange={() => props.onProvidersChange(toggleSelection(props.providers, provider))}
            />
            <Label htmlFor={`provider-${provider}`} className="text-xs cursor-pointer">
              {provider}
            </Label>
          </div>
        ))}
      </div>
    </div>
  );
}

function UsageMetric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="font-mono text-lg font-semibold">{value}</div>
    </div>
  );
}

function KeyUsageRow({ keyId }: { keyId: number }) {
  const { data, isLoading } = useApiKeyUsage(keyId);

  if (isLoading) return <Skeleton className="h-3 w-2/5" />;

  return (
    <div className="flex gap-6 flex-wrap">
      <UsageMetric label="Requests" value={<Num value={data?.requestCount ?? 0} />} />
      <UsageMetric label="Tokens" value={<Num value={data?.totalTokens ?? 0} />} />
      <UsageMetric label="Cost" value={<Num value={data?.totalCostUsd ?? 0} format="cost" />} />
    </div>
  );
}

export function ApiKeysPage() {
  const { data, isLoading, error } = useApiKeys();
  const { data: providersData } = useProviders();
  const { data: quotasData } = useQuotas();
  const qc = useQueryClient();

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newAccounts, setNewAccounts] = useState("");
  const [newProviders, setNewProviders] = useState<string[]>([]);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [editingKey, setEditingKey] = useState<ApiKey | null>(null);
  const [editAccounts, setEditAccounts] = useState("");
  const [editProviders, setEditProviders] = useState<string[]>([]);
  const [actionError, setActionError] = useState("");

  const providerOptions = useMemo(() => {
    if (!providersData?.providers) return [];
    return providersData.providers.map((p) => p.id);
  }, [providersData]);

  const accountOptions = useMemo(() => {
    if (!quotasData?.snapshots) return [];
    const accounts = quotasData.snapshots
      .map((s) => s.account)
      .filter((a): a is string => typeof a === "string" && a.length > 0);
    return Array.from(new Set(accounts));
  }, [quotasData]);

  const createMutation = useMutation({
    mutationFn: ({ name, accounts, providers }: { name: string; accounts: string; providers: string[] }) =>
      createApiKey(name, { allowedAccounts: parseCsv(accounts), allowedProviders: providers }),
    onSuccess: (res) => {
      setCreatedKey(res.key);
      setNewName("");
      setNewAccounts("");
      setNewProviders([]);
      qc.invalidateQueries({ queryKey: ["api-keys"] });
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : "Failed to create key"),
  });

  const revokeMutation = useMutation({
    mutationFn: revokeApiKey,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["api-keys"] }),
    onError: (err) => setActionError(err instanceof Error ? err.message : "Failed to revoke key"),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, accounts, providers }: { id: number; accounts: string; providers: string[] }) =>
      updateApiKey(id, { allowedAccounts: parseCsv(accounts), allowedProviders: providers }),
    onSuccess: () => {
      setEditingKey(null);
      qc.invalidateQueries({ queryKey: ["api-keys"] });
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : "Failed to update key"),
  });

  const handleCreate = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const name = newName.trim();
      if (!name) return;
      setActionError("");
      createMutation.mutate({ name, accounts: newAccounts, providers: newProviders });
    },
    [newName, newAccounts, newProviders, createMutation],
  );

  const handleCopy = useCallback(async () => {
    if (!createdKey) return;
    try {
      await navigator.clipboard.writeText(createdKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard may not be available */ }
  }, [createdKey]);

  const openEdit = useCallback((key: ApiKey) => {
    setEditingKey(key);
    setEditAccounts((key.allowedAccounts ?? []).join(", "));
    setEditProviders(key.allowedProviders ?? []);
  }, []);

  const keys: ApiKey[] = data?.apiKeys ?? [];

  return (
    <div>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-5">
        <h2 className="text-lg font-semibold">API Keys</h2>
      </div>

      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{error instanceof Error ? error.message : "Failed to load keys"}</AlertDescription>
        </Alert>
      )}

      {actionError && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}

      <Card className="mb-5">
        <CardContent className="p-4">
          <form onSubmit={handleCreate} className="flex gap-3 items-start flex-wrap">
            <Input
              type="text"
              placeholder="Key name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              disabled={createMutation.isPending}
              className="min-w-[200px] flex-1"
            />
            <RestrictionEditor
              accounts={newAccounts}
              providers={newProviders}
              accountOptions={accountOptions}
              providerOptions={providerOptions}
              disabled={createMutation.isPending}
              onAccountsChange={setNewAccounts}
              onProvidersChange={setNewProviders}
            />
            <Button type="submit" disabled={createMutation.isPending || !newName.trim()}>
              {createMutation.isPending ? "Creating..." : "Create Key"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {isLoading && !data && (
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

      {keys.length === 0 && !isLoading && (
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
                      {key.revokedAt && <Badge variant="secondary" className="ml-2 text-[10px]">Revoked</Badge>}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{key.keyPrefix}***</TableCell>
                    <TableCell className="text-xs">{formatDate(key.createdAt)}</TableCell>
                    <TableCell className="text-xs">{key.lastUsedAt ? formatDate(key.lastUsedAt) : "—"}</TableCell>
                    <TableCell><Num value={key.requestCount} /></TableCell>
                    <TableCell className="text-xs">{formatRestriction(key.allowedAccounts)}</TableCell>
                    <TableCell className="text-xs">{formatRestriction(key.allowedProviders)}</TableCell>
                    <TableCell>
                      <div className="flex gap-1.5">
                        <Button variant="outline" size="xs" onClick={() => setExpandedId(expandedId === key.id ? null : key.id)} disabled={!!key.revokedAt}>
                          {expandedId === key.id ? "Hide" : "Usage"}
                        </Button>
                        {!key.revokedAt && (
                          <>
                            <Button variant="outline" size="xs" onClick={() => openEdit(key)}>Edit</Button>
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button variant="destructive" size="xs">Revoke</Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>Revoke API Key</AlertDialogTitle>
                                  <AlertDialogDescription>
                                    Revoke API key &ldquo;{key.name}&rdquo;? This cannot be undone.
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                                  <AlertDialogAction onClick={() => revokeMutation.mutate(key.id)}>Revoke</AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                  {expandedId === key.id && (
                    <TableRow>
                      <TableCell colSpan={8} className="p-0">
                        <div className="bg-muted/50 p-4 border-t">
                          <KeyUsageRow keyId={key.id} />
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

      <Dialog open={!!createdKey} onOpenChange={() => { setCreatedKey(null); setCopied(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>API Key Created</DialogTitle>
            <DialogDescription>Copy this key now. It will not be shown again.</DialogDescription>
          </DialogHeader>
          <div className="rounded-md border bg-muted/50 p-3 font-mono text-xs break-all">{createdKey}</div>
          <DialogFooter>
            <Button variant="outline" onClick={handleCopy} disabled={copied}>
              {copied ? "Copied!" : "Copy to Clipboard"}
            </Button>
            <Button onClick={() => { setCreatedKey(null); setCopied(false); }}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editingKey} onOpenChange={() => setEditingKey(null)}>
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
            disabled={updateMutation.isPending}
            onAccountsChange={setEditAccounts}
            onProvidersChange={setEditProviders}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingKey(null)} disabled={updateMutation.isPending}>Cancel</Button>
            <Button
              onClick={() => editingKey && updateMutation.mutate({ id: editingKey.id, accounts: editAccounts, providers: editProviders })}
              disabled={updateMutation.isPending}
            >
              {updateMutation.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
