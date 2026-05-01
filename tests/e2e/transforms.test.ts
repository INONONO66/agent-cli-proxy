import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { startMockCliProxyApi } from "./mockCliProxyApi";

const PROXY_PORT = 13101;
const MOCK_MODE = process.env.MOCK_CLI_PROXY === "1";

const CLI_PROXY_URL = process.env.CLI_PROXY_API_URL ?? "http://localhost:18317";
const MOCK_PORT = Number(new URL(CLI_PROXY_URL).port || "18317");

describe.if(MOCK_MODE)("E2E Transform Tests (mock mode)", () => {
  let mockServer: ReturnType<typeof startMockCliProxyApi>;
  let proxyServer: ReturnType<typeof Bun.serve>;

  beforeAll(async () => {
    process.env.DB_PATH = ":memory:";

    mockServer = startMockCliProxyApi(MOCK_PORT);

    const { Handler } = await import("../../src/server/handler");
    const { Storage } = await import("../../src/storage/db");
    const { UsageService } = await import("../../src/storage/service");
    const db = Storage.initDb(":memory:");
    const usageService = UsageService.create(db);
    const handleRequest = Handler.create(usageService);
    proxyServer = Bun.serve({ port: PROXY_PORT, idleTimeout: 0, fetch: handleRequest });
    await new Promise((r) => setTimeout(r, 100));
  });

  afterAll(async () => {
    mockServer.stop();
    proxyServer.stop(true);
    await new Promise((r) => setTimeout(r, 200));
  });

  const BASE = `http://localhost:${PROXY_PORT}`;

  it("Tool names are prefixed with mcp_ when sent to CLIProxyAPI", async () => {
    const prevLen = mockServer.receivedRequests.length;
    const res = await fetch(`${BASE}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 10,
        messages: [{ role: "user", content: "use bash" }],
        tools: [
          {
            name: "bash",
            description: "Run bash",
            input_schema: { type: "object", properties: { command: { type: "string" } } },
          },
        ],
      }),
    });
    await res.text();
    expect(mockServer.receivedRequests.length).toBeGreaterThan(prevLen);
    const lastReq = mockServer.receivedRequests[mockServer.receivedRequests.length - 1];
    const body = lastReq?.body as Record<string, unknown>;
    const tools = body?.tools as Array<{ name: string }>;
    expect(tools?.[0]?.name).toBe("mcp_Bash");
  });

  it("System prompt with OpenCode URL is sanitized", async () => {
    const prevLen = mockServer.receivedRequests.length;
    const res = await fetch(`${BASE}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 10,
        system: [{ type: "text", text: "Built with https://github.com/anomalyco/opencode. Be helpful." }],
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    await res.text();
    expect(mockServer.receivedRequests.length).toBeGreaterThan(prevLen);
    const lastReq = mockServer.receivedRequests[mockServer.receivedRequests.length - 1];
    const body = lastReq?.body as Record<string, unknown>;
    const systemText = JSON.stringify(body?.system ?? "");
    expect(systemText).not.toContain("anomalyco/opencode");
  });

  it("Claude Code identity is injected in system", async () => {
    const prevLen = mockServer.receivedRequests.length;
    const res = await fetch(`${BASE}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    await res.text();
    expect(mockServer.receivedRequests.length).toBeGreaterThan(prevLen);
    const lastReq = mockServer.receivedRequests[mockServer.receivedRequests.length - 1];
    const body = lastReq?.body as Record<string, unknown>;
    const systemText = JSON.stringify(body?.system ?? "");
    expect(systemText).toContain("Claude");
  });
});
