import type { AgentPlugin } from "./types";
import type { RequestInfo } from "./types";
import { hermesPlugin } from "./hermes";
import { genericPlugin } from "./generic";
import { openclawPlugin } from "./openclaw";
import { opencodePlugin } from "./opencode";

export type { AgentPlugin } from "./types";
export type { RequestInfo } from "./types";

const registry: AgentPlugin[] = [];

interface LegacyAgentPluginTransform {
  transformHeaders?(headers: Headers, info: RequestInfo): Headers;
  transformBody?(body: unknown, info: RequestInfo): unknown;
  transformResponse?(responseBody: string, info: RequestInfo): string;
  transformStreamLine?(line: string, info: RequestInfo): string;
}

export namespace AgentPlugins {
  export function register(plugin: AgentPlugin & LegacyAgentPluginTransform): void {
    registry.push(plugin);
  }

  export function resolve(info: RequestInfo): AgentPlugin {
    for (const plugin of registry) {
      if (plugin.matches(info)) return plugin;
    }
    return genericPlugin;
  }
}

AgentPlugins.register(opencodePlugin);
AgentPlugins.register(openclawPlugin);
AgentPlugins.register(hermesPlugin);
