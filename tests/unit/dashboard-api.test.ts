import { afterEach, describe, expect, test } from "bun:test";
import { AuthError, api, login } from "../../src/dashboard/api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(response: Response): void {
  globalThis.fetch = Object.assign(async () => response, {
    preconnect: originalFetch.preconnect,
  }) as typeof fetch;
}

describe("dashboard api auth errors", () => {
  test("distinguishes login-not-configured responses", async () => {
    mockFetch(new Response(JSON.stringify({ error: "dashboard login not configured" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    }));

    await expect(login("secret")).rejects.toMatchObject({
      name: "AuthError",
      status: 403,
      code: "login_not_configured",
      message: "Dashboard login is not configured. Set DASHBOARD_PASSWORD_HASH to enable dashboard access.",
    });
  });

  test("preserves unauthorized API error details", async () => {
    mockFetch(new Response(JSON.stringify({ error: "invalid password" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }));

    await expect(api("/admin/session/login", { method: "POST" })).rejects.toMatchObject({
      name: "AuthError",
      status: 401,
      code: "unauthorized",
      message: "invalid password",
    });
  });

  test("keeps generic forbidden distinct from unauthorized", async () => {
    mockFetch(new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    }));

    try {
      await api("/admin/usage/today");
      throw new Error("expected request to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).status).toBe(403);
      expect((err as AuthError).code).toBe("forbidden");
      expect((err as AuthError).message).toBe("Forbidden");
    }
  });
});
