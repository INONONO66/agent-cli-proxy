import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { Config } from "../../config";
import { Usage } from "../../usage";
import { Logger } from "../../util/logger";
import type { AuthFile, ProbeFn, ProbeResult } from "./types";

import { probeClaude } from "./probes/claude";
import { probeCodex } from "./probes/codex";
import { probeKimi } from "./probes/kimi";
import { probeGlm } from "./probes/glm";
import { probeXai } from "./probes/xai";

const logger = Logger.fromConfig().child({ component: "quota" });

const probes = new Map<string, ProbeFn>();

export function registerProbe(type: string, fn: ProbeFn): void {
  probes.set(type, fn);
}

export function registeredProbeTypes(): string[] {
  return Array.from(probes.keys());
}

// built-in probes
registerProbe("claude", probeClaude);
registerProbe("codex", probeCodex);
registerProbe("kimi", probeKimi);
registerProbe("glm", probeGlm);
registerProbe("xai", probeXai);

function unsupported(auth: AuthFile): ProbeResult {
  const provider = auth.type ?? "unknown";
  return {
    provider,
    account: auth.email ?? provider,
    status: "unsupported",
    unavailable: false,
    disabled: auth.disabled === true,
    error: "quota endpoint is not known for this provider",
    windows: [],
  };
}

function disabled(auth: AuthFile): ProbeResult {
  const provider = auth.type ?? "unknown";
  return {
    provider,
    account: auth.email ?? provider,
    status: "disabled",
    unavailable: false,
    disabled: true,
    error: "auth file marked disabled",
    windows: [],
  };
}

async function readAuthFiles(): Promise<AuthFile[]> {
  if (!Config.cliproxyAuthDir) return [];
  const names = await readdir(Config.cliproxyAuthDir);
  const out: AuthFile[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(Config.cliproxyAuthDir, name), "utf-8");
      const parsed = JSON.parse(raw) as AuthFile;
      out.push(parsed);
    } catch (err) {
      logger.warn("failed to read auth file", { err, name });
    }
  }
  return out;
}

export namespace QuotaProbe {
  export async function refresh(): Promise<Usage.QuotaRefreshResult> {
    const timestamp = new Date().toISOString();
    const auths = await readAuthFiles();
    const accounts: Usage.AccountQuotaReport[] = [];

    for (const auth of auths) {
      let result: ProbeResult;
      try {
        if (auth.disabled === true) {
          result = disabled(auth);
        } else {
          const probe = probes.get(auth.type ?? "");
          result = probe ? await probe(auth) : unsupported(auth);
        }
      } catch (err) {
        result = {
          provider: auth.type ?? "unknown",
          account: auth.email ?? auth.type ?? "unknown",
          status: "error",
          unavailable: true,
          disabled: auth.disabled === true,
          error: err instanceof Error ? err.message : String(err),
          windows: [],
        };
      }

      const windows: Usage.QuotaSnapshot[] = result.windows.map((window) => ({
        timestamp,
        provider: result.provider,
        account: result.account,
        quota_type: window.quota_type,
        model: window.model ?? null,
        used_pct: window.used_pct ?? null,
        remaining:
          window.used_pct === undefined ? null : Math.max(0, 100 - window.used_pct),
        remaining_raw:
          window.used_pct === undefined ? null : `${Math.max(0, 100 - window.used_pct).toFixed(2)}%`,
        resets_at: window.resets_at ?? null,
        raw_json: JSON.stringify(window.raw),
      }));

      accounts.push({
        provider: result.provider,
        account: result.account,
        status: result.status,
        unavailable: result.unavailable,
        disabled: result.disabled,
        plan: result.plan,
        refreshed_at: timestamp,
        error: result.error,
        windows,
        local_usage: {
          five_hour: { since: "", requests: 0, total_tokens: 0, cost_usd: 0 },
          seven_day: { since: "", requests: 0, total_tokens: 0, cost_usd: 0 },
        },
      });
    }

    return { timestamp, accounts, inserted: 0 };
  }
}
