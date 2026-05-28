import { join, normalize, resolve } from "node:path";

const host = process.env.DASHBOARD_HOST ?? "127.0.0.1";
const port = readPort(process.env.DASHBOARD_PORT, 3200);
const proxyBaseUrl = (process.env.DASHBOARD_PROXY_URL ?? "http://127.0.0.1:3100").replace(/\/+$/, "");
const adminToken = process.env.ADMIN_API_KEY?.trim() ?? "";
const sourceRoot = resolve("src/dashboard");
const distRoot = resolve("dist/dashboard");
const staticRoot = process.env.NODE_ENV === "production" ? distRoot : sourceRoot;

const server = Bun.serve({
  hostname: host,
  port,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) return proxyAdminRequest(req, url);
    if (url.pathname === "/assets/app.js" && process.env.NODE_ENV !== "production") return buildAppScript();
    return serveStatic(url.pathname);
  },
});

console.log(`dashboard listening at http://${server.hostname}:${server.port}`);
console.log(`dashboard proxy target ${proxyBaseUrl}`);

async function proxyAdminRequest(req: Request, url: URL): Promise<Response> {
  const upstreamPath = url.pathname.replace(/^\/api/, "") || "/";
  if (!isAllowedProxyPath(upstreamPath)) return json({ error: "Not found" }, 404);

  const session = isSessionPath(upstreamPath) || upstreamPath === "/health" || upstreamPath === "/ready"
    ? null
    : await readSession(req);
  if (session?.loginConfigured && !session.authenticated) return json({ error: "Forbidden", code: "LOGIN_REQUIRED" }, 403);

  const headers = new Headers(req.headers);
  headers.delete("host");
  if (adminToken && session?.loginConfigured === false && (upstreamPath.startsWith("/admin/") || upstreamPath === "/metrics")) {
    headers.set("x-admin-token", adminToken);
  }

  const upstream = await fetch(`${proxyBaseUrl}${upstreamPath}${url.search}`, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders(upstream.headers),
  });
}

function isAllowedProxyPath(path: string): boolean {
  return path === "/health" || path === "/ready" || path === "/metrics" || path.startsWith("/admin/");
}

function isSessionPath(path: string): boolean {
  return path === "/admin/session" || path === "/admin/session/login" || path === "/admin/session/logout";
}

async function readSession(req: Request): Promise<{ authenticated: boolean; loginConfigured: boolean }> {
  const headers = new Headers();
  const cookie = req.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);

  const res = await fetch(`${proxyBaseUrl}/admin/session`, { headers });
  if (!res.ok) return { authenticated: false, loginConfigured: true };
  const body = await res.json() as { authenticated?: unknown; loginConfigured?: unknown };
  return {
    authenticated: body.authenticated === true,
    loginConfigured: body.loginConfigured !== false,
  };
}

async function serveStatic(pathname: string): Promise<Response> {
  const filePath = safeJoin(staticRoot, pathname === "/" ? "index.html" : pathname.slice(1));
  if (!filePath) return new Response("Not Found", { status: 404 });

  const file = Bun.file(filePath);
  if (await file.exists()) return new Response(file, { headers: { "content-type": mimeType(filePath) } });

  const index = Bun.file(join(staticRoot, "index.html"));
  if (await index.exists()) return new Response(index, { headers: { "content-type": "text/html; charset=utf-8" } });
  return new Response("Dashboard not built", { status: 404 });
}

async function buildAppScript(): Promise<Response> {
  const output = await Bun.build({
    entrypoints: [join(sourceRoot, "app.ts")],
    target: "browser",
    minify: false,
  });
  if (!output.success) return json({ error: "dashboard app build failed" }, 500);
  return new Response(output.outputs[0], { headers: { "content-type": "application/javascript; charset=utf-8" } });
}

function safeJoin(root: string, relative: string): string | null {
  const normalized = normalize(relative).replace(/^(\.\.(?:\/|\\|$))+/, "");
  const resolved = resolve(root, normalized);
  return resolved.startsWith(`${root}/`) || resolved === root ? resolved : null;
}

function responseHeaders(headers: Headers): Headers {
  const next = new Headers(headers);
  next.delete("content-encoding");
  next.delete("content-length");
  next.set("cache-control", "no-store");
  return next;
}

function mimeType(path: string): string {
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

function readPort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
