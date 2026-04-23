export interface ParsedResponse {
  actualModel: string | null;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cache_creation_tokens: number;
    cache_read_tokens: number;
  } | null;
}

export namespace ResponseParser {
  export function parseResponseBody(body: string): ParsedResponse {
    try {
      const json = JSON.parse(body) as Record<string, unknown>;
      return {
        actualModel: extractModel(json),
        usage: extractUsage(json),
      };
    } catch {
      return { actualModel: null, usage: null };
    }
  }

  export function parseSSELine(line: string): ParsedResponse {
    try {
      const json = JSON.parse(line) as Record<string, unknown>;

      if (json.type === "message_start" && json.message) {
        const msg = json.message as Record<string, unknown>;
        return {
          actualModel: typeof msg.model === "string" ? msg.model : null,
          usage: extractAnthropicUsage(msg),
        };
      }

      if (json.type === "message_delta" && json.usage) {
        return {
          actualModel: null,
          usage: extractAnthropicUsage(json),
        };
      }

      if (json.choices && Array.isArray(json.choices)) {
        return {
          actualModel: typeof json.model === "string" ? json.model : null,
          usage: extractOpenAIUsage(json),
        };
      }

      if (json.usage && !json.choices) {
        return {
          actualModel: typeof json.model === "string" ? json.model : null,
          usage: extractOpenAIUsage(json),
        };
      }

      return { actualModel: null, usage: null };
    } catch {
      return { actualModel: null, usage: null };
    }
  }

  function extractModel(json: Record<string, unknown>): string | null {
    if (typeof json.model === "string") {
      return json.model;
    }
    if (json.message && typeof (json.message as Record<string, unknown>).model === "string") {
      return (json.message as Record<string, unknown>).model as string;
    }
    return null;
  }

  function extractUsage(json: Record<string, unknown>): ParsedResponse["usage"] {
    if (!json.usage || typeof json.usage !== "object") {
      return null;
    }

    const usage = json.usage as Record<string, unknown>;

    if (typeof usage.input_tokens === "number") {
      return {
        prompt_tokens: usage.input_tokens,
        completion_tokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
        total_tokens:
          (typeof usage.input_tokens === "number" ? usage.input_tokens : 0) +
          (typeof usage.output_tokens === "number" ? usage.output_tokens : 0),
        cache_creation_tokens: typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : 0,
        cache_read_tokens: typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0,
      };
    }

    if (typeof usage.prompt_tokens === "number") {
      return {
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0,
        total_tokens: typeof usage.total_tokens === "number" ? usage.total_tokens : 0,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
      };
    }

    return null;
  }

  function extractAnthropicUsage(obj: Record<string, unknown>): ParsedResponse["usage"] {
    if (!obj.usage || typeof obj.usage !== "object") return null;
    const usage = obj.usage as Record<string, number>;
    return {
      prompt_tokens: usage.input_tokens ?? 0,
      completion_tokens: usage.output_tokens ?? 0,
      total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
      cache_creation_tokens: usage.cache_creation_input_tokens ?? 0,
      cache_read_tokens: usage.cache_read_input_tokens ?? 0,
    };
  }

  function extractOpenAIUsage(obj: Record<string, unknown>): ParsedResponse["usage"] {
    if (!obj.usage || typeof obj.usage !== "object") return null;
    const usage = obj.usage as Record<string, number>;
    return {
      prompt_tokens: usage.prompt_tokens ?? 0,
      completion_tokens: usage.completion_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
    };
  }
}
