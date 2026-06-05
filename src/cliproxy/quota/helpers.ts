import { Config } from "../../config";
import { UpstreamClient } from "../../upstream/client";

export function normalizePercent(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  // providers return 0-100 integer percentages; only convert if strictly fractional (< 1 and > 0)
  const pct = value > 0 && value < 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, pct));
}

export function normalizeReset(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return undefined;
}

export function quotaTypeFromSeconds(seconds: unknown, fallback: string): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return fallback;
  const hours = Math.round(seconds / 3600);
  if (hours >= 24 * 6) return "week";
  if (hours >= 24) return `${Math.round(hours / 24)}d`;
  return `${hours}h`;
}

export async function fetchJson(
  url: string,
  init: RequestInit,
): Promise<{ ok: boolean; status: number; data: unknown; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Config.quotaRefreshTimeoutMs);
  try {
    const options: UpstreamClient.FetchOptions = {
      method: init.method ?? "GET",
      url,
      body: init.body ?? null,
      providerId: `quota:${new URL(url).hostname}`,
      idempotent: (init.method ?? "GET") === "GET" || (init.method ?? "GET") === "HEAD",
      signal: controller.signal,
      ...(init.headers !== undefined ? { headers: init.headers } : {}),
    };
    const res = await UpstreamClient.fetch(options);
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return { ok: res.ok, status: res.status, data, text };
  } finally {
    clearTimeout(timer);
  }
}

export function errorMessage(data: unknown, fallback: string): string {
  if (data && typeof data === "object" && "error" in data) {
    const err = (data as { error?: unknown }).error;
    if (err && typeof err === "object" && "message" in err) {
      const message = (err as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) return message;
    }
    if (typeof err === "string" && err.trim()) return err;
  }
  return fallback;
}
