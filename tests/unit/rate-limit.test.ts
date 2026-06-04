import { expect, test } from "bun:test";

test("per-client rate limit returns 429 before proxying repeated requests", async () => {
  const script = `
    process.env.PROXY_LOCAL_OK = "1";
    process.env.LOG_LEVEL = "error";
    process.env.RATE_LIMIT_PER_CLIENT_PER_MIN = "1";
    process.env.ADMIN_API_KEY = "admin-token";
    let upstreamCalls = 0;
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        upstreamCalls += 1;
        return new Response(JSON.stringify({ model: "gpt-4o", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    process.env.CLI_PROXY_API_URL = "http://127.0.0.1:" + upstream.port;
    const { Handler } = await import("./src/server/handler.ts");
    const { Storage } = await import("./src/storage/db.ts");
    const { UsageService } = await import("./src/storage/service.ts");
    const db = Storage.initDb(":memory:");
    const handle = Handler.create(UsageService.create(db));
    const localContext = { requestIP: () => ({ address: "127.0.0.1", port: 54321, family: "IPv4" }) };
    const body = JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
    const headers = { "content-type": "application/json", "user-agent": "opencode/1.0", "x-opencode-session": "opencode-session-a" };
    try {
      const first = await handle(new Request("http://proxy.test/v1/chat/completions", { method: "POST", headers, body }));
      if (first.status !== 200) throw new Error("expected first request to proxy, got " + first.status);
      await first.text();

      const second = await handle(new Request("http://proxy.test/v1/chat/completions", { method: "POST", headers, body }));
      if (second.status !== 429) throw new Error("expected second request to be rate limited, got " + second.status);
      if (second.headers.get("retry-after") !== "60") throw new Error("expected Retry-After 60");
      const payload = await second.json();
      if (payload.code !== "RATE_LIMITED") throw new Error("expected RATE_LIMITED code");
      if (upstreamCalls !== 1) throw new Error("rate limited request reached upstream");

      const metrics = await handle(new Request("http://127.0.0.1/metrics", {
        headers: { authorization: "Bearer admin-token" },
      }), localContext);
      const output = await metrics.text();
      if (!output.includes("agent_cli_proxy_rate_limited_total 1")) throw new Error("missing rate limit metric");
    } finally {
      upstream.stop(true);
      db.close();
    }
  `;
  const proc = Bun.spawn(["bun", "--eval", script], {
    cwd: process.cwd(),
    env: { ...process.env, PROXY_LOCAL_OK: "1", LOG_LEVEL: "error" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdoutText, stderrText] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  expect(`${stdoutText}${stderrText}`).toBe("");
  expect(exitCode).toBe(0);
});
