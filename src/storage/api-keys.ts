import { Database } from "bun:sqlite";

const textEncoder = new TextEncoder();

export namespace ApiKeyRepo {
  export interface CreatedApiKey {
    readonly id: number;
    readonly key: string;
    readonly keyPrefix: string;
    readonly name: string;
    readonly createdAt: string;
    readonly allowedAccounts: string[] | null;
    readonly allowedProviders: string[] | null;
  }

  export interface ListedApiKey {
    readonly id: number;
    readonly keyPrefix: string;
    readonly name: string;
    readonly createdAt: string;
    readonly revokedAt: string | null;
    readonly lastUsedAt: string | null;
    readonly requestCount: number;
    readonly allowedAccounts: string[] | null;
    readonly allowedProviders: string[] | null;
  }

  export interface FoundApiKey {
    readonly id: number;
    readonly name: string;
    readonly allowedProviders: string[] | null;
  }

  export interface FoundApiKeyFull extends FoundApiKey {
    readonly allowedAccounts: string[] | null;
  }

  export interface CreateOptions {
    readonly allowedAccounts?: readonly string[] | null;
    readonly allowedProviders?: readonly string[] | null;
  }

  export interface UpdateOptions {
    readonly allowedAccounts?: readonly string[] | null;
    readonly allowedProviders?: readonly string[] | null;
  }

  interface CreatedApiKeyRow {
    readonly id: number;
    readonly key_prefix: string;
    readonly name: string;
    readonly created_at: string;
    readonly allowed_accounts: string | null;
    readonly allowed_providers: string | null;
  }

  interface ListedApiKeyRow {
    readonly id: number;
    readonly key_prefix: string;
    readonly name: string;
    readonly created_at: string;
    readonly revoked_at: string | null;
    readonly last_used_at: string | null;
    readonly request_count: number;
    readonly allowed_accounts: string | null;
    readonly allowed_providers: string | null;
  }

  interface FoundApiKeyRow {
    readonly id: number;
    readonly name: string;
    readonly allowed_accounts: string | null;
    readonly allowed_providers: string | null;
  }

  export async function create(db: Database, name: string, opts: CreateOptions = {}): Promise<CreatedApiKey> {
    const key = generateKey();
    const keyHash = await sha256Hex(key);
    const keyPrefix = key.slice(0, 8);
    const allowedAccounts = serializeRestriction(opts.allowedAccounts);
    const allowedProviders = serializeRestriction(opts.allowedProviders);

    const insert = db.prepare(`
      INSERT INTO api_keys (key_hash, key_prefix, name, allowed_accounts, allowed_providers)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = insert.run(keyHash, keyPrefix, name, allowedAccounts, allowedProviders);
    const id = result.lastInsertRowid as number;

    const row = db.prepare(`
      SELECT id, key_prefix, name, created_at, allowed_accounts, allowed_providers
      FROM api_keys
      WHERE id = ?
    `).get(id) as CreatedApiKeyRow | null;

    if (!row) throw new Error("created API key row not found");
    return {
      id: row.id,
      key,
      keyPrefix: row.key_prefix,
      name: row.name,
      createdAt: row.created_at,
      allowedAccounts: parseRestriction(row.allowed_accounts),
      allowedProviders: parseRestriction(row.allowed_providers),
    };
  }

  export function list(db: Database): ListedApiKey[] {
    const stmt = db.prepare(`
      SELECT
        ak.id,
        ak.key_prefix,
        ak.name,
        ak.created_at,
        ak.revoked_at,
        ak.last_used_at,
        ak.allowed_accounts,
        ak.allowed_providers,
        COUNT(rl.id) AS request_count
      FROM api_keys ak
      LEFT JOIN request_logs rl ON rl.proxy_api_key_id = ak.id
      GROUP BY ak.id
      ORDER BY ak.created_at DESC, ak.id DESC
    `);

    return (stmt.all() as ListedApiKeyRow[]).map((row) => ({
      id: row.id,
      keyPrefix: row.key_prefix,
      name: row.name,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
      lastUsedAt: row.last_used_at,
      requestCount: Number(row.request_count),
      allowedAccounts: parseRestriction(row.allowed_accounts),
      allowedProviders: parseRestriction(row.allowed_providers),
    }));
  }

  export function update(db: Database, id: number, opts: UpdateOptions): boolean {
    const assignments: string[] = [];
    const params: (string | number | null)[] = [];

    if ("allowedAccounts" in opts) {
      assignments.push("allowed_accounts = ?");
      params.push(serializeRestriction(opts.allowedAccounts));
    }

    if ("allowedProviders" in opts) {
      assignments.push("allowed_providers = ?");
      params.push(serializeRestriction(opts.allowedProviders));
    }

    if (assignments.length === 0) return false;
    params.push(id);

    const stmt = db.prepare(`
      UPDATE api_keys
      SET ${assignments.join(", ")}
      WHERE id = ? AND revoked_at IS NULL
    `);
    return stmt.run(...params).changes > 0;
  }

  export function revoke(db: Database, id: number): boolean {
    const stmt = db.prepare(`
      UPDATE api_keys
      SET revoked_at = COALESCE(revoked_at, datetime('now'))
      WHERE id = ? AND revoked_at IS NULL
    `);
    return stmt.run(id).changes > 0;
  }

  export function findByHash(db: Database, keyHash: string): FoundApiKey | null {
    const stmt = db.prepare(`
      SELECT id, name, allowed_accounts, allowed_providers
      FROM api_keys
      WHERE key_hash = ? AND revoked_at IS NULL
    `);
    const row = stmt.get(keyHash) as FoundApiKeyRow | null;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      allowedProviders: parseRestriction(row.allowed_providers),
    };
  }

  export function findByHashFull(db: Database, keyHash: string): FoundApiKeyFull | null {
    const stmt = db.prepare(`
      SELECT id, name, allowed_accounts, allowed_providers
      FROM api_keys
      WHERE key_hash = ? AND revoked_at IS NULL
    `);
    const row = stmt.get(keyHash) as FoundApiKeyRow | null;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      allowedAccounts: parseRestriction(row.allowed_accounts),
      allowedProviders: parseRestriction(row.allowed_providers),
    };
  }

  export function findByIdAllowedAccounts(db: Database, id: number): { allowedAccounts: string[] | null } | null {
    const stmt = db.prepare("SELECT allowed_accounts FROM api_keys WHERE id = ? AND revoked_at IS NULL");
    const row = stmt.get(id) as { allowed_accounts: string | null } | null;
    if (!row) return null;
    return { allowedAccounts: parseRestriction(row.allowed_accounts) };
  }

  export async function findByKeyFull(db: Database, key: string): Promise<FoundApiKeyFull | null> {
    return findByHashFull(db, await sha256Hex(key));
  }

  export function touchLastUsed(db: Database, id: number): void {
    db.prepare(`
      UPDATE api_keys
      SET last_used_at = datetime('now')
      WHERE id = ?
    `).run(id);
  }

  export async function hashKey(key: string): Promise<string> {
    return sha256Hex(key);
  }
}

function serializeRestriction(values: readonly string[] | null | undefined): string | null {
  if (!values || values.length === 0) return null;
  const normalized = Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
  return normalized.length > 0 ? JSON.stringify(normalized) : null;
}

function parseRestriction(value: string | null): string[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return null;
    const normalized = parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    return normalized.length > 0 ? normalized : null;
  } catch {
    return null;
  }
}

function generateKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
