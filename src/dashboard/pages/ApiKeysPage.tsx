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
      <div className="content-header">
        <h2>API Keys</h2>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 20 }}>
        <form onSubmit={handleCreate} style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
          <input
            type="text"
            placeholder="Key name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            disabled={creating}
            style={{ minWidth: 200, flex: 1 }}
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
          <button type="submit" className="primary" disabled={creating || !newName.trim()}>
            {creating ? "Creating..." : "Create Key"}
          </button>
        </form>
      </div>

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

      {keys.length === 0 && !loading && (
        <div className="empty-state">No API keys yet.</div>
      )}

      {keys.length > 0 && (
        <div className="log-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Key Prefix</th>
                <th>Created</th>
                <th>Last Used</th>
                <th>Requests</th>
                <th>Allowed Accounts</th>
                <th>Allowed Providers</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <React.Fragment key={key.id}>
                  <tr className={key.revokedAt ? "disabled" : undefined} style={key.revokedAt ? { opacity: 0.5 } : undefined}>
                    <td>
                      <span style={{ fontWeight: 600 }}>{key.name}</span>
                      {key.revokedAt && (
                        <span
                          className="status-badge disabled"
                          style={{ marginLeft: 8, fontSize: 10, verticalAlign: "middle" }}
                        >
                          Revoked
                        </span>
                      )}
                    </td>
                    <td className="mono">{key.keyPrefix}***</td>
                    <td>{formatDate(key.createdAt)}</td>
                    <td>{key.lastUsedAt ? formatDate(key.lastUsedAt) : "—"}</td>
                    <td><Num value={key.requestCount} /></td>
                    <td>{formatRestriction(key.allowedAccounts)}</td>
                    <td>{formatRestriction(key.allowedProviders)}</td>
                    <td>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button onClick={() => toggleUsage(key.id)} disabled={!!key.revokedAt}>
                          {expandedId === key.id ? "Hide" : "Usage"}
                        </button>
                        {!key.revokedAt && (
                          <>
                            <button onClick={() => openEdit(key)}>Edit</button>
                            <button className="danger" onClick={() => handleRevoke(key.id, key.name)}>
                              Revoke
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                  {expandedId === key.id && (
                    <tr>
                      <td colSpan={8} style={{ padding: 0 }}>
                        <div className="log-detail">
                          {usageLoading[key.id] ? (
                            <div className="skeleton skeleton-text" style={{ width: "40%" }} />
                          ) : (
                            <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
                              <UsageMetric label="Requests" value={<Num value={usageById[key.id]?.requestCount ?? 0} />} />
                              <UsageMetric label="Tokens" value={<Num value={usageById[key.id]?.totalTokens ?? 0} />} />
                              <UsageMetric label="Cost" value={<Num value={usageById[key.id]?.totalCostUsd ?? 0} format="cost" />} />
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {createdKey && (
        <ApiKeyCreatedModal
          createdKey={createdKey}
          copied={copied}
          onClose={closeModal}
          onCopy={handleCopy}
        />
      )}

      {editingKey && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 100,
            padding: 24,
          }}
          onClick={closeEdit}
        >
          <div
            className="card"
            style={{ maxWidth: 560, width: "100%" }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginBottom: 12, fontSize: 16 }}>Edit API Key Restrictions</h3>
            <p style={{ color: "var(--text-secondary)", fontSize: 12, marginBottom: 12 }}>
              Empty accounts or providers means unrestricted.
            </p>
            <RestrictionEditor
              accounts={editAccounts}
              providers={editProviders}
              accountOptions={accountOptions}
              providerOptions={providerOptions}
              disabled={savingEdit}
              onAccountsChange={setEditAccounts}
              onProvidersChange={setEditProviders}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
              <button onClick={closeEdit} disabled={savingEdit}>Cancel</button>
              <button className="primary" onClick={handleSaveEdit} disabled={savingEdit}>
                {savingEdit ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
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
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 280 }}>
      <input
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
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {props.providerOptions.map((provider) => (
          <label key={provider} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
            <input
              type="checkbox"
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
      <div className="label" style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>
        {props.label}
      </div>
      <div className="value" style={{ fontFamily: "var(--font-mono)", fontSize: 18, fontWeight: 600 }}>
        {props.value}
      </div>
    </div>
  );
}

interface ApiKeyCreatedModalProps {
  readonly createdKey: string;
  readonly copied: boolean;
  readonly onClose: () => void;
  readonly onCopy: () => void;
}

function ApiKeyCreatedModal(props: ApiKeyCreatedModalProps) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
        padding: 24,
      }}
      onClick={props.onClose}
    >
      <div
        className="card"
        style={{ maxWidth: 520, width: "100%" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginBottom: 12, fontSize: 16 }}>API Key Created</h3>
        <p style={{ color: "var(--text-secondary)", fontSize: 12, marginBottom: 12 }}>
          Copy this key now. It will not be shown again.
        </p>
        <div
          style={{
            background: "var(--bg-primary)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: "10px 12px",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            wordBreak: "break-all",
            marginBottom: 12,
          }}
        >
          {props.createdKey}
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={props.onCopy} disabled={props.copied}>
            {props.copied ? "Copied!" : "Copy to Clipboard"}
          </button>
          <button className="primary" onClick={props.onClose}>
            Done
          </button>
        </div>
      </div>
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
