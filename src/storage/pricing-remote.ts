import { Logger } from "../util/logger";
import { setPricingAlias } from "./pricing-key";
import type { Pricing } from "./pricing";

type ModelPricing = Pricing.ModelPricing;
type PricingMap = Pricing.PricingMap;

type ModelsDevCost = {
  readonly input?: number;
  readonly output?: number;
  readonly cache_read?: number;
  readonly cache_write?: number;
  readonly reasoning?: number;
};

type ModelsDevModel = {
  readonly id?: string;
  readonly name?: string;
  readonly cost?: ModelsDevCost;
};

type ModelsDevProvider = {
  readonly models?: Record<string, ModelsDevModel>;
};

type OpenRouterModel = {
  readonly id?: string;
  readonly name?: string;
  readonly pricing?: {
    readonly prompt?: string | number;
    readonly completion?: string | number;
    readonly input_cache_read?: string | number;
    readonly input_cache_write?: string | number;
    readonly cache_read?: string | number;
    readonly cache_write?: string | number;
  };
};

const logger = Logger.fromConfig().child({ component: "pricing" });
const MODELS_DEV_URL = "https://models.dev/api.json";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

export async function fetchRemotePricing(): Promise<PricingMap> {
  try {
    const response = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      await consumeErrorBody(response);
      throw new Error(`models.dev returned HTTP ${response.status}`);
    }
    const raw = await response.json() as Record<string, ModelsDevProvider>;
    return buildPricingMap(raw);
  } catch (err) {
    logger.warn("models.dev pricing fetch failed, trying OpenRouter", { err, source: "models.dev" });
    return fetchOpenRouterPricing();
  }
}

async function fetchOpenRouterPricing(): Promise<PricingMap> {
  const response = await fetch(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    await consumeErrorBody(response);
    throw new Error(`OpenRouter returned HTTP ${response.status}`);
  }
  const raw = await response.json() as { readonly data?: readonly OpenRouterModel[] };
  const map: PricingMap = new Map();
  for (const model of raw.data ?? []) {
    const pricing = toOpenRouterPricing(model.pricing);
    if (!pricing || !model.id) continue;
    setPricingAlias(map, model.id, pricing);
    if (model.name) setPricingAlias(map, model.name, pricing);
    const slash = model.id.indexOf("/");
    if (slash >= 0 && slash < model.id.length - 1) setPricingAlias(map, model.id.slice(slash + 1), pricing);
  }
  logger.info("loaded pricing aliases", { aliases: map.size, source: "openrouter" });
  return map;
}

async function consumeErrorBody(response: Response): Promise<void> {
  await response.text().catch(async () => {
    await response.body?.cancel().catch(() => undefined);
  });
}

function toOpenRouterPricing(pricing: OpenRouterModel["pricing"]): ModelPricing | null {
  if (!pricing) return null;
  const input = openRouterTokenPrice(pricing.prompt);
  const output = openRouterTokenPrice(pricing.completion);
  if (input === null || output === null) return null;
  const result: ModelPricing = { input, output };
  const cacheRead = openRouterTokenPrice(pricing.input_cache_read ?? pricing.cache_read);
  if (cacheRead !== null) result.cache_read = cacheRead;
  const cacheWrite = openRouterTokenPrice(pricing.input_cache_write ?? pricing.cache_write);
  if (cacheWrite !== null) result.cache_write = cacheWrite;
  return result;
}

function openRouterTokenPrice(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed * 1_000_000;
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
  const pricing: ModelPricing = {
    input: cost.input,
    output: cost.output,
  };
  if (typeof cost.cache_read === "number") pricing.cache_read = cost.cache_read;
  if (typeof cost.cache_write === "number") pricing.cache_write = cost.cache_write;
  if (typeof cost.reasoning === "number") pricing.reasoning = cost.reasoning;
  return pricing;
}
