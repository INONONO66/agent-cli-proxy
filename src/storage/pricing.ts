import { Config } from "../config";

export namespace Pricing {
  export interface ModelPricing {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
  }

  export type PricingMap = Map<string, ModelPricing>;

  interface CacheEntry {
    data: PricingMap;
    fetchedAt: number;
  }

  let cache: CacheEntry | null = null;

  export async function fetchPricing(): Promise<PricingMap> {
    const now = Date.now();
    if (cache && now - cache.fetchedAt < Config.pricingCacheTtlMs) {
      return cache.data;
    }
    try {
      const res = await fetch("https://models.dev/api.json");
      const raw = await res.json() as Record<string, { models?: Record<string, { cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number } }> }>;
      const map: PricingMap = new Map();
      for (const [provider, providerData] of Object.entries(raw)) {
        if (!providerData.models) continue;
        for (const [modelId, modelData] of Object.entries(providerData.models)) {
          if (!modelData.cost) continue;
          map.set(`${provider}/${modelId}`, {
            input: modelData.cost.input ?? 0,
            output: modelData.cost.output ?? 0,
            cache_read: modelData.cost.cache_read,
            cache_write: modelData.cost.cache_write,
          });
          map.set(modelId, {
            input: modelData.cost.input ?? 0,
            output: modelData.cost.output ?? 0,
            cache_read: modelData.cost.cache_read,
            cache_write: modelData.cost.cache_write,
          });
        }
      }
      cache = { data: map, fetchedAt: now };
      return map;
    } catch (err) {
      console.warn("[pricing] fetch failed, using cached data:", err);
      if (cache) return cache.data;
      return new Map();
    }
  }

  export function getPricing(model: string): ModelPricing | null {
    if (!cache) return null;
    return cache.data.get(model) ?? null;
  }

  export function calculateCost(
    usage: { prompt_tokens: number; completion_tokens: number; cache_creation_tokens: number; cache_read_tokens: number },
    pricing: ModelPricing,
  ): number {
    return (
      usage.prompt_tokens * pricing.input +
      usage.completion_tokens * pricing.output +
      usage.cache_read_tokens * (pricing.cache_read ?? pricing.input) +
      usage.cache_creation_tokens * (pricing.cache_write ?? pricing.input)
    ) / 1_000_000;
  }
}
