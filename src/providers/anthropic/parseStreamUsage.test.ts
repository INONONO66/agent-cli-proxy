import { describe, it, expect } from "bun:test";
import { parseAnthropicSSELine, accumulateUsage, finalizeUsage } from "./parseStreamUsage";

describe("parseAnthropicSSELine", () => {
  it("extracts input_tokens from message_start", () => {
    const line = JSON.stringify({
      type: "message_start",
      message: { usage: { input_tokens: 150, cache_read_input_tokens: 50 } },
    });
    const result = parseAnthropicSSELine(line);
    expect(result?.prompt_tokens).toBe(150);
    expect(result?.cache_read_tokens).toBe(50);
  });

  it("extracts output_tokens from message_delta", () => {
    const line = JSON.stringify({ type: "message_delta", usage: { output_tokens: 25 } });
    const result = parseAnthropicSSELine(line);
    expect(result?.completion_tokens).toBe(25);
  });

  it("extracts cache_creation_input_tokens from message_start", () => {
    const line = JSON.stringify({
      type: "message_start",
      message: { usage: { input_tokens: 100, cache_creation_input_tokens: 20 } },
    });
    const result = parseAnthropicSSELine(line);
    expect(result?.prompt_tokens).toBe(100);
    expect(result?.cache_creation_tokens).toBe(20);
  });

  it("returns null for content_block_delta", () => {
    const line = JSON.stringify({ type: "content_block_delta", delta: { text: "hi" } });
    expect(parseAnthropicSSELine(line)).toBeNull();
  });

  it("returns null for [DONE]", () => {
    expect(parseAnthropicSSELine("[DONE]")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseAnthropicSSELine("")).toBeNull();
  });

  it("handles invalid JSON gracefully", () => {
    expect(parseAnthropicSSELine("not json")).toBeNull();
  });

  it("returns null for message_start with no usage", () => {
    const line = JSON.stringify({ type: "message_start", message: {} });
    expect(parseAnthropicSSELine(line)).toBeNull();
  });
});

describe("accumulateUsage + finalizeUsage", () => {
  it("accumulates across multiple events", () => {
    let acc = {};
    acc = accumulateUsage(acc, { prompt_tokens: 150, cache_read_tokens: 50 });
    acc = accumulateUsage(acc, { completion_tokens: 25 });
    const final = finalizeUsage(acc, false);
    expect(final.prompt_tokens).toBe(150);
    expect(final.completion_tokens).toBe(25);
    expect(final.cache_read_tokens).toBe(50);
    expect(final.total_tokens).toBe(175);
    expect(final.incomplete).toBe(false);
  });

  it("overwrites completion_tokens on repeated message_delta (cumulative)", () => {
    let acc = {};
    acc = accumulateUsage(acc, { completion_tokens: 10 });
    acc = accumulateUsage(acc, { completion_tokens: 25 });
    const final = finalizeUsage(acc, false);
    expect(final.completion_tokens).toBe(25);
  });

  it("marks incomplete when stream interrupted", () => {
    const final = finalizeUsage({ prompt_tokens: 100 }, true);
    expect(final.incomplete).toBe(true);
    expect(final.completion_tokens).toBe(0);
  });

  it("sums prompt_tokens across events", () => {
    let acc = {};
    acc = accumulateUsage(acc, { prompt_tokens: 100 });
    acc = accumulateUsage(acc, { prompt_tokens: 50 });
    const final = finalizeUsage(acc, false);
    expect(final.prompt_tokens).toBe(150);
  });

  it("total_tokens is prompt + completion only", () => {
    const final = finalizeUsage(
      { prompt_tokens: 100, completion_tokens: 30, cache_creation_tokens: 5, cache_read_tokens: 10 },
      false,
    );
    expect(final.total_tokens).toBe(130);
  });
});
