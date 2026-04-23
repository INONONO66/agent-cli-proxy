import { SignJWT, jwtVerify } from "jose";
import { Config } from "../config";

export namespace DashboardAuth {
  const encoder = new TextEncoder();

  function getSecret(): Uint8Array {
    return encoder.encode(Config.dashboardJwtSecret);
  }

  export function isConfigured(): boolean {
    return Config.dashboardPasswordHash !== "";
  }

  export async function verifyPassword(password: string): Promise<boolean> {
    if (!isConfigured()) return false;
    return Bun.password.verify(password, Config.dashboardPasswordHash);
  }

  export async function createToken(username: string): Promise<string> {
    return new SignJWT({ sub: username })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(Config.dashboardSessionTtl)
      .sign(getSecret());
  }

  export async function verifyToken(
    token: string,
  ): Promise<{ username: string } | null> {
    try {
      const { payload } = await jwtVerify(token, getSecret());
      if (typeof payload.sub === "string") {
        return { username: payload.sub };
      }
      return null;
    } catch {
      return null;
    }
  }

  export function extractToken(req: Request): string | null {
    const cookie = req.headers.get("cookie");
    if (!cookie) return null;
    const match = cookie.match(/(?:^|;\s*)dashboard_token=([^;]*)/);
    return match ? match[1] : null;
  }

  export function createAuthCookie(token: string): string {
    return `dashboard_token=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400`;
  }

  export function createClearCookie(): string {
    return "dashboard_token=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0";
  }

  export async function authMiddleware(
    req: Request,
  ): Promise<Response | null> {
    if (!isConfigured()) {
      return new Response(
        JSON.stringify({ error: "Dashboard not configured" }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    }

    const token = extractToken(req);
    if (!token) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }

    const user = await verifyToken(token);
    if (!user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }

    return null;
  }
}
