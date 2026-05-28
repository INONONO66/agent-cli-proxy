// Node fs promises are used here for exclusive-create, fsync, and atomic rename semantics for secret files.
import { chmod, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Logger } from "../util/logger";
import { Config } from "../config";
import { getClientIp, isRequestSecure } from "../util/proxy-headers";

const logger = Logger.fromConfig().child({ component: "admin.session" });
const COOKIE_NAME = "__dashboard_session";
const encoder = new TextEncoder();

const loginAttempts = new Map<string, { count: number; resetAt: number }>();

export namespace Session {
  interface RequestSecurityConfig {
    readonly trustProxyHeaders?: boolean;
  }

  export interface LoginConfig extends RequestSecurityConfig {
    readonly passwordHash: string;
    readonly secret: string;
    readonly ttlMs: number;
  }

  export interface CheckConfig extends RequestSecurityConfig {
    readonly passwordHash?: string;
    readonly secret: string;
    readonly ttlMs: number;
  }

  export async function resolveSecret(dbPath: string): Promise<string> {
    const configured = process.env.DASHBOARD_SESSION_SECRET?.trim();
    if (configured) return configured;

    const secretPath = join(dirname(dbPath), ".dashboard-session-secret");
    const existing = await readSecretFile(secretPath);
    if (existing) return existing;

    const secret = randomHex(32);
    await mkdir(dirname(secretPath), { recursive: true });
    try {
      await writeFile(secretPath, `${secret}\n`, { mode: 0o600, flag: "wx" });
    } catch (err) {
      if (!isAlreadyExistsError(err)) throw err;
      const raced = await readSecretFile(secretPath);
      if (raced) return raced;
      await replaceEmptySecretFile(secretPath, secret);
    }
    logger.info("dashboard session secret generated", { event: "dashboard.session_secret.generated" });
    return secret;
  }

  export async function signSession(secret: string): Promise<string> {
    const issuedAt = String(Date.now());
    const signature = await sign(issuedAt, secret);
    return `${issuedAt}.${signature}`;
  }

  export async function verifySession(token: string, secret: string, ttlMs: number): Promise<boolean> {
    const [issuedAtRaw, signature, extra] = token.split(".");
    if (!issuedAtRaw || !signature || extra !== undefined) return false;

    const issuedAt = Number(issuedAtRaw);
    if (!Number.isFinite(issuedAt) || issuedAt <= 0) return false;
    if (Date.now() - issuedAt > ttlMs) return false;
    if (issuedAt > Date.now() + 60_000) return false;

    const expected = await sign(issuedAtRaw, secret);
    return constantTimeEqual(signature, expected);
  }

  export async function handleLogin(req: Request, config: LoginConfig): Promise<Response> {
    if (!config.passwordHash) return json({ error: "dashboard login not configured", code: "LOGIN_NOT_CONFIGURED" }, 403);

    const clientIp = getClientIp(req, { trustProxyHeaders: config.trustProxyHeaders });
    if (isLoginRateLimited(clientIp)) {
      logger.warn("login rate limited", { event: "dashboard.login.rate_limited", ip: clientIp });
      return json({ error: "too many login attempts, try again later" }, 429);
    }

    const body = await readLoginBody(req);
    if (!body) return json({ error: "invalid password" }, 401);

    let ok = false;
    try {
      ok = await Bun.password.verify(body.password, config.passwordHash);
    } catch (err) {
      logger.warn("dashboard password verification failed", { event: "dashboard.login.verify_error", err });
    }

    if (!ok) {
      recordLoginAttempt(clientIp);
      return json({ error: "invalid password" }, 401);
    }

    clearLoginAttempts(clientIp);
    const token = await signSession(config.secret);
    const isSecure = isRequestSecure(req, { trustProxyHeaders: config.trustProxyHeaders });
    return json({ ok: true }, 200, {
      "set-cookie": buildCookie(token, Math.floor(config.ttlMs / 1000), isSecure),
    });
  }

  export function handleLogout(req: Request, config: RequestSecurityConfig = {}): Response {
    const isSecure = isRequestSecure(req, { trustProxyHeaders: config.trustProxyHeaders });
    return json({ ok: true }, 200, {
      "set-cookie": `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${isSecure ? "; Secure" : ""}`,
    });
  }

  export async function handleCheck(req: Request, config: CheckConfig): Promise<Response> {
    return json({
      authenticated: await extractSession(req, config.secret, config.ttlMs),
      loginConfigured: Boolean(config.passwordHash),
    });
  }

  export async function extractSession(req: Request, secret: string, ttlMs: number): Promise<boolean> {
    const token = readCookie(req.headers.get("cookie"), COOKIE_NAME);
    if (!token) return false;
    return verifySession(token, secret, ttlMs);
  }
}

interface LoginBody {
  readonly password: string;
}

async function readLoginBody(req: Request): Promise<LoginBody | null> {
  try {
    const body: unknown = await req.json();
    if (!body || typeof body !== "object") return null;
    const password = (body as Record<string, unknown>).password;
    return typeof password === "string" ? { password } : null;
  } catch {
    return null;
  }
}

async function sign(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return base64Url(new Uint8Array(signature));
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  let diff = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let i = 0; i < length; i++) {
    diff |= (leftBytes[i] ?? 0) ^ (rightBytes[i] ?? 0);
  }
  return diff === 0;
}

function randomHex(bytes: number): string {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return Array.from(values, (value) => value.toString(16).padStart(2, "0")).join("");
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [rawName, ...valueParts] = part.trim().split("=");
    if (rawName === name) return valueParts.join("=");
  }
  return null;
}

function buildCookie(token: string, maxAgeSeconds: number, isSecure: boolean): string {
  const secure = isSecure ? "; Secure" : "";
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${secure}`;
}

function isLoginRateLimited(ip: string): boolean {
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  if (Date.now() > entry.resetAt) {
    loginAttempts.delete(ip);
    return false;
  }
  return entry.count >= Config.loginRateLimitMaxAttempts;
}

function recordLoginAttempt(ip: string): void {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + Config.loginRateLimitWindowMs });
  } else {
    entry.count++;
  }
}

function clearLoginAttempts(ip: string): void {
  loginAttempts.delete(ip);
}

async function readSecretFile(path: string): Promise<string | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  const value = (await file.text()).trim();
  await chmodSecretFile(path);
  return value || null;
}

async function replaceEmptySecretFile(secretPath: string, secret: string): Promise<void> {
  const existing = await readSecretFile(secretPath);
  if (existing) return;

  const tempPath = join(dirname(secretPath), `.${basename(secretPath)}.${randomHex(8)}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(`${secret}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tempPath, secretPath);
  } catch (err) {
    if (handle) await handle.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

async function chmodSecretFile(path: string): Promise<void> {
  if (process.platform === "win32") return;
  await chmod(path, 0o600);
}

function isAlreadyExistsError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "EEXIST";
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}
