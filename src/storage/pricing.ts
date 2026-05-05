import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { Config } from "../config";
import { Logger } from "../util/logger";
import { Supervisor } from "../runtime/supervisor";

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

  type ModelsDevCost = {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
    reasoning?: number;
  };

  type ModelsDevModel = {
    id?: string;
    name?: string;
    cost?: ModelsDevCost;
  };

  type ModelsDevProvider = {
    models?: Record<string, ModelsDevModel>;
  };

  const MODELS_DEV_URL = "https://models.dev/api.json";

  let cache: CacheEntry | null = null;
  let inFlightFetch: Promise<PricingMap> | null = null;
  let bypassDiskCacheForTests = false;

  export async function fetchPricing(options: { force?: boolean } = {}): Promise<PricingMap> {
    const now = Date.now();
    if (!options.force && cache && now - cache.fetchedAt < Config.pricingCacheTtlMs) {
      return cache.data;
    }

    if (!options.force && inFlightFetch) {
      return inFlightFetch;
    }

    inFlightFetch = refreshPricing(options.force ?? false).finally(() => {
      inFlightFetch = null;
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

  export function __clearPricingForTests(): void {
    cache = null;
    inFlightFetch = null;
    bypassDiskCacheForTests = true;
  }

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
    if (provider && normalizeKey(provider) === "openai") {
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
      usage.cache_creation_tokens * (pricing.cache_write ?? pricing.input) +
      (usage.reasoning_tokens ?? 0) * (pricing.reasoning ?? pricing.output)
    ) / 1_000_000;
  }

  async function refreshPricing(force: boolean): Promise<PricingMap> {
    const now = Date.now();

    if (!force && !bypassDiskCacheForTests) {
      const diskCache = await readDiskCache();
      if (diskCache && now - diskCache.fetchedAt < Config.pricingCacheTtlMs) {
        cache = diskCache;
        return diskCache.data;
      }
    }

    try {
      const res = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`models.dev returned HTTP ${res.status}`);
      const raw = await res.json() as Record<string, ModelsDevProvider>;
      const map = buildPricingMap(raw);
      addLocalOverrides(map);
      cache = { data: map, fetchedAt: now };
      await writeDiskCache(cache);
      logger.info("loaded pricing aliases", { aliases: map.size, source: "models.dev" });
      return map;
    } catch (err) {
      logger.warn("pricing fetch failed, using cached data", { err, source: "models.dev" });
      if (cache) return cache.data;
      const diskCache = bypassDiskCacheForTests ? null : await readDiskCache();
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

  function buildPricingMap(raw: Record<string, ModelsDevProvider>): PricingMap {
    const map: PricingMap = new Map();
    for (const [provider, providerData] of Object.entries(raw)) {
      if (!providerData.models) continue;
      for (const [modelId, modelData] of Object.entries(providerData.models)) {
        if (!modelData.cost) continue;
        const pricing = toPricing(modelData.cost);
        if (!pricing) continue;

        setPricingAlias(map, modelId, pricing);
        setPricingAlias(map, `${provider}/${modelId}`, pricing);
        if (modelData.id) setPricingAlias(map, modelData.id, pricing);
        if (modelData.name) setPricingAlias(map, modelData.name, pricing);
      }
    }
    return map;
  }

  function toPricing(cost: ModelsDevCost): ModelPricing | null {
    if (typeof cost.input !== "number" || typeof cost.output !== "number") return null;
    return {
      input: cost.input,
      output: cost.output,
      cache_read: typeof cost.cache_read === "number" ? cost.cache_read : undefined,
      cache_write: typeof cost.cache_write === "number" ? cost.cache_write : undefined,
      reasoning: typeof cost.reasoning === "number" ? cost.reasoning : undefined,
    };
  }

  function addLocalOverrides(map: PricingMap): void {
    const overrides: Record<string, ModelPricing> = {
      "gpt-5.4": { input: 2.5, output: 15, cache_read: 0.25 },
      "gpt-5.4-mini": { input: 0.75, output: 4.5, cache_read: 0.075 },
      "gpt-5.4-mini-2026-03-17": { input: 0.75, output: 4.5, cache_read: 0.075 },
      "kimi-for-coding": { input: 0.4, output: 2.5, cache_read: 0.4 },
      "kimi-k2": { input: 0.4, output: 2.5, cache_read: 0.4 },
      "kimi-k2.6": { input: 0.95, output: 4, cache_read: 0.16 },
    };

    for (const [model, pricing] of Object.entries(overrides)) {
      setPricingAlias(map, model, pricing);
      setPricingAlias(map, `openai/${model}`, pricing);
    }
  }

  function setPricingAlias(map: PricingMap, key: string, pricing: ModelPricing): void {
    map.set(key, pricing);
    map.set(normalizeKey(key), pricing);
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
    if (normalizedModel === "kimi-for-coding") return "kimi-k2";
    if (normalizedModel.startsWith("gpt-5.4-mini")) return "gpt-5.4-mini";
    if (normalizedModel.startsWith("gpt-5.4")) return "gpt-5.4";
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

  function normalizeKey(key: string): string {
    return key.trim().toLowerCase().replace(/[_\s]+/g, "-");
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
