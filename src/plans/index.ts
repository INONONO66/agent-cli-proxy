import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import defaultPlansDocument from "../../data/plans.default.json";
import { Logger } from "../util/logger";

export namespace Plans {
  export interface Plan {
    code: string;
    provider: string;
    display_name: string;
    monthly_price_usd: number;
    currency: string;
    billing_period_days: number;
    vendor_url?: string;
    notes?: string;
  }

  export interface SchemaIssue {
    path: string;
    message: string;
  }

  export class SchemaError extends Error {
    readonly name = "PlansSchemaError";
    readonly code = "PLANS_SCHEMA_INVALID";

    constructor(readonly issues: SchemaIssue[]) {
      super(`Plans schema validation failed: ${issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
    }
  }

  type SourceKind = "PLANS_JSON" | "PLANS_PATH" | "XDG_CONFIG_HOME" | "default";

  interface Source {
    kind: SourceKind;
    raw?: string;
    configPath?: string;
    value?: unknown;
  }

  interface Cache {
    list: Plan[];
    byCode: Map<string, Plan>;
  }

  const logger = Logger.fromConfig().child({ component: "plans" });
  let cache: Cache | null = null;

  export function load(): Plan[] {
    return readCache().list;
  }

  export function list(): Plan[] {
    return load();
  }

  export function byCode(code: string): Plan | null {
    return readCache().byCode.get(code) ?? null;
  }

  export function validateBindingInput(account: string, code: string): { account: string; code: string } {
    const normalizedAccount = account.trim();
    if (!normalizedAccount) throw new Error("Account must be a non-empty string");

    const normalizedCode = code.trim();
    if (!normalizedCode) throw new Error("Plan code must be a non-empty string");
    if (!byCode(normalizedCode)) throw new Error(`Unknown plan code: ${normalizedCode}`);

    return { account: normalizedAccount, code: normalizedCode };
  }

  export function reload(): Plan[] {
    cache = null;
    return load();
  }

  function readCache(): Cache {
    if (cache) return cache;
    const source = resolveSource();
    const plans = parseSourceOrFallback(source);
    const frozenPlans = Object.freeze(plans.map((plan) => Object.freeze({ ...plan })));
    cache = {
      list: frozenPlans as Plan[],
      byCode: new Map(frozenPlans.map((plan) => [plan.code, plan])),
    };
    return cache;
  }

  function resolveSource(): Source {
    const inline = process.env.PLANS_JSON;
    if (inline !== undefined && inline.trim() !== "") return { kind: "PLANS_JSON", raw: inline };

    const envPath = process.env.PLANS_PATH?.trim();
    if (envPath) return readPathSource("PLANS_PATH", envPath);

    const xdgPath = xdgPlansPath();
    if (xdgPath && existsSync(xdgPath)) return readPathSource("XDG_CONFIG_HOME", xdgPath);

    return { kind: "default", value: defaultPlansDocument };
  }

  function readPathSource(kind: "PLANS_PATH" | "XDG_CONFIG_HOME", configPath: string): Source {
    try {
      return { kind, raw: readFileSync(configPath, "utf-8"), configPath };
    } catch (err) {
      return { kind, raw: undefined, configPath, value: err };
    }
  }

  function xdgPlansPath(): string | null {
    const base = process.env.XDG_CONFIG_HOME?.trim() || (process.env.HOME?.trim() ? join(process.env.HOME.trim(), ".config") : "");
    if (!base) return null;
    return join(base, "agent-cli-proxy", "plans.json");
  }

  function parseSourceOrFallback(source: Source): Plan[] {
    if (source.kind === "default") return validateDefault(defaultPlansDocument);

    const result = parseSource(source);
    if (result.ok) return result.plans;

    logger.warn("plans config invalid; falling back to packaged defaults", {
      event: "plans.config.invalid",
      source: source.kind,
      configPath: source.configPath,
      path: result.issues[0]?.path ?? source.kind,
      issues: result.issues,
    });
    return validateDefault(defaultPlansDocument);
  }

  function parseSource(source: Source): { ok: true; plans: Plan[] } | { ok: false; issues: SchemaIssue[] } {
    if (source.raw === undefined) {
      return {
        ok: false,
        issues: [{ path: source.kind, message: source.value instanceof Error ? source.value.message : "could not be read" }],
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(source.raw);
    } catch (err) {
      return {
        ok: false,
        issues: [{ path: "plans", message: err instanceof Error ? err.message : "must be valid JSON" }],
      };
    }

    const validation = parsePlanDocument(parsed);
    if (validation.issues.length > 0) return { ok: false, issues: validation.issues };
    return { ok: true, plans: validation.plans };
  }

  function validateDefault(value: unknown): Plan[] {
    const validation = parsePlanDocument(value);
    if (validation.issues.length > 0) throw new SchemaError(validation.issues);
    return validation.plans;
  }

  function parsePlanDocument(value: unknown): { plans: Plan[]; issues: SchemaIssue[] } {
    const issues: SchemaIssue[] = [];
    const plans: Plan[] = [];

    if (!isRecord(value)) {
      issues.push({ path: "plans", message: "must be contained in an object" });
      return { plans, issues };
    }

    if (!Array.isArray(value.plans)) {
      issues.push({ path: "plans", message: "must be an array" });
      return { plans, issues };
    }

    value.plans.forEach((entry, index) => {
      const plan = parsePlan(entry, `plans[${index}]`, issues);
      if (plan) plans.push(plan);
    });

    const seen = new Set<string>();
    plans.forEach((plan, index) => {
      if (seen.has(plan.code)) issues.push({ path: `plans[${index}].code`, message: "must be unique" });
      seen.add(plan.code);
    });

    return { plans: issues.length === 0 ? plans : [], issues };
  }

  function parsePlan(value: unknown, path: string, issues: SchemaIssue[]): Plan | null {
    if (!isRecord(value)) {
      issues.push({ path, message: "must be an object" });
      return null;
    }

    const code = readRequiredString(value, "code", path, issues);
    const provider = readRequiredString(value, "provider", path, issues);
    const displayName = readRequiredString(value, "display_name", path, issues);
    const monthlyPriceUsd = readRequiredNumber(value, "monthly_price_usd", path, issues);
    const currency = readRequiredString(value, "currency", path, issues);
    const billingPeriodDays = readRequiredPositiveInteger(value, "billing_period_days", path, issues);
    const vendorUrl = readOptionalHttpUrl(value, "vendor_url", path, issues);
    const notes = readOptionalString(value, "notes", path, issues);

    if (!code || !provider || !displayName || monthlyPriceUsd === undefined || !currency || billingPeriodDays === undefined) return null;

    const plan: Plan = {
      code,
      provider,
      display_name: displayName,
      monthly_price_usd: monthlyPriceUsd,
      currency,
      billing_period_days: billingPeriodDays,
    };
    if (vendorUrl !== undefined) plan.vendor_url = vendorUrl;
    if (notes !== undefined) plan.notes = notes;
    return plan;
  }

  function readRequiredString(record: Record<string, unknown>, key: string, path: string, issues: SchemaIssue[]): string | undefined {
    const value = record[key];
    if (typeof value !== "string" || value.trim() === "") {
      issues.push({ path: `${path}.${key}`, message: "must be a non-empty string" });
      return undefined;
    }
    return value.trim();
  }

  function readOptionalString(record: Record<string, unknown>, key: string, path: string, issues: SchemaIssue[]): string | undefined {
    const value = record[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.trim() === "") {
      issues.push({ path: `${path}.${key}`, message: "must be a non-empty string" });
      return undefined;
    }
    return value.trim();
  }

  function readRequiredNumber(record: Record<string, unknown>, key: string, path: string, issues: SchemaIssue[]): number | undefined {
    const value = record[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      issues.push({ path: `${path}.${key}`, message: "must be a non-negative finite number" });
      return undefined;
    }
    return value;
  }

  function readRequiredPositiveInteger(record: Record<string, unknown>, key: string, path: string, issues: SchemaIssue[]): number | undefined {
    const value = record[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      issues.push({ path: `${path}.${key}`, message: "must be a positive integer" });
      return undefined;
    }
    return value;
  }

  function readOptionalHttpUrl(record: Record<string, unknown>, key: string, path: string, issues: SchemaIssue[]): string | undefined {
    const value = record[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.trim() === "") {
      issues.push({ path: `${path}.${key}`, message: "must be a non-empty http(s) URL string" });
      return undefined;
    }
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        issues.push({ path: `${path}.${key}`, message: "must be an http(s) URL" });
        return undefined;
      }
      return url.toString();
    } catch {
      issues.push({ path: `${path}.${key}`, message: "must be a parseable http(s) URL" });
      return undefined;
    }
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}
