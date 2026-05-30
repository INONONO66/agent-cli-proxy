import { expect, test } from "bun:test";

process.env.CLI_PROXY_API_URL = "http://localhost:8317";

const { CanonicalProvider } = await import("../../src/provider");

test("canonical provider resolves namespaced Anthropic and OpenAI models", () => {
  expect(CanonicalProvider.fromModel("anthropic/claude-sonnet-4-6")).toBe("anthropic");
  expect(CanonicalProvider.fromModel("openai/gpt-5.4-mini")).toBe("openai");
});
