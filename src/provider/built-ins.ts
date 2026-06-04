import type { ProviderDefinition } from "./registry-schema";

export function builtInProviders(cliProxyApiUrl: string): ProviderDefinition[] {
  return [
    {
      id: "anthropic",
      type: "anthropic",
      paths: ["/v1/messages"],
      upstreamBaseUrl: cliProxyApiUrl,
      upstreamPath: "/v1/messages",
      auth: "preserve",
    },
    {
      id: "xai",
      type: "openai-compatible",
      paths: ["/v1/chat/completions"],
      upstreamBaseUrl: cliProxyApiUrl,
      upstreamPath: "/v1/chat/completions",
      models: ["grok"],
      auth: "preserve",
    },
    {
      id: "kimi",
      type: "openai-compatible",
      paths: ["/v1/chat/completions"],
      upstreamBaseUrl: cliProxyApiUrl,
      upstreamPath: "/v1/chat/completions",
      models: ["kimi", "k2p", "k2-"],
      auth: "preserve",
    },
    {
      id: "zai",
      type: "openai-compatible",
      paths: ["/v1/chat/completions"],
      upstreamBaseUrl: cliProxyApiUrl,
      upstreamPath: "/v1/chat/completions",
      models: ["glm"],
      auth: "preserve",
    },
    {
      id: "minimax",
      type: "openai-compatible",
      paths: ["/v1/chat/completions"],
      upstreamBaseUrl: cliProxyApiUrl,
      upstreamPath: "/v1/chat/completions",
      models: ["minimax"],
      auth: "preserve",
    },
    {
      id: "openai",
      type: "openai-compatible",
      paths: ["/v1/chat/completions"],
      upstreamBaseUrl: cliProxyApiUrl,
      upstreamPath: "/v1/chat/completions",
      auth: "preserve",
    },
  ];
}
