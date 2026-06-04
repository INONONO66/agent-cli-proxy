export function normalizePricingKey(key: string): string {
  return key.trim().toLowerCase().replace(/[_\s]+/g, "-");
}

export function setPricingAlias<T>(map: Map<string, T>, key: string, value: T): void {
  map.set(key, value);
  map.set(normalizePricingKey(key), value);
}
