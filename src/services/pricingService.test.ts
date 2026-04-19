import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  calculateCost,
  getPricing,
  fetchPricing,
  type ModelPricing,
} from "./pricingService";

describe("pricingService", () => {
  it("calculateCost with known values", () => {
    const usage = {
      prompt_tokens: 1000,
      completion_tokens: 500,
      cache_creation_tokens: 0,
      cache_read_tokens: 200,
    };

    const pricing: ModelPricing = {
      input: 3,
      output: 15,
      cache_read: 0.3,
      cache_write: 3.75,
    };

    const cost = calculateCost(usage, pricing);
    // (1000 * 3 + 500 * 15 + 200 * 0.3 + 0 * 3.75) / 1_000_000
    // (3000 + 7500 + 60 + 0) / 1_000_000
    // 10560 / 1_000_000 = 0.01056
    expect(cost).toBeCloseTo(0.01056, 6);
  });

  it("getPricing returns null when cache is empty", () => {
    const pricing = getPricing("claude-3-sonnet");
    expect(pricing).toBeNull();
  });

  it("calculateCost with cache_write fallback", () => {
    const usage = {
      prompt_tokens: 1000,
      completion_tokens: 500,
      cache_creation_tokens: 100,
      cache_read_tokens: 0,
    };

    const pricing: ModelPricing = {
      input: 3,
      output: 15,
    };

    const cost = calculateCost(usage, pricing);
    // (1000 * 3 + 500 * 15 + 0 * 3 + 100 * 3) / 1_000_000
    // (3000 + 7500 + 0 + 300) / 1_000_000
    // 10800 / 1_000_000 = 0.0108
    expect(cost).toBeCloseTo(0.0108, 6);
  });

  it("calculateCost with zero tokens", () => {
    const usage = {
      prompt_tokens: 0,
      completion_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
    };

    const pricing: ModelPricing = {
      input: 3,
      output: 15,
    };

    const cost = calculateCost(usage, pricing);
    expect(cost).toBe(0);
  });
});
