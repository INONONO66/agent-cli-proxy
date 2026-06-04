import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PROXY_LOCAL_OK = "1";
process.env.PRICING_CACHE_PATH = join(tmpdir(), `agent-cli-proxy-pricing-index-${crypto.randomUUID()}.json`);

const { Pricing } = await import("../../src/storage/pricing");

const unitPrice = { input: 1, output: 2 };
const providerPrice = { input: 3, output: 4 };

afterEach(() => {
  Pricing.__clearPricingForTests();
  rmSync(process.env.PRICING_CACHE_PATH ?? "", { force: true });
});

test("pricing lookup builds indexes for suffix matches and repeated misses", () => {
  const entries: Array<[string, typeof unitPrice]> = [
    ...Array.from({ length: 1_000 }, (_, index): [string, typeof unitPrice] => [`provider/model-${index}`, unitPrice]),
    ["models.dev/gpt-5-indexed", unitPrice],
  ];
  Pricing.__setPricingForTests(entries);

  const match = Pricing.findPricing("gpt-5-indexed");
  expect(match).toEqual({
    key: "models.dev/gpt-5-indexed",
    pricing: unitPrice,
    source: "fuzzy",
  });

  expect(Pricing.findPricing("missing-model", "openai")).toBeNull();
  expect(Pricing.findPricing("missing-model", "openai")).toBeNull();

  const stats = Pricing.__getLookupStatsForTests();
  expect(stats).toMatchObject({
    aliases: 1_001,
    misses: 1,
  });
  expect(stats?.normalized).toBeGreaterThanOrEqual(1_001);
  expect(stats?.fuzzyAny).toBeGreaterThanOrEqual(1_001);
  expect(stats?.fuzzyProvider).toBeGreaterThanOrEqual(1_001);
});

test("pricing suffix lookup keeps provider-scoped misses isolated", () => {
  Pricing.__setPricingForTests([["anthropic/shared-indexed-model", unitPrice]]);

  expect(Pricing.findPricing("shared-indexed-model", "openai")).toBeNull();
  expect(Pricing.findPricing("shared-indexed-model")).toMatchObject({
    key: "anthropic/shared-indexed-model",
    source: "fuzzy",
  });
});

test("pricing normalized lookup preserves original insertion order", () => {
  Pricing.__setPricingForTests([
    ["openai/GPT_5_Normalized", providerPrice],
    ["GPT_5_Normalized", unitPrice],
  ]);

  expect(Pricing.findPricing("gpt-5-normalized", "openai")).toEqual({
    key: "openai/GPT_5_Normalized",
    pricing: providerPrice,
    source: "normalized",
  });
});

test("pricing broad fuzzy lookup works without a provider", () => {
  Pricing.__setPricingForTests([
    ["sonnet-4", unitPrice],
    ["claude-sonnet-4", providerPrice],
  ]);

  expect(Pricing.findPricing("claude-sonnet-4-20250514")).toEqual({
    key: "sonnet-4",
    pricing: unitPrice,
    source: "fuzzy",
  });
});

test("pricing broad lookup matches indexed substrings without a provider", () => {
  Pricing.__setPricingForTests([
    ["unrelated-model", unitPrice],
    ["gpt-5.4", unitPrice],
  ]);

  expect(Pricing.findPricing("openai-gpt-5.4-preview")).toMatchObject({
    key: "gpt-5.4",
    source: "fuzzy",
  });
});

test("pricing broad lookup preserves first alias insertion order", () => {
  const laterPrice = { input: 3, output: 4 };
  Pricing.__setPricingForTests([
    ["gpt-5.4", unitPrice],
    ["openai-gpt-5.4-preview", laterPrice],
  ]);

  expect(Pricing.findPricing("openai-gpt-5.4-preview-extra")).toEqual({
    key: "gpt-5.4",
    pricing: unitPrice,
    source: "fuzzy",
  });
});
