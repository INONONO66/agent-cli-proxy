import { config } from "../config";

interface RouteResult {
  type: "claude" | "passthrough";
  baseUrl?: string;
  provider?: string;
}

const MODEL_PREFIX_MAP: Record<string, string> = {
  "glm": "glm",
  "chatglm": "glm",
  "moonshot": "kimi",
  "kimi": "kimi",
  "gpt": "openai",
  "o1": "openai",
  "o3": "openai",
  "o4": "openai",
  "gemini": "google",
  "deepseek": "deepseek",
  "qwen": "qwen",
};

export function routeByModel(model: string): RouteResult {
  if (model.startsWith("claude")) {
    return { type: "claude" };
  }

  for (const [prefix, provider] of Object.entries(MODEL_PREFIX_MAP)) {
    if (model.startsWith(prefix)) {
      const baseUrl = config.providers[provider];
      if (baseUrl) return { type: "passthrough", baseUrl, provider };
    }
  }

  for (const [provider, baseUrl] of Object.entries(config.providers)) {
    if (model.toLowerCase().includes(provider)) {
      return { type: "passthrough", baseUrl, provider };
    }
  }

  return { type: "passthrough", provider: "unknown" };
}
