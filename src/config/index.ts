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
  export const cliProxyApiUrl = process.env.CLI_PROXY_API_URL ?? "http://localhost:8317";
  export const claudeCodeVersion = process.env.CLAUDE_CODE_VERSION ?? "2.1.87";
  export const cchSalt = process.env.CCH_SALT ?? "59cf53e54c78";
  export const cchPositions = JSON.parse(process.env.CCH_POSITIONS ?? "[4,7,20]") as number[];
  export const toolPrefix = process.env.TOOL_PREFIX ?? "mcp_";
  export const cliProxyApiKey = process.env.CLI_PROXY_API_KEY ?? "proxy";
  export const dbPath = process.env.DB_PATH ?? "data/proxy.db";
  export const pricingCacheTtlMs = Number(process.env.PRICING_CACHE_TTL_MS ?? 3600000);
  export const logLevel = process.env.LOG_LEVEL ?? "info";
  export const clientNameMapping = loadClientMapping();
  export const dashboardUsername = process.env.DASHBOARD_USERNAME ?? "admin";
  export const dashboardPasswordHash = process.env.DASHBOARD_PASSWORD_HASH ?? "";
  export const dashboardJwtSecret = process.env.DASHBOARD_JWT_SECRET ?? crypto.randomUUID();
  export const dashboardSessionTtl = process.env.DASHBOARD_SESSION_TTL ?? "24h";
  export const prometheusUrl = process.env.PROMETHEUS_URL ?? "http://localhost:9090";
  export const lokiUrl = process.env.LOKI_URL ?? "http://localhost:3101";
}
