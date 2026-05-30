// Canonical provider resolver — single source of truth for model → provider mapping.
// Replaces hardcoded MODEL_PROVIDER_OVERRIDES, service.ts provider remap, and
// pricing.ts provider special-casing scattered across the codebase.

import { ProviderRegistry } from "./registry";

export namespace CanonicalProvider {
  export type BillingSemantics = "anthropic" | "openai";

  interface PrefixRule {
    readonly prefix: string;
    readonly provider: string;
  }

  // Default prefix→provider rules. Longest-prefix-first ordering is enforced at
  // load time. Rules from ProviderRegistry.all() model lists are merged in so
  // custom providers participate without code changes.
  const defaultRules: PrefixRule[] = [
    { prefix: "claude", provider: "anthropic" },
    { prefix: "gpt-", provider: "openai" },
    { prefix: "o1", provider: "openai" },
    { prefix: "o3", provider: "openai" },
    { prefix: "o4", provider: "openai" },
    { prefix: "chatgpt", provider: "openai" },
    { prefix: "grok", provider: "xai" },
    { prefix: "kimi", provider: "kimi" },
    { prefix: "k2", provider: "kimi" },
    { prefix: "glm", provider: "glm" },
    { prefix: "minimax", provider: "minimax" },
  ];

  let cachedRules: PrefixRule[] | null = null;

  function buildRules(): PrefixRule[] {
    const ruleMap = new Map<string, string>();

    for (const rule of defaultRules) {
      ruleMap.set(rule.prefix, rule.provider);
    }

    // Merge model prefixes from ProviderRegistry so custom providers
    // (PROVIDERS_JSON / PROVIDERS_CONFIG_PATH) auto-participate.
    try {
      for (const provider of ProviderRegistry.all()) {
        if (!provider.models) continue;
        for (const modelPrefix of provider.models) {
          if (!ruleMap.has(modelPrefix)) {
            ruleMap.set(modelPrefix, provider.id);
          }
        }
      }
    } catch {
      // Registry may not be loaded yet during early init; fall back to defaults.
    }

    // Sort by prefix length descending so longest-prefix wins.
    return Array.from(ruleMap.entries())
      .map(([prefix, provider]) => ({ prefix, provider }))
      .sort((a, b) => b.prefix.length - a.prefix.length);
  }

  function rules(): PrefixRule[] {
    if (!cachedRules) cachedRules = buildRules();
    return cachedRules;
  }

  /**
   * Resolve canonical provider id from a model name.
   * Uses longest-prefix matching against default + registry-derived rules.
   * Returns null if no prefix matches — caller should fall back to
   * ProviderRegistry.resolve() or a default.
   */
  export function fromModel(model: string): string | null {
    if (!model) return null;
    const lower = model.toLowerCase();
    const namespacedProvider = providerFromNamespace(lower);
    if (namespacedProvider) return namespacedProvider;

    for (const rule of rules()) {
      if (lower.startsWith(rule.prefix)) return rule.provider;
    }
    return null;
  }

  function providerFromNamespace(model: string): string | null {
    const slash = model.indexOf("/");
    if (slash <= 0) return null;

    const namespace = model.slice(0, slash);
    let providers: readonly ProviderRegistry.Provider[] = [];
    try {
      providers = ProviderRegistry.all();
    } catch {
      providers = [];
    }
    if (providers.some((provider) => provider.id === namespace)) return namespace;

    if (namespace === "anthropic") return "anthropic";
    if (namespace === "openai") return "openai";
    return null;
  }

  /**
   * Resolve canonical provider for a request, combining model prefix matching
   * with ProviderRegistry path/model resolution as fallback.
   */
  export function resolve(model: string | null | undefined, path: string): string {
    if (model) {
      const fromPrefix = fromModel(model);
      if (fromPrefix) return fromPrefix;
    }

    const resolved = ProviderRegistry.resolve({ path, model });
    return resolved?.id ?? "generic";
  }

  /**
   * Map a quota/auth provider name to its canonical provider id.
   * Auth files use type names like "claude"/"codex" which differ from
   * the canonical provider ids "anthropic"/"openai".
   */
  const authTypeMap: ReadonlyMap<string, string> = new Map([
    ["claude", "anthropic"],
    ["codex", "openai"],
  ]);

  export function fromAuthType(authType: string): string {
    return authTypeMap.get(authType) ?? authType;
  }

  /**
   * Determine billing semantics for a provider.
   * OpenAI-compatible providers subtract cache_read from prompt tokens;
   * Anthropic-style providers bill cache_read separately.
   */
  const openAiBillingProviders = new Set(["openai", "xai"]);

  export function billingSemantics(provider: string): BillingSemantics {
    // Check if the provider's type in the registry is openai-compatible
    try {
      for (const def of ProviderRegistry.all()) {
        if (def.id === provider) {
          return def.type === "anthropic" ? "anthropic" : "openai";
        }
      }
    } catch {
      // Registry not loaded
    }

    if (openAiBillingProviders.has(provider)) return "openai";
    if (provider === "anthropic") return "anthropic";
    return "openai";
  }
}
