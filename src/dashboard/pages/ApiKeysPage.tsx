import React, { useCallback, useState } from "react";
import {
  fetchApiKeys,
  createApiKey,
  revokeApiKey,
  fetchApiKeyUsage,
} from "../api";
import { usePolling } from "../hooks/usePolling";
import type { ApiKey, ApiKeyUsageResponse } from "../api";

export function ApiKeysPage() {
  const { data, loading, error, refresh } = usePolling(fetchApiKeys, 30000);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [usageById, setUsageById] = useState<Record<number, ApiKeyUsageResponse>>({});
  const [usageLoading, setUsageLoading] = useState<Record<number, boolean>>({});
  const [copied, setCopied] = useState(false);

  const handleCreate = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const name = newName.trim();
      if (!name) return;
      setCreating(true);
      try {
        const res = await createApiKey(name);
        setCreatedKey(res.key);
        setNewName("");
        refresh();
      } catch (err) {
        alert(err instanceof Error ? err.message : "Failed to create key");
      } finally {
        setCreating(false);
      }
    },
    [newName, refresh],
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
        <form onSubmit={handleCreate} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            type="text"
            placeholder="Key name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            disabled={creating}
            style={{ minWidth: 200, flex: 1 }}
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
                    <td>{key.requestCount}</td>
                    <td>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button onClick={() => toggleUsage(key.id)} disabled={!!key.revokedAt}>
                          {expandedId === key.id ? "Hide" : "Usage"}
                        </button>
                        {!key.revokedAt && (
                          <button className="danger" onClick={() => handleRevoke(key.id, key.name)}>
                            Revoke
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {expandedId === key.id && (
                    <tr>
                      <td colSpan={6} style={{ padding: 0 }}>
                        <div className="log-detail">
                          {usageLoading[key.id] ? (
                            <div className="skeleton skeleton-text" style={{ width: "40%" }} />
                          ) : (
                            <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
                              <div>
                                <div className="label" style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>
                                  Requests
                                </div>
                                <div className="value" style={{ fontFamily: "var(--font-mono)", fontSize: 18, fontWeight: 600 }}>
                                  {usageById[key.id]?.requestCount ?? 0}
                                </div>
                              </div>
                              <div>
                                <div className="label" style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>
                                  Tokens
                                </div>
                                <div className="value" style={{ fontFamily: "var(--font-mono)", fontSize: 18, fontWeight: 600 }}>
                                  {usageById[key.id]?.totalTokens ?? 0}
                                </div>
                              </div>
                              <div>
                                <div className="label" style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>
                                  Cost
                                </div>
                                <div className="value" style={{ fontFamily: "var(--font-mono)", fontSize: 18, fontWeight: 600 }}>
                                  ${(usageById[key.id]?.totalCostUsd ?? 0).toFixed(4)}
                                </div>
                              </div>
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
          onClick={closeModal}
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
              {createdKey}
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={handleCopy} disabled={copied}>
                {copied ? "Copied!" : "Copy to Clipboard"}
              </button>
              <button className="primary" onClick={closeModal}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}
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
