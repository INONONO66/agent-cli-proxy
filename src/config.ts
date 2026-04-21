export const config = {
  port: Number(process.env.PROXY_PORT ?? 3100),
  cliProxyApiUrl: process.env.CLI_PROXY_API_URL ?? "http://localhost:8317",
  claudeCodeVersion: process.env.CLAUDE_CODE_VERSION ?? "2.1.87",
  cchSalt: process.env.CCH_SALT ?? "59cf53e54c78",
  cchPositions: JSON.parse(process.env.CCH_POSITIONS ?? "[4,7,20]") as number[],
  toolPrefix: process.env.TOOL_PREFIX ?? "mcp_",
  cliProxyApiKey: process.env.CLI_PROXY_API_KEY ?? "proxy",
  dbPath: process.env.DB_PATH ?? "data/proxy.db",
  pricingCacheTtlMs: Number(process.env.PRICING_CACHE_TTL_MS ?? 3600000),
  logLevel: process.env.LOG_LEVEL ?? "info",
  glmApiKey: process.env.GLM_API_KEY ?? "",
} as const;

export type Config = typeof config;
