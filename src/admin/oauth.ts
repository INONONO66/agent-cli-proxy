import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { CLIProxyLogin } from "../cliproxy/login";
import { Logger } from "../util/logger";

const logger = Logger.fromConfig().child({ component: "admin.oauth" });
const tokenKeys = new Set(["access_token", "refresh_token", "id_token"]);

export namespace OAuthAdmin {
  export interface Config {
    readonly authDir: string;
    readonly binaryPath: string;
    readonly configPath: string;
    readonly timeoutMs: number;
  }

  export function createRouter(config: Config) {
    return async function handleOAuthAdmin(req: Request): Promise<Response | null> {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path === "/admin/oauth/accounts" && req.method === "GET") {
        return json({ accounts: await readAccounts(config.authDir) });
      }

      const startMatch = path.match(/^\/admin\/oauth\/([^/]+)\/start$/);
      if (startMatch && req.method === "POST") {
        const provider = decodeURIComponent(startMatch[1]);
        try {
          const removed = await removeProviderAuthFiles(config.authDir, provider);
          if (removed > 0) {
            logger.info("removed stale auth files before login", { event: "admin.oauth.cleanup", provider, removed });
          }
          const job = CLIProxyLogin.startJob(provider, config.binaryPath, config.configPath, config.timeoutMs);
          logger.info("oauth login job started", { event: "admin.oauth.start", provider, job_id: job.id });
          return json({ job_id: job.id, provider: job.provider, status: job.status });
        } catch (err) {
          if (err instanceof CLIProxyLogin.LoginJobError) return json({ error: err.message }, err.status);
          throw err;
        }
      }

      const eventsMatch = path.match(/^\/admin\/oauth\/jobs\/([^/]+)\/events$/);
      if (eventsMatch && req.method === "GET") {
        const jobId = decodeURIComponent(eventsMatch[1]);
        try {
          return sse(CLIProxyLogin.subscribe(jobId));
        } catch (err) {
          if (err instanceof CLIProxyLogin.LoginJobError) return json({ error: err.message }, err.status);
          throw err;
        }
      }

      const cancelMatch = path.match(/^\/admin\/oauth\/jobs\/([^/]+)\/cancel$/);
      if (cancelMatch && req.method === "POST") {
        const jobId = decodeURIComponent(cancelMatch[1]);
        const ok = CLIProxyLogin.cancelJob(jobId);
        if (!ok) return json({ error: "job not found" }, 404);
        return json({ ok: true });
      }

      return null;
    };
  }
}

async function removeProviderAuthFiles(authDir: string, provider: string): Promise<number> {
  if (!authDir) return 0;

  let entries: string[];
  try {
    entries = await readdir(authDir);
  } catch {
    return 0;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const filePath = join(authDir, entry);
    try {
      const raw = await Bun.file(filePath).text();
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed.type !== provider) continue;
      await unlink(filePath);
      removed++;
    } catch (err) {
      logger.warn("failed to remove auth file", { event: "admin.oauth.cleanup_error", file: entry, err });
    }
  }
  return removed;
}

async function readAccounts(authDir: string): Promise<unknown[]> {
  if (!authDir) return [];

  let entries: string[];
  try {
    entries = await readdir(authDir);
  } catch (err) {
    logger.warn("oauth auth directory unavailable", { event: "admin.oauth.auth_dir_unavailable", err });
    return [];
  }

  const accounts: unknown[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const filePath = join(authDir, entry);
    try {
      const parsed: unknown = JSON.parse(await Bun.file(filePath).text());
      accounts.push(withExpiryFlag(stripTokens(parsed)));
    } catch (err) {
      logger.warn("oauth account file skipped", { event: "admin.oauth.account_skip", file: entry, err });
    }
  }
  return accounts;
}

function stripTokens(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripTokens);
  if (!value || typeof value !== "object") return value;

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (tokenKeys.has(key)) continue;
    result[key] = stripTokens(entry);
  }
  return result;
}

function withExpiryFlag(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return {
    ...value,
    is_expired: isExpired(value as Record<string, unknown>),
  };
}

function isExpired(account: Record<string, unknown>): boolean {
  const expiresAt = account.expired ?? account.expires_at ?? account.expiry ?? account.expiresAt ?? account.expiration;
  const timestamp = typeof expiresAt === "number" ? expiresAt : typeof expiresAt === "string" ? Date.parse(expiresAt) : NaN;
  if (!Number.isFinite(timestamp)) return false;
  const expiresMs = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
  return expiresMs <= Date.now();
}

function sse(events: AsyncIterable<CLIProxyLogin.JobEvent>): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of events) {
          controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "event stream failed";
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ message })}\n\n`));
      } finally {
        controller.close();
      }
    },
  }), {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    },
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
