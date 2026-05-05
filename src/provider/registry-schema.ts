export type ProviderType = "openai-compatible" | "anthropic";
export type ProviderAuthType = "none" | "preserve" | "bearer" | "x-api-key";

export type ProviderAuth = ProviderAuthType | {
  type: ProviderAuthType;
  env?: string;
  value?: string;
  header?: string;
};

export interface ProviderDefinition {
  id: string;
  type: ProviderType;
  paths: string[];
  upstreamBaseUrl: string;
  upstreamPath?: string;
  models?: string[];
  headers?: Record<string, string>;
  auth?: ProviderAuth;
  stripProviderField?: boolean;
}

export interface ProviderSchemaIssue {
  path: string;
  message: string;
}

export class ProviderSchemaError extends Error {
  readonly name = "ProviderSchemaError";
  readonly code = "PROVIDER_SCHEMA_INVALID";

  constructor(readonly issues: ProviderSchemaIssue[]) {
    super(`Provider schema validation failed: ${issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
  }
}

export interface ProviderValidationResult {
  ok: boolean;
  provider?: ProviderDefinition;
  issues: ProviderSchemaIssue[];
}

export interface ProviderDocumentValidationResult {
  providers: ProviderDefinition[];
  issues: ProviderSchemaIssue[];
}

const ALLOWED_PROVIDER_TYPES = new Set<ProviderType>(["openai-compatible", "anthropic"]);
const ALLOWED_AUTH_TYPES = new Set<ProviderAuthType>(["none", "preserve", "bearer", "x-api-key"]);
const ALLOWED_AUTH_OBJECT_KEYS = new Set(["type", "env", "value", "header"]);

export function validateProviderInput(value: unknown): ProviderDefinition {
  const result = parseProviderInput(value, "provider");
  if (!result.ok || !result.provider) throw new ProviderSchemaError(result.issues);
  return result.provider;
}

export function parseProviderInput(value: unknown, path = "provider"): ProviderValidationResult {
  const issues: ProviderSchemaIssue[] = [];
  const provider = normalizeProvider(value, path, issues);
  return {
    ok: issues.length === 0 && provider !== undefined,
    provider: issues.length === 0 ? provider : undefined,
    issues,
  };
}

export function validateProviderDocument(value: unknown): ProviderDocumentValidationResult {
  const issues: ProviderSchemaIssue[] = [];
  const providers: ProviderDefinition[] = [];

  if (!isRecord(value)) {
    issues.push({ path: "providers", message: "must be contained in an object" });
    return { providers, issues };
  }

  if (!Array.isArray(value.providers)) {
    issues.push({ path: "providers", message: "must be an array" });
    return { providers, issues };
  }

  value.providers.forEach((entry, index) => {
    const result = parseProviderInput(entry, `providers[${index}]`);
    if (result.provider) providers.push(result.provider);
    issues.push(...result.issues);
  });

  return { providers, issues };
}

function normalizeProvider(value: unknown, path: string, issues: ProviderSchemaIssue[]): ProviderDefinition | undefined {
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object" });
    return undefined;
  }

  const id = readRequiredString(value, "id", path, issues);
  const type = readProviderType(value.type, `${path}.type`, issues);
  const paths = readRequiredStringArray(value, "paths", path, issues);
  const upstreamBaseUrl = readRequiredHttpUrl(value.upstreamBaseUrl, `${path}.upstreamBaseUrl`, issues);
  const upstreamPath = readOptionalString(value, "upstreamPath", path, issues);
  const models = readOptionalStringArray(value, "models", path, issues);
  const headers = readOptionalHeaders(value, path, issues);
  const auth = readOptionalAuth(value.auth, `${path}.auth`, issues);
  const stripProviderField = readOptionalBoolean(value, "stripProviderField", path, issues);

  if (!id || !type || paths.length === 0 || !upstreamBaseUrl) return undefined;

  const provider: ProviderDefinition = {
    id,
    type,
    paths,
    upstreamBaseUrl,
  };
  if (upstreamPath !== undefined) provider.upstreamPath = upstreamPath;
  if (models !== undefined) provider.models = models;
  if (headers !== undefined) provider.headers = headers;
  if (auth !== undefined) provider.auth = auth;
  if (stripProviderField !== undefined) provider.stripProviderField = stripProviderField;
  return provider;
}

function readRequiredString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: ProviderSchemaIssue[],
): string | undefined {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    issues.push({ path: `${path}.${key}`, message: "must be a non-empty string" });
    return undefined;
  }
  return value.trim();
}

function readProviderType(value: unknown, path: string, issues: ProviderSchemaIssue[]): ProviderType | undefined {
  if (typeof value !== "string" || !ALLOWED_PROVIDER_TYPES.has(value as ProviderType)) {
    issues.push({ path, message: `must be one of ${Array.from(ALLOWED_PROVIDER_TYPES).join(", ")}` });
    return undefined;
  }
  return value as ProviderType;
}

function readRequiredStringArray(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: ProviderSchemaIssue[],
): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.length === 0) {
    issues.push({ path: `${path}.${key}`, message: "must be a non-empty string array" });
    return [];
  }
  const out: string[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      issues.push({ path: `${path}.${key}[${index}]`, message: "must be a non-empty string" });
      return;
    }
    out.push(entry.trim());
  });
  return out;
}

function readRequiredHttpUrl(value: unknown, path: string, issues: ProviderSchemaIssue[]): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    issues.push({ path, message: "must be a non-empty http(s) URL string" });
    return undefined;
  }
  return normalizeHttpUrl(value, path, issues);
}

function normalizeHttpUrl(raw: string, path: string, issues: ProviderSchemaIssue[]): string | undefined {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      issues.push({ path, message: "must be an http(s) URL" });
      return undefined;
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    issues.push({ path, message: "must be a parseable http(s) URL" });
    return undefined;
  }
}

function readOptionalString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: ProviderSchemaIssue[],
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    issues.push({ path: `${path}.${key}`, message: "must be a non-empty string" });
    return undefined;
  }
  return value.trim();
}

function readOptionalStringArray(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: ProviderSchemaIssue[],
): string[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    issues.push({ path: `${path}.${key}`, message: "must be a string array" });
    return undefined;
  }
  const out: string[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      issues.push({ path: `${path}.${key}[${index}]`, message: "must be a non-empty string" });
      return;
    }
    out.push(entry.trim());
  });
  return out;
}

function readOptionalBoolean(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: ProviderSchemaIssue[],
): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    issues.push({ path: `${path}.${key}`, message: "must be a boolean" });
    return undefined;
  }
  return value;
}

function readOptionalHeaders(
  provider: Record<string, unknown>,
  path: string,
  issues: ProviderSchemaIssue[],
): Record<string, string> | undefined {
  const value = provider.headers;
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    issues.push({ path: `${path}.headers`, message: "must be an object" });
    return undefined;
  }

  const headers: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key.trim() === "") {
      issues.push({ path: `${path}.headers`, message: "must not contain empty header names" });
      continue;
    }
    if (typeof entry !== "string") {
      issues.push({ path: `${path}.headers.${key}`, message: "must be a string" });
      continue;
    }
    headers[key] = entry;
  }
  return headers;
}

function readOptionalAuth(auth: unknown, path: string, issues: ProviderSchemaIssue[]): ProviderAuth | undefined {
  if (auth === undefined) return undefined;
  if (typeof auth === "string") {
    if (!ALLOWED_AUTH_TYPES.has(auth as ProviderAuthType)) {
      issues.push({ path, message: `must be one of ${Array.from(ALLOWED_AUTH_TYPES).join(", ")}` });
      return undefined;
    }
    return auth as ProviderAuthType;
  }
  if (!isRecord(auth)) {
    issues.push({ path, message: "must be a string or object" });
    return undefined;
  }

  for (const key of Object.keys(auth)) {
    if (!ALLOWED_AUTH_OBJECT_KEYS.has(key)) issues.push({ path: `${path}.${key}`, message: "is not supported" });
  }

  const type = auth.type;
  if (typeof type !== "string" || type.trim() === "") {
    issues.push({ path: `${path}.type`, message: "must be a non-empty string" });
    return undefined;
  }
  if (!ALLOWED_AUTH_TYPES.has(type as ProviderAuthType)) {
    issues.push({ path: `${path}.type`, message: `must be one of ${Array.from(ALLOWED_AUTH_TYPES).join(", ")}` });
    return undefined;
  }

  const result: Extract<ProviderAuth, object> = { type: type as ProviderAuthType };
  readAuthString(auth, "env", path, issues, result);
  readAuthString(auth, "value", path, issues, result);
  readAuthString(auth, "header", path, issues, result);
  return result;
}

function readAuthString(
  auth: Record<string, unknown>,
  key: "env" | "value" | "header",
  path: string,
  issues: ProviderSchemaIssue[],
  result: Extract<ProviderAuth, object>,
): void {
  const value = auth[key];
  if (value === undefined) return;
  if (typeof value !== "string" || value.trim() === "") {
    issues.push({ path: `${path}.${key}`, message: "must be a non-empty string" });
    return;
  }
  result[key] = value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
