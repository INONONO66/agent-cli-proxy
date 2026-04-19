import type { TokenUsage } from "../../types/index";

export function parseOpenAISSELine(line: string): Partial<TokenUsage> | null {
  if (!line || line === "[DONE]") return null;
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;

    if (parsed.usage && typeof parsed.usage === "object") {
      const u = parsed.usage as Record<string, unknown>;
      const result: Partial<TokenUsage> = {};
      if (typeof u.prompt_tokens === "number") result.prompt_tokens = u.prompt_tokens;
      if (typeof u.completion_tokens === "number") result.completion_tokens = u.completion_tokens;
      if (typeof u.total_tokens === "number") result.total_tokens = u.total_tokens;
      const details = u.prompt_tokens_details as Record<string, unknown> | undefined;
      if (details && typeof details.cached_tokens === "number") {
        result.cache_read_tokens = details.cached_tokens;
      }
      return Object.keys(result).length > 0 ? result : null;
    }

    return null;
  } catch {
    return null;
  }
}

export function finalizeOpenAIUsage(
  partial: Partial<TokenUsage> | null,
  incomplete: boolean,
): TokenUsage {
  return {
    prompt_tokens: partial?.prompt_tokens ?? 0,
    completion_tokens: partial?.completion_tokens ?? 0,
    cache_creation_tokens: 0,
    cache_read_tokens: partial?.cache_read_tokens ?? 0,
    total_tokens:
      partial?.total_tokens ??
      (partial?.prompt_tokens ?? 0) + (partial?.completion_tokens ?? 0),
    incomplete,
  };
}
