import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { RequestInfo } from "../../src/server/request-inspector";
import type { UpstreamClient } from "../../src/upstream/client";
import type { Usage } from "../../src/usage";

process.env.CLI_PROXY_API_URL ??= "http://localhost:8317";

const { RequestInspector } = await import("../../src/server/request-inspector");
const { PassThroughProxy } = await import("../../src/server/pass-through");
const { Storage } = await import("../../src/storage/db");
const { UsageService } = await import("../../src/storage/service");
const { Pricing } = await import("../../src/storage/pricing");

const price = { input: 1, output: 1, cache_read: 1, cache_write: 1, reasoning: 1 };

Pricing.__setPricingForTests([
  ["openai/gpt-5.4-mini", price],
  ["gpt-5.4-mini", price],
]);

type FetchUpstream = (options: UpstreamClient.FetchOptions) => Promise<Response>;

function createHarness(fetch: FetchUpstream) {
  const db = Storage.initDb(":memory:");
  const usageService = UsageService.create(db);
  const handle = PassThroughProxy.create(usageService, { fetch });
  return { db, usageService, handle };
}

function request(path: string, body: Record<string, unknown>, headers: HeadersInit = {}): Request {
  return new Request(`http://proxy.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "opencode/1.0", ...headers },
    body: JSON.stringify(body),
  });
}

async function inspect(req: Request): Promise<RequestInfo> {
  return RequestInspector.inspect(req);
}

function latest(db: Database): Usage.RequestLog {
  return db.query("SELECT * FROM request_logs ORDER BY id DESC LIMIT 1").get() as Usage.RequestLog;
}

function allLogs(db: Database): Usage.RequestLog[] {
  return db.query("SELECT * FROM request_logs ORDER BY id ASC").all() as Usage.RequestLog[];
}

test("Content-Length above cap returns 502 and finalizes as error", async () => {
  const { db, handle } = createHarness(async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": String(60_000_000),
      },
    })
  );

  const req = request("/v1/chat/completions", { model: "gpt-5.4-mini", messages: [{ role: "user", content: "hi" }] });
  const res = await handle(req, await inspect(req));
  const body = await res.json() as { error: { type: string; message: string } };

  expect(res.status).toBe(502);
  expect(body.error.type).toBe("proxy_error");
  expect(body.error.message).toBe("upstream response too large");
  expect(allLogs(db)).toHaveLength(1);
  expect(latest(db)).toMatchObject({
    lifecycle_status: "error",
    error_code: "response_too_large",
    status: 502,
    incomplete: 1,
  });
});

test("body exceeding cap during read returns 502 and finalizes as error", async () => {
  const encoder = new TextEncoder();
  const chunk = "x".repeat(1024);
  let chunksSent = 0;
  const totalChunks = 60_000;

  const { db, handle } = createHarness(async () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          if (chunksSent >= totalChunks) {
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(chunk));
          chunksSent += 1;
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    )
  );

  const req = request("/v1/chat/completions", { model: "gpt-5.4-mini", messages: [{ role: "user", content: "hi" }] });
  const res = await handle(req, await inspect(req));
  const body = await res.json() as { error: { type: string; message: string } };

  expect(res.status).toBe(502);
  expect(body.error.type).toBe("proxy_error");
  expect(body.error.message).toBe("upstream response too large");
  expect(allLogs(db)).toHaveLength(1);
  expect(latest(db)).toMatchObject({
    lifecycle_status: "error",
    error_code: "response_too_large",
    status: 502,
    incomplete: 1,
  });
});

test("normal response under cap passes through unchanged", async () => {
  const { db, handle } = createHarness(async () =>
    new Response(JSON.stringify({ model: "gpt-5.4-mini", usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  );

  const req = request("/v1/chat/completions", { model: "gpt-5.4-mini", messages: [{ role: "user", content: "hi" }] });
  const res = await handle(req, await inspect(req));
  const body = await res.json() as { model: string; usage: { total_tokens: number } };

  expect(res.status).toBe(200);
  expect(body.model).toBe("gpt-5.4-mini");
  expect(body.usage.total_tokens).toBe(15);
  expect(allLogs(db)).toHaveLength(1);
  expect(latest(db)).toMatchObject({
    lifecycle_status: "completed",
    status: 200,
    total_tokens: 15,
    incomplete: 0,
  });
});
