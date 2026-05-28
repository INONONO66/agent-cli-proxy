import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmod, mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CLI_PROXY_API_URL ??= "http://localhost:8317";
const { Session } = await import("../../src/admin/session");

const tempDirs: string[] = [];
const envSnapshot = new Map<string, string | undefined>();

function withTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix)).then((dir) => {
    tempDirs.push(dir);
    return dir;
  });
}

function setEnv(key: string, value: string | undefined): void {
  if (!envSnapshot.has(key)) envSnapshot.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function signWithNow(secret: string, now: number): Promise<string> {
  const nowSpy = spyOn(Date, "now").mockReturnValue(now);
  try {
    return await Session.signSession(secret);
  } finally {
    nowSpy.mockRestore();
  }
}

afterEach(async () => {
  for (const [key, value] of envSnapshot) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  envSnapshot.clear();

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("Session", () => {
  test("signSession produces a timestamp.signature token", async () => {
    const token = await Session.signSession("secret-key");

    expect(token).toMatch(/^\d+\.[A-Za-z0-9_-]+$/);
  });

  test("verifySession accepts a valid token", async () => {
    const token = await Session.signSession("secret-key");

    expect(await Session.verifySession(token, "secret-key", 60_000)).toBe(true);
  });

  test("verifySession rejects expired, tampered, future, and malformed tokens", async () => {
    const secret = "secret-key";
    const now = Date.now();
    const ttlMs = 60_000;

    const expiredToken = await signWithNow(secret, now - ttlMs - 1);
    expect(await Session.verifySession(expiredToken, secret, ttlMs)).toBe(false);

    const validToken = await Session.signSession(secret);
    const [issuedAt, signature] = validToken.split(".");
    expect(await Session.verifySession(`${issuedAt}.${signature}x`, secret, ttlMs)).toBe(false);

    const futureToken = await signWithNow(secret, now + 120_000);
    expect(await Session.verifySession(futureToken, secret, ttlMs)).toBe(false);

    for (const token of ["", "missing-dot", "one.two.three"]) {
      expect(await Session.verifySession(token, secret, ttlMs)).toBe(false);
    }
  });

  test("resolveSecret generates a secret file when missing", async () => {
    const dir = await withTempDir("agent-cli-proxy-session-");
    setEnv("DASHBOARD_SESSION_SECRET", undefined);
    const dbPath = join(dir, "proxy.db");
    const secretPath = join(dir, ".dashboard-session-secret");

    const secret = await Session.resolveSecret(dbPath);
    const fileSecret = (await readFile(secretPath, "utf-8")).trim();

    expect(secret).toBe(fileSecret);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    if (process.platform !== "win32") {
      expect((await stat(secretPath)).mode & 0o777).toBe(0o600);
    }
  });

  test("resolveSecret reads an existing secret file", async () => {
    const dir = await withTempDir("agent-cli-proxy-session-");
    setEnv("DASHBOARD_SESSION_SECRET", undefined);
    const dbPath = join(dir, "proxy.db");
    const secretPath = join(dir, ".dashboard-session-secret");
    await Bun.write(secretPath, "existing-secret\n");

    const secret = await Session.resolveSecret(dbPath);

    expect(secret).toBe("existing-secret");
  });

  test("resolveSecret tightens an existing secret file", async () => {
    const dir = await withTempDir("agent-cli-proxy-session-");
    setEnv("DASHBOARD_SESSION_SECRET", undefined);
    const dbPath = join(dir, "proxy.db");
    const secretPath = join(dir, ".dashboard-session-secret");
    await Bun.write(secretPath, "existing-secret\n");
    if (process.platform !== "win32") await chmod(secretPath, 0o644);

    const secret = await Session.resolveSecret(dbPath);

    expect(secret).toBe("existing-secret");
    if (process.platform !== "win32") {
      expect((await stat(secretPath)).mode & 0o777).toBe(0o600);
    }
  });

  test("resolveSecret replaces an existing empty secret file", async () => {
    const dir = await withTempDir("agent-cli-proxy-session-");
    setEnv("DASHBOARD_SESSION_SECRET", undefined);
    const dbPath = join(dir, "proxy.db");
    const secretPath = join(dir, ".dashboard-session-secret");
    await Bun.write(secretPath, "");
    if (process.platform !== "win32") await chmod(secretPath, 0o644);

    const secret = await Session.resolveSecret(dbPath);
    const fileSecret = (await readFile(secretPath, "utf-8")).trim();

    expect(secret).toBe(fileSecret);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    if (process.platform !== "win32") {
      expect((await stat(secretPath)).mode & 0o777).toBe(0o600);
    }
  });

  test("login ignores forwarded proto for Secure cookie unless proxy headers are trusted", async () => {
    const passwordHash = await Bun.password.hash("correct horse battery staple");
    const res = await Session.handleLogin(new Request("http://127.0.0.1/admin/session/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-proto": "https",
      },
      body: JSON.stringify({ password: "correct horse battery staple" }),
    }), {
      passwordHash,
      secret: "session-secret",
      ttlMs: 60_000,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).not.toContain("Secure");
  });
});
