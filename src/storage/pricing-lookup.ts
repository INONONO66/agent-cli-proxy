import { normalizePricingKey as normalizeKey } from "./pricing-key";

export interface PriceShape {
  input: number;
  output: number;
}

export interface LookupStats {
  normalized: number;
  fuzzyAny: number;
  fuzzyGeneric: number;
  fuzzyProvider: number;
  broad: number;
}

export interface PricingLookup<T extends PriceShape> {
  normalized: Map<string, IndexedPricing<T>>;
  fuzzyAny: Map<string, IndexedPricing<T>>;
  fuzzyGeneric: Map<string, IndexedPricing<T>>;
  fuzzyProvider: Map<string, IndexedPricing<T>>;
  broad: Map<string, IndexedPricing<T>>;
  broadPrefix: Map<string, Array<IndexedPricing<T>>>;
}

export interface IndexedPricing<T extends PriceShape> {
  key: string;
  normalizedKey: string;
  pricing: T;
  order: number;
}

export function buildPricingLookup<T extends PriceShape>(map: Map<string, T>): PricingLookup<T> {
  const lookup: PricingLookup<T> = {
    normalized: new Map(),
    fuzzyAny: new Map(),
    fuzzyGeneric: new Map(),
    fuzzyProvider: new Map(),
    broad: new Map(),
    broadPrefix: new Map(),
  };

  let order = 0;
  for (const [key, pricing] of map) {
    const normalizedKey = normalizeKey(key);
    const entry = { key, normalizedKey, pricing, order };
    setFirst(lookup.normalized, normalizedKey, entry);

    if (pricing.input !== 0 || pricing.output !== 0) {
      if (setFirst(lookup.broad, normalizedKey, entry) && normalizedKey.length >= 6) {
        addBroadPrefix(lookup.broadPrefix, entry);
      }
      const slash = normalizedKey.indexOf("/");
      if (slash >= 0 && slash < normalizedKey.length - 1) {
        const provider = normalizedKey.slice(0, slash);
        const model = normalizedKey.slice(slash + 1);
        setFirst(lookup.fuzzyProvider, `${provider}/${model}`, entry);
        setFirst(lookup.fuzzyAny, model, entry);
      } else {
        setFirst(lookup.fuzzyAny, normalizedKey, entry);
        setFirst(lookup.fuzzyGeneric, normalizedKey, entry);
      }
    }

    order += 1;
  }

  return lookup;
}

export function pricingLookupStats(lookup: PricingLookup<PriceShape>): LookupStats {
  return {
    normalized: lookup.normalized.size,
    fuzzyAny: lookup.fuzzyAny.size,
    fuzzyGeneric: lookup.fuzzyGeneric.size,
    fuzzyProvider: lookup.fuzzyProvider.size,
    broad: lookup.broad.size,
  };
}

export function findNormalizedPricing<T extends PriceShape>(
  lookup: PricingLookup<T>,
  normalizedModel: string,
  normalizedProvider: string | null,
): IndexedPricing<T> | null {
  const exact = lookup.normalized.get(normalizedModel) ?? null;
  if (!normalizedProvider) return exact;
  const provider = lookup.normalized.get(`${normalizedProvider}/${normalizedModel}`) ?? null;
  return firstByOrder(exact, provider);
}

export function findFuzzyPricing<T extends PriceShape>(
  lookup: PricingLookup<T>,
  normalizedModel: string,
  normalizedProvider: string | null,
): IndexedPricing<T> | null {
  if (!normalizedProvider) {
    const suffix = lookup.fuzzyAny.get(normalizedModel) ?? null;
    if (suffix) return suffix;
    return findBroadPricing(lookup, normalizedModel);
  }

  const generic = lookup.fuzzyGeneric.get(normalizedModel) ?? null;
  const provider = lookup.fuzzyProvider.get(`${normalizedProvider}/${normalizedModel}`) ?? null;
  const suffix = firstByOrder(generic, provider);
  if (suffix) return suffix;

  return findBroadPricing(lookup, normalizedModel);
}

function findBroadPricing<T extends PriceShape>(
  lookup: PricingLookup<T>,
  normalizedModel: string,
): IndexedPricing<T> | null {
  let match: IndexedPricing<T> | null = null;
  for (let start = 0; start <= normalizedModel.length - 6; start += 1) {
    const prefix = normalizedModel.slice(start, start + 6);
    const entries = lookup.broadPrefix.get(prefix);
    if (!entries) continue;
    for (const entry of entries) {
      if (normalizedModel.startsWith(entry.normalizedKey, start)) {
        match = firstByOrder(match, entry);
      }
    }
  }
  return match;
}

function addBroadPrefix<T extends PriceShape>(
  map: Map<string, Array<IndexedPricing<T>>>,
  entry: IndexedPricing<T>,
): void {
  const prefix = entry.normalizedKey.slice(0, 6);
  const entries = map.get(prefix);
  if (entries) {
    entries.push(entry);
    return;
  }
  map.set(prefix, [entry]);
}

function setFirst<T extends PriceShape>(
  map: Map<string, IndexedPricing<T>>,
  key: string,
  entry: IndexedPricing<T>,
): boolean {
  if (map.has(key)) return false;
  map.set(key, entry);
  return true;
}

function firstByOrder<T extends PriceShape>(
  left: IndexedPricing<T> | null,
  right: IndexedPricing<T> | null,
): IndexedPricing<T> | null {
  if (!left) return right;
  if (!right) return left;
  return left.order <= right.order ? left : right;
}
