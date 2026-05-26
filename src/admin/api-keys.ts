import { Database } from "bun:sqlite";
import { ApiKeyRepo } from "../storage/api-keys";

export namespace ApiKeysAdmin {
  export function createRouter(db: Database) {
    return async function handleApiKeysAdmin(req: Request): Promise<Response | null> {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path === "/admin/api-keys" && req.method === "GET") {
        return json({ apiKeys: ApiKeyRepo.list(db) });
      }

      if (path === "/admin/api-keys" && req.method === "POST") {
        const csrf = requireCsrf(req);
        if (csrf) return csrf;

        const body = await readCreateBody(req);
        if (!body) return json({ error: "Invalid request body" }, 400);
        const name = body.name.trim();
        if (!name) return json({ error: "name is required" }, 400);

        return json(await ApiKeyRepo.create(db, name), 201);
      }

      const usageMatch = path.match(/^\/admin\/api-keys\/(\d+)\/usage$/);
      if (usageMatch && req.method === "GET") {
        return json(getUsage(db, Number(usageMatch[1])));
      }

      const keyMatch = path.match(/^\/admin\/api-keys\/(\d+)$/);
      if (keyMatch && req.method === "DELETE") {
        const csrf = requireCsrf(req);
        if (csrf) return csrf;

        const id = Number(keyMatch[1]);
        if (!ApiKeyRepo.revoke(db, id)) return json({ error: "Not found" }, 404);
        return json({ revokedAt: getRevokedAt(db, id) });
      }

      return null;
    };
  }

  interface CreateBody {
    readonly name: string;
  }

  interface UsageRow {
    readonly request_count: number;
    readonly total_tokens: number | null;
    readonly total_cost_usd: number | null;
  }

  interface RevokedAtRow {
    readonly revoked_at: string | null;
  }

  interface UsageResponse {
    readonly id: number;
    readonly requestCount: number;
    readonly totalTokens: number;
    readonly totalCostUsd: number;
  }

  function requireCsrf(req: Request): Response | null {
    if (req.headers.get("x-csrf") === "1") return null;
    return json({ error: "Forbidden" }, 403);
  }

  async function readCreateBody(req: Request): Promise<CreateBody | null> {
    let parsed: unknown;
    try {
      parsed = await req.json();
    } catch {
      return null;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const name = (parsed as Record<string, unknown>).name;
    if (typeof name !== "string") return null;
    return { name };
  }

  function getUsage(db: Database, id: number): UsageResponse {
    const stmt = db.prepare(`
      SELECT
        COUNT(*) AS request_count,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(cost_usd), 0) AS total_cost_usd
      FROM request_logs
      WHERE proxy_api_key_id = ?
    `);
    const row = stmt.get(id) as UsageRow;
    return {
      id,
      requestCount: Number(row.request_count ?? 0),
      totalTokens: Number(row.total_tokens ?? 0),
      totalCostUsd: Number(row.total_cost_usd ?? 0),
    };
  }

  function getRevokedAt(db: Database, id: number): string | null {
    const stmt = db.prepare("SELECT revoked_at FROM api_keys WHERE id = ?");
    const row = stmt.get(id) as RevokedAtRow | null;
    return row?.revoked_at ?? null;
  }

  function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json" },
    });
  }
}
