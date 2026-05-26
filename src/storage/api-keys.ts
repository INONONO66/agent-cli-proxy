import { Database } from "bun:sqlite";

const textEncoder = new TextEncoder();

export namespace ApiKeyRepo {
  export interface CreatedApiKey {
    readonly id: number;
    readonly key: string;
    readonly keyPrefix: string;
    readonly name: string;
    readonly createdAt: string;
  }

  export interface ListedApiKey {
    readonly id: number;
    readonly keyPrefix: string;
    readonly name: string;
    readonly createdAt: string;
    readonly revokedAt: string | null;
    readonly lastUsedAt: string | null;
    readonly requestCount: number;
  }

  export interface FoundApiKey {
    readonly id: number;
    readonly name: string;
  }

  interface CreatedApiKeyRow {
    readonly id: number;
    readonly key_prefix: string;
    readonly name: string;
    readonly created_at: string;
  }

  interface ListedApiKeyRow {
    readonly id: number;
    readonly key_prefix: string;
    readonly name: string;
    readonly created_at: string;
    readonly revoked_at: string | null;
    readonly last_used_at: string | null;
    readonly request_count: number;
  }

  interface FoundApiKeyRow {
    readonly id: number;
    readonly name: string;
  }

  export async function create(db: Database, name: string): Promise<CreatedApiKey> {
    const key = generateKey();
    const keyHash = await sha256Hex(key);
    const keyPrefix = key.slice(0, 8);

    const insert = db.prepare(`
      INSERT INTO api_keys (key_hash, key_prefix, name)
      VALUES (?, ?, ?)
    `);
    const result = insert.run(keyHash, keyPrefix, name);
    const id = result.lastInsertRowid as number;

    const row = db.prepare(`
      SELECT id, key_prefix, name, created_at
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
    }));
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
      SELECT id, name
      FROM api_keys
      WHERE key_hash = ? AND revoked_at IS NULL
    `);
    const row = stmt.get(keyHash) as FoundApiKeyRow | null;
    if (!row) return null;
    return { id: row.id, name: row.name };
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
