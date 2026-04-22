import type { Anthropic } from "./index";

export function parseAnthropicSSELine(line: string): Partial<Anthropic.TokenUsage> | null {
  try {
    const json = JSON.parse(line) as Record<string, unknown>;
    if (json.type === "message_start" && json.message) {
      const msg = json.message as Record<string, unknown>;
      const usage = msg.usage as Record<string, number> | undefined;
      if (usage) {
        return {
          prompt_tokens: usage.input_tokens ?? 0,
          completion_tokens: 0,
          cache_creation_tokens: usage.cache_creation_input_tokens ?? 0,
          cache_read_tokens: usage.cache_read_input_tokens ?? 0,
          total_tokens: usage.input_tokens ?? 0,
        };
      }
    }
    if (json.type === "message_delta" && json.usage) {
      const usage = json.usage as Record<string, number>;
      return {
        completion_tokens: usage.output_tokens ?? 0,
      };
    }
  } catch {
    return null;
  }
  return null;
}

export function accumulateUsage(
  acc: Partial<Anthropic.TokenUsage>,
  partial: Partial<Anthropic.TokenUsage>,
): Partial<Anthropic.TokenUsage> {
  return {
    prompt_tokens: (acc.prompt_tokens ?? 0) + (partial.prompt_tokens ?? 0),
    completion_tokens: (acc.completion_tokens ?? 0) + (partial.completion_tokens ?? 0),
    cache_creation_tokens: (acc.cache_creation_tokens ?? 0) + (partial.cache_creation_tokens ?? 0),
    cache_read_tokens: (acc.cache_read_tokens ?? 0) + (partial.cache_read_tokens ?? 0),
    total_tokens: (acc.total_tokens ?? 0) + (partial.total_tokens ?? 0),
  };
}

export function finalizeUsage(
  acc: Partial<Anthropic.TokenUsage>,
  incomplete: boolean,
): Anthropic.TokenUsage {
  return {
    prompt_tokens: acc.prompt_tokens ?? 0,
    completion_tokens: acc.completion_tokens ?? 0,
    cache_creation_tokens: acc.cache_creation_tokens ?? 0,
    cache_read_tokens: acc.cache_read_tokens ?? 0,
    total_tokens: acc.total_tokens ?? 0,
    incomplete,
  };
}
