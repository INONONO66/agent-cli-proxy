import { describe, it, expect } from "bun:test";
import { parseOpenAISSELine, finalizeOpenAIUsage } from "./parseStreamUsage";

describe("parseOpenAISSELine", () => {
  it("extracts usage from final chunk", () => {
    const line = JSON.stringify({
      choices: [{ finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
    });
    const result = parseOpenAISSELine(line);
    expect(result?.prompt_tokens).toBe(100);
    expect(result?.completion_tokens).toBe(30);
    expect(result?.total_tokens).toBe(130);
  });

  it("extracts cached tokens from prompt_tokens_details", () => {
    const line = JSON.stringify({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 30,
        total_tokens: 130,
        prompt_tokens_details: { cached_tokens: 50 },
      },
    });
    const result = parseOpenAISSELine(line);
    expect(result?.cache_read_tokens).toBe(50);
  });

  it("returns null for delta chunks without usage", () => {
    const line = JSON.stringify({ choices: [{ delta: { content: "hi" } }] });
    expect(parseOpenAISSELine(line)).toBeNull();
  });

  it("returns null for [DONE]", () => {
    expect(parseOpenAISSELine("[DONE]")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseOpenAISSELine("")).toBeNull();
  });

  it("handles invalid JSON gracefully", () => {
    expect(parseOpenAISSELine("not json")).toBeNull();
  });

  it("returns null when usage is null", () => {
    const line = JSON.stringify({ usage: null });
    expect(parseOpenAISSELine(line)).toBeNull();
  });
});

describe("finalizeOpenAIUsage", () => {
  it("returns zero usage when no data", () => {
    const result = finalizeOpenAIUsage(null, false);
    expect(result.prompt_tokens).toBe(0);
    expect(result.completion_tokens).toBe(0);
    expect(result.total_tokens).toBe(0);
    expect(result.incomplete).toBe(false);
  });

  it("marks incomplete correctly", () => {
    const result = finalizeOpenAIUsage(null, true);
    expect(result.incomplete).toBe(true);
  });

  it("fills total_tokens from partial when present", () => {
    const result = finalizeOpenAIUsage(
      { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
      false,
    );
    expect(result.total_tokens).toBe(130);
  });

  it("computes total_tokens from prompt+completion when total absent", () => {
    const result = finalizeOpenAIUsage({ prompt_tokens: 100, completion_tokens: 30 }, false);
    expect(result.total_tokens).toBe(130);
  });

  it("cache_creation_tokens is always 0 for OpenAI", () => {
    const result = finalizeOpenAIUsage({ prompt_tokens: 100 }, false);
    expect(result.cache_creation_tokens).toBe(0);
  });
});
