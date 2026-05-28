import { expect, test } from "bun:test";

test("dashboard shell exposes internal login surface without marketing hero", async () => {
  const html = await Bun.file("src/dashboard/index.html").text();

  expect(html).toContain("Admin login");
  expect(html).toContain("type=\"password\"");
  expect(html).not.toContain("Agent traffic, cost, and quota telemetry.");
});

test("dashboard server proxies admin session login", async () => {
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/admin/session/login") return new Response("not found", { status: 404 });
      const body = await req.json() as { password?: string };
      if (body.password !== "secret") return Response.json({ error: "invalid password" }, { status: 401 });
      return Response.json({ ok: true }, {
        headers: { "set-cookie": "__dashboard_session=test-session; HttpOnly; SameSite=Strict; Path=/" },
      });
    },
  });

  const dashboard = Bun.spawn(["bun", "run", "src/dashboard/server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DASHBOARD_PORT: "0",
      DASHBOARD_PROXY_URL: `http://127.0.0.1:${proxy.port}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  try {
    const url = await dashboardUrl(dashboard.stdout);
    const res = await fetch(`${url}/api/admin/session/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "secret" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("set-cookie")).toContain("__dashboard_session=test-session");
  } finally {
    dashboard.kill();
    await dashboard.exited.catch(() => undefined);
    proxy.stop(true);
  }
});

test("dashboard server requires session before proxying protected admin APIs", async () => {
  let protectedHits = 0;
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const authenticated = req.headers.get("cookie")?.includes("__dashboard_session=test-session") ?? false;
      if (url.pathname === "/admin/session") return Response.json({ authenticated, loginConfigured: true });
      if (url.pathname === "/admin/stats") {
        protectedHits++;
        if (req.headers.has("x-admin-token")) return Response.json({ error: "token bypass" }, { status: 500 });
        return authenticated ? Response.json({ total_requests: 1 }) : Response.json({ error: "Forbidden" }, { status: 403 });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const dashboard = Bun.spawn(["bun", "run", "src/dashboard/server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ADMIN_API_KEY: "admin-token",
      DASHBOARD_PORT: "0",
      DASHBOARD_PROXY_URL: `http://127.0.0.1:${proxy.port}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  try {
    const url = await dashboardUrl(dashboard.stdout);
    const blocked = await fetch(`${url}/api/admin/stats`);
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toEqual({ error: "Forbidden", code: "LOGIN_REQUIRED" });
    expect(protectedHits).toBe(0);

    const allowed = await fetch(`${url}/api/admin/stats`, {
      headers: { cookie: "__dashboard_session=test-session" },
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ total_requests: 1 });
    expect(protectedHits).toBe(1);
  } finally {
    dashboard.kill();
    await dashboard.exited.catch(() => undefined);
    proxy.stop(true);
  }
});

async function dashboardUrl(stdout: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stdout) throw new Error("dashboard stdout unavailable");
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    const result = await Promise.race([
      reader.read(),
      new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => setTimeout(() => resolve({ done: false, value: new Uint8Array() }), 50)),
    ]);
    if (result.done) break;
    text += decoder.decode(result.value, { stream: true });
    const match = text.match(/dashboard listening at (http:\/\/[^\s]+)/);
    if (match) return match[1];
  }

  throw new Error(`dashboard did not print listening URL: ${text}`);
}
