import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, getFlagValue, writeEnvAtomic } from "../../src/cli";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function testEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.PROVIDERS_JSON;
  delete env.PROVIDERS_CONFIG_PATH;
  delete env.PLANS_JSON;
  delete env.PLANS_PATH;
  delete env.PROXY_LOCAL_OK;
  delete env.CLI_PROXY_API_URL;
  env.LOG_LEVEL = "error";
  return { ...env, ...overrides };
}

async function runCli(args: string[], env: Record<string, string> = testEnv()): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
    cwd: join(import.meta.dir, "..", ".."),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return {
    exitCode: await proc.exited,
    stdout,
    stderr,
  };
}

test("parseArgs handles positionals, flag-only, name=value, and name value", () => {
  const parsed = parseArgs(["plans", "show", "--json", "--env=/tmp/proxy.env", "--limit", "25"]);

  expect(parsed.positional).toEqual(["plans", "show"]);
  expect(parsed.flags.get("--json")).toBe(true);
  expect(getFlagValue(parsed, "--env")).toBe("/tmp/proxy.env");
  expect(getFlagValue(parsed, "--limit")).toBe("25");
});

test("parseArgs rejects flag values that start with another flag", () => {
  expect(() => parseArgs(["doctor", "--env=--runtime-dir"])).toThrow("must not start with --");

  const parsed = parseArgs(["doctor", "--env", "--runtime-dir", "foo"]);
  expect(() => getFlagValue(parsed, "--env")).toThrow("requires a value");
});

test("writeEnvAtomic force=false errors when target exists", async () => {
  const path = join(tempDir("agent-cli-proxy-cli-env-"), ".env");
  await Bun.write(path, "ADMIN_API_KEY=keep\n");

  await expect(writeEnvAtomic(path, { ADMIN_API_KEY: "new" }, { force: false })).rejects.toThrow("use --force");
  expect(readFileSync(path, "utf-8")).toContain("ADMIN_API_KEY=keep");
});

test("writeEnvAtomic force=true overwrites existing file", async () => {
  const path = join(tempDir("agent-cli-proxy-cli-env-"), ".env");
  await Bun.write(path, "ADMIN_API_KEY=old\n");

  await writeEnvAtomic(path, { ADMIN_API_KEY: "new", CLI_PROXY_API_KEY: "proxy" }, { force: true });

  const text = readFileSync(path, "utf-8");
  expect(text).toContain("ADMIN_API_KEY=new");
  expect(text).not.toContain("ADMIN_API_KEY=old");
});

test("writeEnvAtomic merge=true preserves existing values", async () => {
  const path = join(tempDir("agent-cli-proxy-cli-env-"), ".env");
  await Bun.write(path, "ADMIN_API_KEY=keep\nEXISTING=value\n");

  await writeEnvAtomic(path, { ADMIN_API_KEY: "new", CLI_PROXY_API_KEY: "proxy" }, { force: false, merge: true });

  const text = readFileSync(path, "utf-8");
  expect(text).toContain("ADMIN_API_KEY=keep");
  expect(text).toContain("EXISTING=value");
  expect(text).toContain("CLI_PROXY_API_KEY=proxy");
});

test("doctor returns 0 on healthy config", async () => {
  const dir = tempDir("agent-cli-proxy-doctor-ok-");
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/health") return new Response(null, { status: 200 });
      return new Response(null, { status: 404 });
    },
  });
  try {
    const envPath = join(dir, ".env");
    const dbPath = join(dir, "proxy.db");
    const pricingPath = join(dir, "pricing-cache.json");
    await Bun.write(pricingPath, "{}\n");
    await Bun.write(envPath, [
      `CLI_PROXY_API_URL=http://127.0.0.1:${server.port}`,
      `DB_PATH=${dbPath}`,
      `PRICING_CACHE_PATH=${pricingPath}`,
      "PROXY_LOCAL_OK=1",
    ].join("\n"));

    const result = await runCli(["doctor", "--env", envPath, "--json"], testEnv());

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe("PASS");
    expect(existsSync(dbPath)).toBe(true);
  } finally {
    await server.stop(true);
  }
});

test("doctor returns 1 on broken config", async () => {
  const dir = tempDir("agent-cli-proxy-doctor-bad-");
  const envPath = join(dir, ".env");
  await Bun.write(envPath, "PROXY_PORT=not-a-port\n");

  const result = await runCli(["doctor", "--env", envPath, "--json"], testEnv());

  expect(result.exitCode).toBe(1);
  const report = JSON.parse(result.stdout);
  expect(report.status).toBe("FAIL");
  expect(report.checks.config.issues.join(" ")).toContain("CLI_PROXY_API_URL");
});

test("plans path returns configured source", async () => {
  const path = join(tempDir("agent-cli-proxy-plans-path-"), "plans.json");
  await Bun.write(path, JSON.stringify({ plans: [] }));

  const result = await runCli(["plans", "path"], testEnv({ PLANS_PATH: path }));

  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe(path);
});

test("providers show masks auth values", async () => {
  const providers = JSON.stringify({
    providers: [{
      id: "secret-provider",
      type: "openai-compatible",
      paths: ["/v1/chat/completions"],
      upstreamBaseUrl: "https://example.com",
      auth: { type: "bearer", value: "super-secret-token", env: "IGNORED_SECRET_ENV" },
    }],
  });

  const result = await runCli(["providers", "show", "--json"], testEnv({
    CLI_PROXY_API_URL: "http://localhost:8317",
    PROVIDERS_JSON: providers,
  }));

  expect(result.exitCode).toBe(0);
  expect(result.stdout).not.toContain("super-secret-token");
  expect(result.stdout).toContain("[redacted]");
  expect(result.stdout).toContain("IGNORED_SECRET_ENV");
});
