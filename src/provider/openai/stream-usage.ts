export namespace OpenAI {
  export interface TokenUsage {
    prompt_tokens: number;
    completion_tokens: number;
    cache_creation_tokens: number;
    cache_read_tokens: number;
    reasoning_tokens: number;
    total_tokens: number;
    incomplete: boolean;
  }
}

interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

export function parseOpenAISSELine(line: string): Partial<OpenAI.TokenUsage> | null {
  try {
    const json = JSON.parse(line) as Record<string, unknown>;
    if (!json.usage) return null;
    const usage = json.usage as RawUsage;
    return {
      prompt_tokens: usage.prompt_tokens ?? 0,
      completion_tokens: usage.completion_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
      cache_read_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
      reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
    };
  } catch {
    return null;
  }
}

export function finalizeOpenAIUsage(
  usage: Partial<OpenAI.TokenUsage> | null,
  incomplete: boolean,
): OpenAI.TokenUsage {
  return {
    prompt_tokens: usage?.prompt_tokens ?? 0,
    completion_tokens: usage?.completion_tokens ?? 0,
    cache_creation_tokens: 0,
    cache_read_tokens: usage?.cache_read_tokens ?? 0,
    reasoning_tokens: usage?.reasoning_tokens ?? 0,
    total_tokens: usage?.total_tokens ?? 0,
    incomplete,
  };
}
