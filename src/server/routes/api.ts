import type { Database } from "bun:sqlite";
import { loadSubscriptions } from "../../services/quotaPoller";

export function createApiRouter(db: Database) {
  return async function handleApiRequest(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // GET /api/overview
    if (path === "/api/overview" && method === "GET") {
      const today = new Date().toISOString().slice(0, 10);

      const totals = db.prepare(`
        SELECT 
          COUNT(*) as total_requests,
          COALESCE(SUM(total_tokens), 0) as total_tokens,
          COALESCE(SUM(cost_usd), 0) as total_cost_usd
        FROM request_logs
        WHERE DATE(started_at) = ?
      `).get(today) as Record<string, number>;

      const byAgentRows = db.prepare(`
        SELECT 
          COALESCE(agent, 'unknown') as agent,
          COUNT(*) as requests,
          COALESCE(SUM(total_tokens), 0) as tokens,
          COALESCE(SUM(cost_usd), 0) as cost_usd
        FROM request_logs
        WHERE DATE(started_at) = ?
        GROUP BY agent
      `).all(today) as Array<{agent: string; requests: number; tokens: number; cost_usd: number}>;

      const by_agent: Record<string, unknown> = {};
      for (const row of byAgentRows) {
        by_agent[row.agent] = { requests: row.requests, tokens: row.tokens, cost_usd: row.cost_usd };
      }

      const byModelRows = db.prepare(`
        SELECT 
          model,
          COUNT(*) as requests,
          COALESCE(SUM(total_tokens), 0) as tokens,
          COALESCE(SUM(cost_usd), 0) as cost_usd
        FROM request_logs
        WHERE DATE(started_at) = ?
        GROUP BY model
      `).all(today) as Array<{model: string; requests: number; tokens: number; cost_usd: number}>;

      const by_model: Record<string, unknown> = {};
      for (const row of byModelRows) {
        by_model[row.model] = { requests: row.requests, tokens: row.tokens, cost_usd: row.cost_usd };
      }

      const quotaRows = db.prepare(`
        SELECT provider, account, quota_type, used_pct, remaining, resets_at
        FROM quota_snapshots
        WHERE id IN (
          SELECT MAX(id) FROM quota_snapshots GROUP BY provider, account, quota_type
        )
        ORDER BY provider, account
      `).all() as Array<{provider: string; account: string; quota_type: string; used_pct: number; remaining: number; resets_at: string}>;

      const quota: Record<string, unknown[]> = {};
      for (const row of quotaRows) {
        if (!quota[row.provider]) quota[row.provider] = [];
        (quota[row.provider] as unknown[]).push(row);
      }

      return json({
        today: {
          date: today,
          total_requests: totals.total_requests,
          total_tokens: totals.total_tokens,
          total_cost_usd: totals.total_cost_usd,
          by_agent,
          by_model,
        },
        quota,
      });
    }

    // GET /api/agents
    if (path === "/api/agents" && method === "GET") {
      const rows = db.prepare(`
        SELECT 
          COALESCE(agent, 'unknown') as agent,
          COUNT(*) as total_requests,
          COALESCE(SUM(total_tokens), 0) as total_tokens,
          COALESCE(SUM(cost_usd), 0) as total_cost_usd,
          MAX(started_at) as last_seen
        FROM request_logs
        GROUP BY agent
        ORDER BY total_cost_usd DESC
      `).all() as Array<Record<string, unknown>>;
      return json(rows);
    }

    // GET /api/agents/:name
    const agentMatch = path.match(/^\/api\/agents\/([^/]+)$/);
    if (agentMatch && method === "GET") {
      const agentName = agentMatch[1];
      const summary = db.prepare(`
        SELECT 
          COALESCE(agent, 'unknown') as agent,
          COUNT(*) as total_requests,
          COALESCE(SUM(total_tokens), 0) as total_tokens,
          COALESCE(SUM(cost_usd), 0) as total_cost_usd
        FROM request_logs
        WHERE COALESCE(agent, 'unknown') = ?
      `).get(agentName) as Record<string, unknown>;

      const byModel = db.prepare(`
        SELECT model, COUNT(*) as requests, COALESCE(SUM(total_tokens), 0) as tokens, COALESCE(SUM(cost_usd), 0) as cost_usd
        FROM request_logs
        WHERE COALESCE(agent, 'unknown') = ?
        GROUP BY model
        ORDER BY cost_usd DESC
      `).all(agentName) as Array<Record<string, unknown>>;

      return json({ ...summary, by_model: byModel });
    }

    // GET /api/models
    if (path === "/api/models" && method === "GET") {
      const rows = db.prepare(`
        SELECT 
          model, provider,
          COUNT(*) as total_requests,
          COALESCE(SUM(total_tokens), 0) as total_tokens,
          COALESCE(SUM(cost_usd), 0) as total_cost_usd
        FROM request_logs
        GROUP BY model, provider
        ORDER BY total_cost_usd DESC
      `).all() as Array<Record<string, unknown>>;
      return json(rows);
    }

    // GET /api/history
    if (path === "/api/history" && method === "GET") {
      const range = url.searchParams.get("range") ?? "7d";
      const days = range === "30d" ? 30 : 7;
      const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      const to = new Date().toISOString().slice(0, 10);

      const rows = db.prepare(`
        SELECT 
          DATE(started_at) as date,
          COUNT(*) as total_requests,
          COALESCE(SUM(total_tokens), 0) as total_tokens,
          COALESCE(SUM(cost_usd), 0) as total_cost_usd
        FROM request_logs
        WHERE DATE(started_at) >= ? AND DATE(started_at) <= ?
        GROUP BY DATE(started_at)
        ORDER BY date DESC
      `).all(from, to) as Array<Record<string, unknown>>;
      return json(rows);
    }

    // GET /api/clients
    if (path === "/api/clients" && method === "GET") {
      const rows = db.prepare(`
        SELECT 
          COALESCE(source, 'proxy') as source,
          COUNT(*) as total_requests,
          COALESCE(SUM(total_tokens), 0) as total_tokens,
          COALESCE(SUM(cost_usd), 0) as total_cost_usd
        FROM request_logs
        GROUP BY source
        ORDER BY total_cost_usd DESC
      `).all() as Array<Record<string, unknown>>;
      return json(rows);
    }

    // GET /api/quota
    if (path === "/api/quota" && method === "GET") {
      const rows = db.prepare(`
        SELECT provider, account, quota_type, used_pct, remaining, resets_at, timestamp
        FROM quota_snapshots
        WHERE id IN (
          SELECT MAX(id) FROM quota_snapshots GROUP BY provider, account, quota_type
        )
        ORDER BY provider, account
      `).all() as Array<{provider: string; account: string; quota_type: string; used_pct: number; remaining: number; resets_at: string; timestamp: string}>;

      const result: Record<string, unknown[]> = {};
      for (const row of rows) {
        if (!result[row.provider]) result[row.provider] = [];
        (result[row.provider] as unknown[]).push({
          account: row.account,
          quota_type: row.quota_type,
          used_pct: row.used_pct,
          remaining_pct: row.used_pct != null ? Math.max(0, 100 - row.used_pct) : null,
          remaining: row.remaining,
          resets_at: row.resets_at,
          snapshot_at: row.timestamp,
        });
      }
      const subscriptions = loadSubscriptions();
      return json({ quotas: result, subscriptions });
    }

    // GET /api/quota/:provider
    const quotaMatch = path.match(/^\/api\/quota\/([^/]+)$/);
    if (quotaMatch && method === "GET") {
      const provider = quotaMatch[1];
      const rows = db.prepare(`
        SELECT account, quota_type, used_pct, remaining, resets_at, timestamp
        FROM quota_snapshots
        WHERE provider = ? AND id IN (
          SELECT MAX(id) FROM quota_snapshots WHERE provider = ? GROUP BY account, quota_type
        )
        ORDER BY account
      `).all(provider, provider) as Array<Record<string, unknown>>;
      return json({ provider, snapshots: rows });
    }

    // POST /api/ingest
    if (path === "/api/ingest" && method === "POST") {
      let records: Array<Record<string, unknown>>;
      try {
        records = await req.json() as Array<Record<string, unknown>>;
        if (!Array.isArray(records)) return json({ error: "Expected array" }, 400);
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }

      let inserted = 0;
      let skipped = 0;

      const stmt = db.prepare(`
        INSERT OR IGNORE INTO request_logs (
          provider, model, path, streamed, status,
          prompt_tokens, completion_tokens, cache_creation_tokens, cache_read_tokens,
          total_tokens, cost_usd, incomplete, started_at, finished_at,
          agent, source, msg_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const txn = db.transaction(() => {
        for (const r of records) {
          const result = stmt.run(
            String(r.provider ?? "unknown"),
            String(r.model ?? "unknown"),
            String(r.path ?? "/v1/messages"),
            0, 200,
            Number(r.prompt_tokens ?? 0),
            Number(r.completion_tokens ?? 0),
            0, 0,
            Number(r.prompt_tokens ?? 0) + Number(r.completion_tokens ?? 0),
            Number(r.cost_usd ?? 0),
            0,
            String(r.timestamp ?? new Date().toISOString()),
            String(r.timestamp ?? new Date().toISOString()),
            r.agent ? String(r.agent) : null,
            String(r.source ?? "mac-sync"),
            r.msg_id ? String(r.msg_id) : null
          );
          if (result.changes > 0) inserted++;
          else skipped++;
        }
      });
      txn();

      return json({ inserted, skipped });
    }

    return null;
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
