import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { Config } from "../config";
import { CanonicalProvider } from "../provider/canonical";
import { Logger } from "../util/logger";
import { Supervisor } from "../runtime/supervisor";
import { normalizePricingKey as normalizeKey, setPricingAlias } from "./pricing-key";
import { fetchRemotePricing } from "./pricing-remote";

const logger = Logger.fromConfig().child({ component: "pricing" });

export namespace Pricing {
  export interface ModelPricing {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
    reasoning?: number;
  }

  export interface PricingMatch {
    pricing: ModelPricing;
    key: string;
    source: "exact" | "alias" | "normalized" | "fuzzy" | "override";
  }

  export type PricingMap = Map<string, ModelPricing>;

  interface CacheEntry {
    data: PricingMap;
    fetchedAt: number;
  }

  let cache: CacheEntry | null = null;
  let inFlightFetch: Promise<PricingMap> | null = null;
  let inFlightState: { force: boolean; remoteAttempted: boolean } | null = null;
  let bypassDiskCacheForTests = false;
  let diskCacheReader: () => Promise<CacheEntry | null> = readDiskCache;
  let remotePricingFetcher: () => Promise<PricingMap> = fetchRemotePricing;

  export async function fetchPricing(options: { force?: boolean } = {}): Promise<PricingMap> {
    const now = Date.now();
    if (!options.force && cache && now - cache.fetchedAt < Config.pricingCacheTtlMs) {
      return cache.data;
    }

    const current = inFlightFetch;
    const currentState = inFlightState;
    if (current && currentState) {
      if (!options.force || currentState.force) return current;
      return current.then((data) => currentState.remoteAttempted ? data : fetchPricing({ force: true }));
    }

    const state = { force: options.force ?? false, remoteAttempted: false };
    inFlightState = state;
    inFlightFetch = refreshPricing(state.force, () => {
      state.remoteAttempted = true;
    }).finally(() => {
      if (inFlightState === state) { inFlightFetch = null; inFlightState = null; }
    });

    return inFlightFetch;
  }

  export function getPricing(model: string, provider?: string): ModelPricing | null {
    return findPricing(model, provider)?.pricing ?? null;
  }

  export async function getPricingFreshness(): Promise<{ fetchedAt: number; ageMs: number } | null> {
    const entry = cache ?? await readDiskCache();
    if (!entry) return null;
    return { fetchedAt: entry.fetchedAt, ageMs: Date.now() - entry.fetchedAt };
  }

  export function startBackgroundRefresh(options: { intervalMs?: number; signal?: AbortSignal } = {}): Supervisor.Handle {
    const intervalMs = options.intervalMs ?? Config.pricingRefreshIntervalMs;
    return Supervisor.run("pricing-refresh", async () => {
      await fetchPricing();
    }, {
      intervalMs,
      runOnStart: false,
      signal: options.signal,
    });
  }

  export function __setPricingForTests(entries: Array<[string, ModelPricing]>, fetchedAt: number = Date.now()): void {
    bypassDiskCacheForTests = false;
    cache = { data: new Map(entries), fetchedAt };
  }

  export function __clearPricingForTests(options: { bypassDiskCache?: boolean } = {}): void {
    cache = null; inFlightFetch = null; inFlightState = null;
    bypassDiskCacheForTests = options.bypassDiskCache ?? true;
    diskCacheReader = readDiskCache; remotePricingFetcher = fetchRemotePricing;
  }

  export function __setRemotePricingFetcherForTests(fetcher: () => Promise<PricingMap>): void { remotePricingFetcher = fetcher; }

  export function __setDiskCacheReaderForTests(reader: () => Promise<CacheEntry | null>): void { diskCacheReader = reader; }

  export function findPricing(model: string, provider?: string): PricingMatch | null {
    if (!cache) return null;
    const normalizedModel = normalizeKey(model);
    const normalizedProvider = provider ? normalizeKey(provider) : null;
    const candidates = buildLookupCandidates(model, provider);

    for (const key of candidates) {
      const pricing = cache.data.get(key);
      if (pricing) return { pricing, key, source: "exact" };
    }

    for (const [key, pricing] of cache.data) {
      if (normalizeKey(key) === normalizedModel) {
        return { pricing, key, source: "normalized" };
      }
      if (normalizedProvider && normalizeKey(key) === `${normalizedProvider}/${normalizedModel}`) {
        return { pricing, key, source: "normalized" };
      }
    }

    const alias = aliasModel(normalizedModel);
    if (alias) {
      for (const key of buildLookupCandidates(alias, provider)) {
        const pricing = cache.data.get(key);
        if (pricing) return { pricing, key, source: "alias" };
      }
    }

    const fuzzy = findFuzzyMatch(normalizedModel, normalizedProvider, cache.data);
    if (fuzzy) return fuzzy;

    return null;
  }

  export function calculateCost(
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
      cache_creation_tokens: number;
      cache_read_tokens: number;
      reasoning_tokens?: number;
    },
    pricing: ModelPricing,
    provider?: string,
  ): number {
    if (provider && CanonicalProvider.billingSemantics(provider) === "openai") {
      const billableInputTokens = Math.max(usage.prompt_tokens - usage.cache_read_tokens, 0);
      return (
        billableInputTokens * pricing.input +
        usage.completion_tokens * pricing.output +
        usage.cache_read_tokens * (pricing.cache_read ?? pricing.input)
      ) / 1_000_000;
    }

    return (
      usage.prompt_tokens * pricing.input +
      usage.completion_tokens * pricing.output +
      usage.cache_read_tokens * (pricing.cache_read ?? pricing.input) +
      usage.cache_creation_tokens * (pricing.cache_write ?? defaultCacheWritePrice(pricing, provider)) +
      (usage.reasoning_tokens ?? 0) * (pricing.reasoning ?? pricing.output)
    ) / 1_000_000;
  }

  function defaultCacheWritePrice(pricing: ModelPricing, provider?: string): number {
    if (provider && CanonicalProvider.billingSemantics(provider) === "anthropic") return pricing.input * 1.25;
    return pricing.input;
  }

  async function refreshPricing(force: boolean, markRemoteAttempt: () => void): Promise<PricingMap> {
    const now = Date.now();

    if (!force && !bypassDiskCacheForTests) {
      const diskCache = await diskCacheReader();
      if (diskCache && now - diskCache.fetchedAt < Config.pricingCacheTtlMs) {
        cache = diskCache;
        return diskCache.data;
      }
    }

    try {
      markRemoteAttempt();
      const map = await remotePricingFetcher();
      addLocalOverrides(map);
      cache = { data: map, fetchedAt: now };
      await writeDiskCache(cache);
      logger.info("loaded pricing aliases", { aliases: map.size, source: "remote" });
      return map;
    } catch (err) {
      logger.warn("pricing fetch failed, using cached data", { err, source: "models.dev" });
      if (cache) return cache.data;
      const diskCache = bypassDiskCacheForTests ? null : await diskCacheReader();
      if (diskCache) {
        cache = diskCache;
        return diskCache.data;
      }
      const fallback = new Map<string, ModelPricing>();
      addLocalOverrides(fallback);
      // Fetch failed before any usable disk cache existed. Keep local overrides
      // available, but mark them stale immediately so the next caller retries
      // models.dev instead of treating fallback pricing as fresh for the full TTL.
      cache = { data: fallback, fetchedAt: 0 };
      return fallback;
    }
  }

  function addLocalOverrides(map: PricingMap): void {
    for (const [model, pricing] of Object.entries(Config.pricingOverrides)) {
      setPricingAlias(map, model, pricing);
      setPricingAlias(map, `openai/${model}`, pricing);
    }
  }

  function buildLookupCandidates(model: string, provider?: string): string[] {
    const candidates = new Set<string>();
    candidates.add(model);
    candidates.add(normalizeKey(model));
    if (provider) {
      candidates.add(`${provider}/${model}`);
      candidates.add(`${normalizeKey(provider)}/${normalizeKey(model)}`);
    }
    return Array.from(candidates);
  }

  function aliasModel(normalizedModel: string): string | null {
    const aliases = Object.entries(Config.pricingAliases)
      .map(([prefix, target]) => [normalizeKey(prefix), target] as const)
      .sort(([left], [right]) => right.length - left.length);

    for (const [prefix, target] of aliases) {
      if (normalizedModel === prefix || normalizedModel.startsWith(prefix)) return target;
    }
    return null;
  }

  function findFuzzyMatch(
    normalizedModel: string,
    normalizedProvider: string | null,
    map: PricingMap,
  ): PricingMatch | null {
    const eligible = Array.from(map.entries()).filter(([key, pricing]) => {
      if (pricing.input === 0 && pricing.output === 0) return false;
      const normalizedKey = normalizeKey(key);
      if (normalizedProvider && !normalizedKey.startsWith(`${normalizedProvider}/`) && normalizedKey.includes("/")) {
        return false;
      }
      return normalizedKey.endsWith(`/${normalizedModel}`) || normalizedKey === normalizedModel;
    });

    if (eligible.length > 0) {
      const [key, pricing] = eligible[0];
      return { key, pricing, source: "fuzzy" };
    }

    const broad = Array.from(map.entries()).find(([key, pricing]) => {
      if (pricing.input === 0 && pricing.output === 0) return false;
      const normalizedKey = normalizeKey(key);
      return normalizedKey.length >= 6 && normalizedModel.includes(normalizedKey);
    });

    if (!broad) return null;
    return { key: broad[0], pricing: broad[1], source: "fuzzy" };
  }

  async function readDiskCache(): Promise<CacheEntry | null> {
    try {
      const file = Bun.file(Config.pricingCachePath);
      if (!(await file.exists())) return null;
      const parsed = await file.json() as { fetchedAt?: number; data?: [string, ModelPricing][] };
      if (typeof parsed.fetchedAt !== "number" || !Array.isArray(parsed.data)) return null;
      return { fetchedAt: parsed.fetchedAt, data: new Map(parsed.data) };
    } catch (err) {
      logger.warn("disk cache read failed", { err, path: Config.pricingCachePath });
      return null;
    }
  }

  async function writeDiskCache(entry: CacheEntry): Promise<void> {
    try {
      await mkdir(dirname(Config.pricingCachePath), { recursive: true });
      await Bun.write(
        Config.pricingCachePath,
        JSON.stringify({ fetchedAt: entry.fetchedAt, data: Array.from(entry.data.entries()) }),
      );
    } catch (err) {
      logger.warn("disk cache write failed", { err, path: Config.pricingCachePath });
    }
  }
}
