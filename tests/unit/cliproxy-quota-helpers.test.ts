import { afterEach, expect, spyOn, test } from "bun:test";

process.env.PROXY_LOCAL_OK = "1";

const { fetchJson } = await import("../../src/cliproxy/quota/helpers");
const { UpstreamClient } = await import("../../src/upstream/client");

let fetchSpy: ReturnType<typeof spyOn> | undefined;

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
});

function firstFetchRequest(): Parameters<typeof UpstreamClient.fetch>[0] {
  if (!fetchSpy) throw new Error("missing fetch spy");
  const call = fetchSpy.mock.calls[0];
  if (!call) throw new Error("expected upstream fetch call");
  return call[0];
}

test("fetchJson omits headers when RequestInit.headers is absent", async () => {
  fetchSpy = spyOn(UpstreamClient, "fetch").mockResolvedValue(new Response('{"ok":true}', {
    status: 200,
    headers: { "content-type": "application/json" },
  }));

  const result = await fetchJson("https://quota.example/api/limit", { method: "GET" });

  expect(result.ok).toBe(true);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  expect(firstFetchRequest()).not.toHaveProperty("headers");
});

test("fetchJson preserves headers when RequestInit.headers is present", async () => {
  fetchSpy = spyOn(UpstreamClient, "fetch").mockResolvedValue(new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  }));

  await fetchJson("https://quota.example/api/limit", {
    method: "POST",
    headers: { authorization: "Bearer test" },
    body: "{}",
  });

  expect(fetchSpy).toHaveBeenCalledTimes(1);
  expect(firstFetchRequest().headers).toEqual({ authorization: "Bearer test" });
});
