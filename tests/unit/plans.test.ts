import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Plans } from "../../src/plans";

const originalEnv = {
  PLANS_JSON: process.env.PLANS_JSON,
  PLANS_PATH: process.env.PLANS_PATH,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  HOME: process.env.HOME,
  LOG_LEVEL: process.env.LOG_LEVEL,
};

beforeEach(() => {
  delete process.env.PLANS_JSON;
  delete process.env.PLANS_PATH;
  delete process.env.XDG_CONFIG_HOME;
  process.env.HOME = "";
  process.env.LOG_LEVEL = "error";
  Plans.reload();
});

afterEach(() => {
  restoreEnv("PLANS_JSON", originalEnv.PLANS_JSON);
  restoreEnv("PLANS_PATH", originalEnv.PLANS_PATH);
  restoreEnv("XDG_CONFIG_HOME", originalEnv.XDG_CONFIG_HOME);
  restoreEnv("HOME", originalEnv.HOME);
  restoreEnv("LOG_LEVEL", originalEnv.LOG_LEVEL);
  Plans.reload();
});

function restoreEnv(key: keyof typeof originalEnv, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function plan(code: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    code,
    provider: "test-provider",
    display_name: `Test ${code}`,
    monthly_price_usd: 42,
    currency: "USD",
    billing_period_days: 30,
    vendor_url: "https://example.com/plans",
    notes: "Illustrative test metadata only.",
    ...overrides,
  };
}

function documentFor(...plans: Record<string, unknown>[]): string {
  return JSON.stringify({ plans });
}

async function writePlansFile(raw: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "agent-cli-proxy-plans-"));
  const path = join(dir, "plans.json");
  await Bun.write(path, raw);
  return path;
}

test("default load returns packaged plans", () => {
  const plans = Plans.list();

  expect(plans.length).toBeGreaterThan(0);
  expect(Plans.byCode("claude_pro")?.display_name).toBe("Anthropic Claude Pro");
});

test("PLANS_JSON inline env beats PLANS_PATH", async () => {
  process.env.PLANS_PATH = await writePlansFile(documentFor(plan("path_plan")));
  process.env.PLANS_JSON = documentFor(plan("inline_plan"));

  const plans = Plans.reload();

  expect(plans.map((entry) => entry.code)).toEqual(["inline_plan"]);
  expect(Plans.byCode("path_plan")).toBeNull();
});

test("PLANS_PATH beats XDG config and packaged default", async () => {
  const xdgHome = mkdtempSync(join(tmpdir(), "agent-cli-proxy-plans-xdg-"));
  const xdgDir = join(xdgHome, "agent-cli-proxy");
  mkdirSync(xdgDir, { recursive: true });
  await Bun.write(join(xdgDir, "plans.json"), documentFor(plan("xdg_plan")));
  process.env.XDG_CONFIG_HOME = xdgHome;
  process.env.PLANS_PATH = await writePlansFile(documentFor(plan("path_plan")));

  const plans = Plans.reload();

  expect(plans.map((entry) => entry.code)).toEqual(["path_plan"]);
  expect(Plans.byCode("xdg_plan")).toBeNull();
});

test("XDG config loads when env inline and path are absent", async () => {
  const xdgHome = mkdtempSync(join(tmpdir(), "agent-cli-proxy-plans-xdg-"));
  const xdgDir = join(xdgHome, "agent-cli-proxy");
  mkdirSync(xdgDir, { recursive: true });
  await Bun.write(join(xdgDir, "plans.json"), documentFor(plan("xdg_plan")));
  process.env.XDG_CONFIG_HOME = xdgHome;

  const plans = Plans.reload();

  expect(plans.map((entry) => entry.code)).toEqual(["xdg_plan"]);
});

test("unknown plan code returns null", () => {
  expect(Plans.byCode("unknown")).toBeNull();
});

test("reload observes changed file and env after cached load", async () => {
  const path = await writePlansFile(documentFor(plan("file_a")));
  process.env.PLANS_PATH = path;

  expect(Plans.reload().map((entry) => entry.code)).toEqual(["file_a"]);
  await Bun.write(path, documentFor(plan("file_b")));
  expect(Plans.list().map((entry) => entry.code)).toEqual(["file_a"]);
  expect(Plans.reload().map((entry) => entry.code)).toEqual(["file_b"]);

  process.env.PLANS_JSON = documentFor(plan("inline_c"));
  expect(Plans.list().map((entry) => entry.code)).toEqual(["file_b"]);
  expect(Plans.reload().map((entry) => entry.code)).toEqual(["inline_c"]);
});

test("invalid JSON falls back to packaged defaults", () => {
  process.env.PLANS_JSON = "{";

  const plans = Plans.reload();

  expect(plans.length).toBeGreaterThan(0);
  expect(Plans.byCode("claude_pro")).not.toBeNull();
});

test("invalid document shape falls back to packaged defaults", () => {
  process.env.PLANS_JSON = JSON.stringify({ plans: {} });

  const plans = Plans.reload();

  expect(plans.length).toBeGreaterThan(0);
  expect(Plans.byCode("claude_pro")).not.toBeNull();
});

test("invalid plan field path falls back to packaged defaults", () => {
  process.env.PLANS_JSON = documentFor(plan("bad_price", { monthly_price_usd: "20" }));

  const plans = Plans.reload();

  expect(plans.length).toBeGreaterThan(0);
  expect(Plans.byCode("bad_price")).toBeNull();
  expect(Plans.byCode("claude_pro")).not.toBeNull();
});

test("duplicate codes fall back to packaged defaults", () => {
  process.env.PLANS_JSON = documentFor(plan("dup"), plan("dup"));

  const plans = Plans.reload();

  expect(plans.length).toBeGreaterThan(0);
  expect(Plans.byCode("dup")).toBeNull();
});

test("default plans.default.json has at least 7 entries with all required fields", () => {
  const plans = Plans.list();

  expect(plans.length).toBeGreaterThanOrEqual(7);

  const requiredCodes = [
    "claude_pro",
    "claude_max5",
    "claude_max20",
    "chatgpt_plus",
    "chatgpt_pro",
    "chatgpt_business",
    "kimi_pro",
    "glm_pro",
    "local_byok",
  ];
  for (const code of requiredCodes) {
    const entry = Plans.byCode(code);
    expect(entry).not.toBeNull();
    if (!entry) continue;
    expect(typeof entry.code).toBe("string");
    expect(entry.code.length).toBeGreaterThan(0);
    expect(typeof entry.provider).toBe("string");
    expect(entry.provider.length).toBeGreaterThan(0);
    expect(typeof entry.display_name).toBe("string");
    expect(entry.display_name.length).toBeGreaterThan(0);
    expect(typeof entry.monthly_price_usd).toBe("number");
    expect(entry.monthly_price_usd).toBeGreaterThanOrEqual(0);
    expect(entry.currency).toBe("USD");
    expect(entry.billing_period_days).toBe(30);
    expect(typeof entry.notes).toBe("string");
    expect(entry.notes).toMatch(/verify with vendor/i);
  }
});

test("default plans.default.json codes are unique", () => {
  const plans = Plans.list();
  const codes = plans.map((p) => p.code);
  const uniqueCodes = new Set(codes);
  expect(uniqueCodes.size).toBe(codes.length);
});
