import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";

process.env.PROXY_LOCAL_OK = "1";
process.env.CLIPROXY_MGMT_KEY = "test-mgmt-key";

const { CLIProxyClient } = await import("../../src/cliproxy/client");
const { UpstreamClient } = await import("../../src/upstream/client");

beforeEach(() => {
  CLIProxyClient.resetUsageEndpointSupportForTests();
});

afterEach(() => {
  CLIProxyClient.resetUsageEndpointSupportForTests();
});

test("404 usage endpoint disables later correlation fetches", async () => {
  const fetchSpy = spyOn(UpstreamClient, "fetch").mockResolvedValue(new Response("not found", {
    status: 404,
    statusText: "Not Found",
  }));

  try {
    expect(await CLIProxyClient.fetchUsageFrom("http://localhost:8317/v0/management/usage", "test-mgmt-key")).toBeNull();
    expect(await CLIProxyClient.fetchUsageFrom("http://localhost:8317/v0/management/usage", "test-mgmt-key")).toBeNull();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0].url).toBe("http://localhost:8317/v0/management/usage");
  } finally {
    fetchSpy.mockRestore();
  }
});
