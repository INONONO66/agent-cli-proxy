import { Pricing } from "./pricing";
import { Logger } from "../util/logger";

const logger = Logger.fromConfig().child({ component: "cost" });

export namespace Cost {
  export interface CostInputs {
    provider: string;
    model: string;
    usage: {
      prompt_tokens?: number;
      completion_tokens?: number;
      cache_creation_tokens?: number;
      cache_read_tokens?: number;
      reasoning_tokens?: number;
    };
  }

  export interface CostResult {
    cost_usd: number;
    cost_status: "ok" | "pending" | "unsupported";
    source: "pricing" | "pricing_stale_fallback" | "unsupported_model" | "guard";
  }

  const SENTINEL_MODELS = new Set(["", "unknown", "undefined"]);

  let activeLogger: Logger.Logger = logger;

  export function __setLoggerForTests(nextLogger: Logger.Logger): void {
    activeLogger = nextLogger;
  }

  export function __resetLoggerForTests(): void {
    activeLogger = logger;
  }

  export function compute(inputs: CostInputs): CostResult {
    const model = inputs.model?.trim() ?? "";
    if (SENTINEL_MODELS.has(model.toLowerCase())) {
      return { cost_usd: 0, cost_status: "unsupported", source: "unsupported_model" };
    }

    const pricing = Pricing.getPricing(model, inputs.provider);
    if (!pricing) {
      return { cost_usd: 0, cost_status: "pending", source: "pricing" };
    }

    const rawCost = Pricing.calculateCost(
      {
        prompt_tokens: inputs.usage.prompt_tokens ?? 0,
        completion_tokens: inputs.usage.completion_tokens ?? 0,
        cache_creation_tokens: inputs.usage.cache_creation_tokens ?? 0,
        cache_read_tokens: inputs.usage.cache_read_tokens ?? 0,
        reasoning_tokens: inputs.usage.reasoning_tokens ?? 0,
      },
      pricing,
      inputs.provider,
    );

    if (!Number.isFinite(rawCost) || Number.isNaN(rawCost) || rawCost < 0) {
      activeLogger.warn("cost guard rejected computed cost", {
        event: "cost.guard",
        provider: inputs.provider,
        model,
        raw_cost: rawCost,
      });
      return { cost_usd: 0, cost_status: "pending", source: "guard" };
    }

    if (rawCost === 0) {
      // Preserve the application invariant that ok rows always have positive
      // cost_usd. Zero usage is valid, but it remains pending for audit/backfill
      // visibility instead of creating cost_status='ok' with cost_usd=0.
      return { cost_usd: 0, cost_status: "pending", source: "guard" };
    }

    return { cost_usd: rawCost, cost_status: "ok", source: "pricing" };
  }

  export function inputsFromLog(log: {
    provider: string;
    model: string;
    prompt_tokens: number;
    completion_tokens: number;
    cache_creation_tokens: number;
    cache_read_tokens: number;
    reasoning_tokens?: number | null;
  }): CostInputs {
    return {
      provider: log.provider,
      model: log.model,
      usage: {
        prompt_tokens: log.prompt_tokens,
        completion_tokens: log.completion_tokens,
        cache_creation_tokens: log.cache_creation_tokens,
        cache_read_tokens: log.cache_read_tokens,
        reasoning_tokens: log.reasoning_tokens ?? 0,
      },
    };
  }
}
