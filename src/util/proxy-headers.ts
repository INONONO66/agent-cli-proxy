import { Config } from "../config";

interface ProxyHeaderOptions {
  readonly trustProxyHeaders?: boolean;
}

export function isRequestSecure(req: Request, options: ProxyHeaderOptions = {}): boolean {
  if (new URL(req.url).protocol === "https:") return true;
  return getTrustedForwardedProto(req, options) === "https";
}

export function getClientIp(req: Request, options: ProxyHeaderOptions = {}): string {
  return getTrustedClientIp(req, options) ?? "unknown";
}

export function getTrustedClientIp(req: Request, options: ProxyHeaderOptions = {}): string | null {
  if (!shouldTrustProxyHeaders(options)) return null;

  const forwardedFor = firstHeaderValue(req.headers.get("x-forwarded-for"));
  if (forwardedFor) return forwardedFor;

  const cfConnectingIp = req.headers.get("cf-connecting-ip")?.trim();
  if (cfConnectingIp) return cfConnectingIp;

  return null;
}

function getTrustedForwardedProto(req: Request, options: ProxyHeaderOptions): "http" | "https" | null {
  if (!shouldTrustProxyHeaders(options)) return null;

  const xForwardedProto = normalizeProto(firstHeaderValue(req.headers.get("x-forwarded-proto")));
  if (xForwardedProto) return xForwardedProto;

  const forwardedProto = parseForwardedProto(req.headers.get("forwarded"));
  if (forwardedProto) return forwardedProto;

  const cfVisitorProto = parseCfVisitorProto(req.headers.get("cf-visitor"));
  if (cfVisitorProto) return cfVisitorProto;

  return null;
}

function firstHeaderValue(value: string | null): string | null {
  return value?.split(",")[0]?.trim() || null;
}

function parseForwardedProto(header: string | null): "http" | "https" | null {
  const first = firstHeaderValue(header);
  if (!first) return null;

  for (const part of first.split(";")) {
    const [rawKey, rawValue] = part.split("=");
    if (rawKey?.trim().toLowerCase() !== "proto") continue;
    const value = rawValue?.trim().replace(/^"|"$/g, "");
    return normalizeProto(value ?? null);
  }

  return null;
}

function parseCfVisitorProto(header: string | null): "http" | "https" | null {
  if (!header) return null;
  try {
    const parsed: unknown = JSON.parse(header);
    if (!parsed || typeof parsed !== "object") return null;
    const scheme = (parsed as { scheme?: unknown }).scheme;
    return normalizeProto(typeof scheme === "string" ? scheme : null);
  } catch {
    return null;
  }
}

function normalizeProto(value: string | null): "http" | "https" | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "http" || normalized === "https") return normalized;
  return null;
}

function shouldTrustProxyHeaders(options: ProxyHeaderOptions): boolean {
  return options.trustProxyHeaders ?? Config.trustProxyHeaders;
}
