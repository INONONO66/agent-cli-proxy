import { describe, expect, test } from "bun:test";

const docPath = new URL("../../docs/cloudflare-exposure-plan.md", import.meta.url);

describe("Cloudflare exposure design doc", () => {
  test("covers required external exposure boundaries", async () => {
    const text = await Bun.file(docPath).text();

    for (const required of [
      "Tunnel-only path controls",
      "Worker facade design",
      "Cloudflare Tunnel",
      "Cloudflare Access service tokens",
      "Cf-Access-Jwt-Assertion",
      "PROXY_REQUIRE_API_KEY=true",
      "managed `x-proxy-key`",
      "compatibility presence gates",
      "deny `/admin/*`, `/dashboard/*`, and `/metrics`",
      "provenance-header normalization",
      "stripped/overwritten before origin",
      "keep `TRUST_PROXY_HEADERS=false`",
      "ADMIN_API_KEY",
      "TRUST_PROXY_HEADERS=true",
      "Follow-up implementation tasks",
    ]) {
      expect(text).toContain(required);
    }
  });

  test("keeps the plan design-only", async () => {
    const text = await Bun.file(docPath).text();

    expect(text).toContain("does not add Worker code");
    expect(text).toContain("Do not implement the Worker in this PR");
    expect(text).toContain("no new runtime dependency");
  });
});
