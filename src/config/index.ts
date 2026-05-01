function loadClientMapping(): Map<string, string> {
  const mapping = new Map<string, string>();
  const env = process.env.CLIENT_NAME_MAPPING;
  if (env) {
    for (const pair of env.split(",")) {
      const [key, value] = pair.split("=");
      if (key && value) mapping.set(key.trim(), value.trim());
    }
  }
  return mapping;
}

export namespace Config {
  export const port = Number(process.env.PROXY_PORT ?? 3100);
  export const host = process.env.PROXY_HOST ?? "127.0.0.1";
  export const adminApiKey = process.env.ADMIN_API_KEY ?? "";
  export const cliProxyApiUrl = process.env.CLI_PROXY_API_URL ?? "http://localhost:8317";
  export const claudeCodeVersion = process.env.CLAUDE_CODE_VERSION ?? "2.1.87";
  export const cchSalt = process.env.CCH_SALT ?? "59cf53e54c78";
  export const cchPositions = JSON.parse(process.env.CCH_POSITIONS ?? "[4,7,20]") as number[];
  export const toolPrefix = process.env.TOOL_PREFIX ?? "mcp_";
  export const cliProxyApiKey = process.env.CLI_PROXY_API_KEY ?? "proxy";
  export const dbPath = process.env.DB_PATH ?? "data/proxy.db";
  export const pricingCacheTtlMs = Number(process.env.PRICING_CACHE_TTL_MS ?? 3600000);
  export const pricingCachePath = process.env.PRICING_CACHE_PATH ?? "data/pricing-cache.json";
  export const logLevel = process.env.LOG_LEVEL ?? "info";
  export const clientNameMapping = loadClientMapping();
  export const cliproxyMgmtKey = process.env.CLIPROXY_MGMT_KEY ?? "";
  export const cliproxyCorrelationIntervalMs = Number(
    process.env.CLIPROXY_CORRELATION_INTERVAL_MS ?? 15000,
  );
  export const cliproxyCorrelationLookbackMs = Number(
    process.env.CLIPROXY_CORRELATION_LOOKBACK_MS ?? 300000,
  );
  export const cliproxyAuthDir = process.env.CLIPROXY_AUTH_DIR ?? "";
  export const quotaRefreshTimeoutMs = Number(
    process.env.QUOTA_REFRESH_TIMEOUT_MS ?? 15000,
  );
}
