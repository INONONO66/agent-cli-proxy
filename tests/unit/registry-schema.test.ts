import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProviderDefinition } from "../../src/provider/registry-schema";

process.env.CLI_PROXY_API_URL = "http://localhost:8317";

const {
  ProviderRegistry,
  ProviderSchemaError,
  validateProviderInput,
} = await import("../../src/provider");

const originalProvidersJson = process.env.PROVIDERS_JSON;
const originalProvidersConfigPath = process.env.PROVIDERS_CONFIG_PATH;

afterEach(() => {
  restoreEnv("PROVIDERS_JSON", originalProvidersJson);
  restoreEnv("PROVIDERS_CONFIG_PATH", originalProvidersConfigPath);
  ProviderRegistry.forceReload();
});

function restoreEnv(key: "PROVIDERS_JSON" | "PROVIDERS_CONFIG_PATH", value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function validProvider(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "local",
    type: "openai-compatible",
    paths: ["/v1/chat/completions"],
    upstreamBaseUrl: "http://localhost:11434/",
    upstreamPath: "/v1/chat/completions",
    models: ["llama"],
    headers: { "x-local": "yes" },
    auth: { type: "bearer", env: "LOCAL_API_KEY", header: "authorization" },
    stripProviderField: true,
    ...overrides,
  };
}

function expectProviderSchemaError(fn: () => unknown): InstanceType<typeof ProviderSchemaError> {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderSchemaError);
    return err as InstanceType<typeof ProviderSchemaError>;
  }
  throw new Error("Expected ProviderSchemaError");
}

test("valid provider input normalizes and preserves supported fields", () => {
  const provider = validateProviderInput(validProvider());

  expect(provider).toMatchObject({
    id: "local",
    type: "openai-compatible",
    paths: ["/v1/chat/completions"],
    upstreamBaseUrl: "http://localhost:11434",
    upstreamPath: "/v1/chat/completions",
    models: ["llama"],
    headers: { "x-local": "yes" },
    auth: { type: "bearer", env: "LOCAL_API_KEY", header: "authorization" },
    stripProviderField: true,
  });
});

test("invalid provider input reports missing id path", () => {
  const input = validProvider();
  delete input.id;

  const err = expectProviderSchemaError(() => validateProviderInput(input));

  expect(err.issues).toContainEqual({ path: "provider.id", message: "must be a non-empty string" });
});

test("invalid provider input reports bad id type path", () => {
  const err = expectProviderSchemaError(() => validateProviderInput(validProvider({ id: 123 })));

  expect(err.issues.some((issue) => issue.path === "provider.id")).toBe(true);
});

test("invalid provider input reports bad upstreamBaseUrl path", () => {
  const err = expectProviderSchemaError(() => validateProviderInput(validProvider({ upstreamBaseUrl: "ftp://example.com" })));

  expect(err.issues).toContainEqual({ path: "provider.upstreamBaseUrl", message: "must be an http(s) URL" });
});

test("invalid provider input reports bad auth path without exposing value", () => {
  const err = expectProviderSchemaError(() => validateProviderInput(validProvider({
    auth: { type: "bearer", value: 123, header: "authorization" },
  })));

  expect(err.issues).toContainEqual({ path: "provider.auth.value", message: "must be a non-empty string" });
  expect(err.message).not.toContain("123");
});

test("registry drops corrupt custom entries while retaining built-ins and valid custom entries", () => {
  process.env.PROVIDERS_JSON = JSON.stringify({
    providers: [
      validProvider({ id: "local" }),
      validProvider({ id: "corrupt", upstreamBaseUrl: "not a url" }),
    ],
  });
  delete process.env.PROVIDERS_CONFIG_PATH;

  const providers = ProviderRegistry.forceReload();
  const ids = providers.map((provider: ProviderDefinition) => provider.id);

  expect(ids).toEqual(expect.arrayContaining(["anthropic", "openai", "local"]));
  expect(ids).not.toContain("corrupt");
  expect(ProviderRegistry.handlesPath("/v1/messages")).toBe(true);
  expect(ProviderRegistry.resolve({ path: "/v1/chat/completions", provider: "local" })?.id).toBe("local");
});

test("registry forceReload rereads PROVIDERS_CONFIG_PATH content", async () => {
  delete process.env.PROVIDERS_JSON;
  const dir = mkdtempSync(join(tmpdir(), "agent-cli-proxy-registry-"));
  const configPath = join(dir, "providers.json");
  process.env.PROVIDERS_CONFIG_PATH = configPath;

  await Bun.write(configPath, JSON.stringify({ providers: [validProvider({ id: "file-a" })] }));
  expect(ProviderRegistry.forceReload().map((provider: ProviderDefinition) => provider.id)).toContain("file-a");

  await Bun.write(configPath, JSON.stringify({ providers: [validProvider({ id: "file-b" })] }));
  expect(ProviderRegistry.loadProviders().map((provider: ProviderDefinition) => provider.id)).toContain("file-a");
  const reloadedIds = ProviderRegistry.forceReload().map((provider: ProviderDefinition) => provider.id);

  expect(reloadedIds).toContain("file-b");
  expect(reloadedIds).not.toContain("file-a");
});
