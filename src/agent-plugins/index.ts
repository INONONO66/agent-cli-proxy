import type { AgentPlugin } from "./types";
import type { RequestInfo } from "./types";
import { hermesPlugin } from "./hermes";
import { genericPlugin } from "./generic";
import { openclawPlugin } from "./openclaw";
import { opencodePlugin } from "./opencode";
import { piPlugin } from "./pi";

export type { AgentPlugin } from "./types";
export type { RequestInfo } from "./types";

const registry: AgentPlugin[] = [];

export namespace AgentPlugins {
  export function register(plugin: AgentPlugin): void {
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
AgentPlugins.register(piPlugin);
