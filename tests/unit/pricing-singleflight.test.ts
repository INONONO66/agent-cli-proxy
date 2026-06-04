import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pricing as PricingTypes } from "../../src/storage/pricing";

process.env.PROXY_LOCAL_OK = "1";
process.env.PRICING_CACHE_PATH = join(tmpdir(), `agent-cli-proxy-pricing-singleflight-${crypto.randomUUID()}.json`);

type PricingModule = typeof import("../../src/storage/pricing");
type PricingMap = PricingTypes.PricingMap;

afterEach(() => {
  rmSync(process.env.PRICING_CACHE_PATH ?? "", { force: true });
});

test("forced pricing refresh shares an in-flight cold fetch", async () => {
  const Pricing = await importPricingForTest();
  Pricing.__clearPricingForTests();
  let modelsDevCalls = 0;
  const firstResponse = deferredPricingMap();

  Pricing.__setRemotePricingFetcherForTests(() => {
    modelsDevCalls += 1;
    return modelsDevCalls === 1
      ? firstResponse.promise
      : Promise.resolve(pricingMap("openai/gpt-5-singleflight"));
  });

  const first = Pricing.fetchPricing();
  await waitFor(() => modelsDevCalls === 1);
  const second = Pricing.fetchPricing({ force: true });

  await Promise.resolve();

  expect(modelsDevCalls).toBe(1);
  firstResponse.resolve(pricingMap("openai/gpt-5-singleflight"));

  const [firstMap, secondMap] = await Promise.all([first, second]);

  expect(firstMap.get("openai/gpt-5-singleflight")).toEqual({ input: 1, output: 2 });
  expect(secondMap).toBe(firstMap);
  expect(modelsDevCalls).toBe(1);
});

test("forced pricing refresh follows up when joined fetch only reads disk cache", async () => {
  const Pricing = await importPricingForTest();
  Pricing.__clearPricingForTests({ bypassDiskCache: false });
  let modelsDevCalls = 0;

  Pricing.__setDiskCacheReaderForTests(() => Promise.resolve({
    fetchedAt: Date.now(),
    data: new Map([["openai/gpt-5-disk-cache", { input: 9, output: 9 }]]),
  }));
  Pricing.__setRemotePricingFetcherForTests(() => {
    modelsDevCalls += 1;
    return Promise.resolve(pricingMap("openai/gpt-5-force-follow-up"));
  });

  const first = Pricing.fetchPricing();
  const second = Pricing.fetchPricing({ force: true });
  const [firstMap, secondMap] = await Promise.all([first, second]);

  expect(firstMap.get("openai/gpt-5-disk-cache")).toEqual({ input: 9, output: 9 });
  expect(secondMap.get("openai/gpt-5-force-follow-up")).toEqual({ input: 1, output: 2 });
  expect(modelsDevCalls).toBe(1);
});

async function importPricingForTest(): Promise<PricingModule["Pricing"]> {
  const module = await import(`../../src/storage/pricing.ts?pricing-singleflight=${crypto.randomUUID()}`) as PricingModule;
  return module.Pricing;
}

function deferredPricingMap(): {
  promise: Promise<PricingMap>;
  resolve: (map: PricingMap) => void;
} {
  let resolvePromise: ((map: PricingMap) => void) | undefined;
  const promise = new Promise<PricingMap>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(map) {
      if (!resolvePromise) throw new Error("deferred pricing map was not initialized");
      resolvePromise(map);
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for fetch to start");
    await Bun.sleep(5);
  }
}

function pricingMap(key: string): PricingMap {
  return new Map([[key, { input: 1, output: 2 }]]);
}
