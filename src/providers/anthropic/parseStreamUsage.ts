import type { TokenUsage } from "../../types/index";

export function parseAnthropicSSELine(line: string): Partial<TokenUsage> | null {
  if (!line || line === "[DONE]") return null;
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;

    if (parsed.type === "message_start") {
      const msg = parsed.message as Record<string, unknown> | undefined;
      if (msg?.usage) {
        const u = msg.usage as Record<string, unknown>;
        const result: Partial<TokenUsage> = {};
        if (typeof u.input_tokens === "number") result.prompt_tokens = u.input_tokens;
        if (typeof u.cache_creation_input_tokens === "number")
          result.cache_creation_tokens = u.cache_creation_input_tokens;
        if (typeof u.cache_read_input_tokens === "number")
          result.cache_read_tokens = u.cache_read_input_tokens;
        return Object.keys(result).length > 0 ? result : null;
      }
    }

    if (parsed.type === "message_delta" && parsed.usage) {
      const u = parsed.usage as Record<string, unknown>;
      if (typeof u.output_tokens === "number") {
        return { completion_tokens: u.output_tokens };
      }
    }

    return null;
  } catch {
    return null;
  }
}

export function accumulateUsage(
  acc: Partial<TokenUsage>,
  partial: Partial<TokenUsage>,
): Partial<TokenUsage> {
  const result = { ...acc };
  if (partial.prompt_tokens !== undefined)
    result.prompt_tokens = (acc.prompt_tokens ?? 0) + partial.prompt_tokens;
  if (partial.cache_creation_tokens !== undefined)
    result.cache_creation_tokens =
      (acc.cache_creation_tokens ?? 0) + partial.cache_creation_tokens;
  if (partial.cache_read_tokens !== undefined)
    result.cache_read_tokens = (acc.cache_read_tokens ?? 0) + partial.cache_read_tokens;
  // CUMULATIVE: Anthropic output_tokens in message_delta is a running total — overwrite, never sum
  if (partial.completion_tokens !== undefined) result.completion_tokens = partial.completion_tokens;
  return result;
}

export function finalizeUsage(acc: Partial<TokenUsage>, incomplete: boolean): TokenUsage {
  const pt = acc.prompt_tokens ?? 0;
  const ct = acc.completion_tokens ?? 0;
  const cct = acc.cache_creation_tokens ?? 0;
  const crt = acc.cache_read_tokens ?? 0;
  return {
    prompt_tokens: pt,
    completion_tokens: ct,
    cache_creation_tokens: cct,
    cache_read_tokens: crt,
    total_tokens: pt + ct,
    incomplete,
  };
}
