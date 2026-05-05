import { readFileSync } from "node:fs";
import { Config } from "../config";
import { Logger } from "../util/logger";
import {
  parseProviderInput,
  validateProviderDocument,
  type ProviderDefinition,
  type ProviderSchemaIssue,
} from "./registry-schema";

export namespace ProviderRegistry {
  export type Provider = ProviderDefinition;

  export interface ResolveInput {
    path: string;
    model?: string | null;
    provider?: string | null;
  }

  export interface SourceInfo {
    source: "built-in" | "PROVIDERS_JSON" | "PROVIDERS_CONFIG_PATH";
    configPath?: string;
    lastLoadedAt: string | null;
  }

  interface Cache {
    providers: ProviderDefinition[];
    source: SourceInfo["source"];
    configPath?: string;
    lastLoadedAt: string;
  }

  const logger = Logger.fromConfig().child({ component: "provider-registry" });
  let cache: Cache | null = null;

  export function loadProviders(options: { force?: boolean } = {}): ProviderDefinition[] {
    if (cache && !options.force) return cache.providers;

    const customSource = readCustomConfig();
    const customProviders = customSource ? parseCustomProviders(customSource.raw) : [];
    const providers = mergeProviders([...builtInProviders(), ...customProviders]);
    const lastLoadedAt = new Date().toISOString();

    cache = {
      providers,
      source: customSource?.source ?? "built-in",
      configPath: customSource?.configPath,
      lastLoadedAt,
    };
    return providers;
  }

  export function all(): ProviderDefinition[] {
    return loadProviders();
  }

  export function handlesPath(path: string): boolean {
    return loadProviders().some((provider) => provider.paths.includes(path));
  }

  export function resolve(input: ResolveInput): ProviderDefinition | null {
    const providers = loadProviders();

    if (input.provider) {
      const explicit = providers.find((provider) => provider.id === input.provider);
      if (!explicit || !matchesPath(explicit, input.path) || !matchesModel(explicit, input.model)) return null;
      return explicit;
    }

    const candidates = providers.filter((provider) => matchesPath(provider, input.path));
    if (input.model) {
      const modelMatch = candidates.find((provider) => matchesModel(provider, input.model));
      if (modelMatch) return modelMatch;
    }
    return candidates[0] ?? null;
  }

  export function forceReload(): ProviderDefinition[] {
    return loadProviders({ force: true });
  }

  export function configPath(): string | undefined {
    return process.env.PROVIDERS_CONFIG_PATH?.trim() || undefined;
  }

  export function sourceInfo(): SourceInfo {
    if (!cache) {
      return { source: "built-in", lastLoadedAt: null };
    }
    return {
      source: cache.source,
      configPath: cache.configPath,
      lastLoadedAt: cache.lastLoadedAt,
    };
  }

  function builtInProviders(): ProviderDefinition[] {
    return [
      {
        id: "anthropic",
        type: "anthropic",
        paths: ["/v1/messages"],
        upstreamBaseUrl: Config.cliProxyApiUrl,
        upstreamPath: "/v1/messages",
        auth: "preserve",
      },
      {
        id: "openai",
        type: "openai-compatible",
        paths: ["/v1/chat/completions"],
        upstreamBaseUrl: Config.cliProxyApiUrl,
        upstreamPath: "/v1/chat/completions",
        auth: "preserve",
      },
    ];
  }

  function readCustomConfig(): { source: "PROVIDERS_JSON" | "PROVIDERS_CONFIG_PATH"; raw: string; configPath?: string } | null {
    const inline = process.env.PROVIDERS_JSON;
    if (inline !== undefined && inline.trim() !== "") return { source: "PROVIDERS_JSON", raw: inline };

    const path = configPath();
    if (!path) return null;

    try {
      return { source: "PROVIDERS_CONFIG_PATH", raw: readFileSync(path, "utf-8"), configPath: path };
    } catch (err) {
      logger.warn("provider config could not be read", {
        event: "provider.config.invalid",
        source: "PROVIDERS_CONFIG_PATH",
        path: "PROVIDERS_CONFIG_PATH",
        configPath: path,
        err,
      });
      return null;
    }
  }

  function parseCustomProviders(raw: string): ProviderDefinition[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      logger.warn("provider config JSON is invalid", {
        event: "provider.config.invalid",
        path: "providers",
        err,
      });
      return [];
    }

    if (!isRecord(parsed) || !Array.isArray(parsed.providers)) {
      const result = validateProviderDocument(parsed);
      logger.warn("provider config document is invalid", {
        event: "provider.config.invalid",
        path: result.issues[0]?.path ?? "providers",
        issues: result.issues,
      });
      return [];
    }

    const providers: ProviderDefinition[] = [];
    parsed.providers.forEach((entry, index) => {
      const result = parseProviderInput(entry, `providers[${index}]`);
      if (result.provider) {
        providers.push(result.provider);
        return;
      }
      warnInvalidEntry(entry, `providers[${index}]`, result.issues);
    });
    return providers;
  }

  function warnInvalidEntry(entry: unknown, path: string, issues: ProviderSchemaIssue[]): void {
    logger.warn("provider config entry is invalid", {
      event: "provider.config.invalid",
      providerId: providerIdForLog(entry),
      path,
      issues,
    });
  }

  function providerIdForLog(entry: unknown): string | undefined {
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.trim() === "") return undefined;
    return entry.id.trim();
  }

  function mergeProviders(providers: ProviderDefinition[]): ProviderDefinition[] {
    const byId = new Map<string, ProviderDefinition>();
    for (const provider of providers) byId.set(provider.id, provider);
    return Array.from(byId.values());
  }

  function matchesPath(provider: ProviderDefinition, path: string): boolean {
    return provider.paths.includes(path);
  }

  function matchesModel(provider: ProviderDefinition, model?: string | null): boolean {
    if (!model || !provider.models || provider.models.length === 0) return true;
    return provider.models.some((entry) => model === entry || model.startsWith(entry));
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}
