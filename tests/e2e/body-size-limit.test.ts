import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

const LIMIT = 100;

process.env.PROXY_LOCAL_OK ??= "1";
process.env.DB_PATH = ":memory:";

const { Handler } = await import("../../src/server/handler");
const { Storage } = await import("../../src/storage/db");
const { UsageService } = await import("../../src/storage/service");

let db: Database;
let handleRequest: (req: Request) => Promise<Response>;

beforeAll(() => {
  db = Storage.initDb(":memory:");
  handleRequest = Handler.create(UsageService.create(db), { maxRequestBodyBytes: LIMIT });
});

afterAll(() => {
  db.close();
});

test("content-length above the configured body limit returns 413 before pass-through", async () => {
  const res = await handleRequest(new Request("http://proxy.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(LIMIT + 1) },
    body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
  }));

  expect(res.status).toBe(413);
  expect(await res.json()).toEqual({ error: `request body exceeds ${LIMIT} bytes`, limit: LIMIT });
  expect(requestLogCount()).toBe(0);
});

test("streamed bodies without content-length are counted and rejected above the limit", async () => {
  const payload = JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "x".repeat(160) }] });

  const res = await handleRequest(new Request("http://proxy.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: chunkedBody(payload, 32),
  }));

  expect(res.status).toBe(413);
  expect(await res.json()).toEqual({ error: `request body exceeds ${LIMIT} bytes`, limit: LIMIT });
  expect(requestLogCount()).toBe(0);
});

function chunkedBody(text: string, chunkSize: number): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(text);
  let offset = 0;

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= encoded.byteLength) {
        controller.close();
        return;
      }

      const next = encoded.slice(offset, offset + chunkSize);
      offset += next.byteLength;
      controller.enqueue(next);
    },
  });
}

function requestLogCount(): number {
  const row = db.query("SELECT COUNT(*) AS count FROM request_logs").get() as { count: number };
  return row.count;
}
