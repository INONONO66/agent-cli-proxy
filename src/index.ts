import { Logger } from "./util/logger";

const logger = Logger.fromConfig().child({ component: "startup" });
export const shutdownController = new AbortController();

async function main(): Promise<void> {
  const { Config } = await import("./config");
  const { Storage } = await import("./storage/db");
  const { UsageService } = await import("./storage/service");
  const { Pricing } = await import("./storage/pricing");
  const { Handler } = await import("./server/handler");
  const { Correlator } = await import("./cliproxy/correlator");

  Pricing.fetchPricing().catch((err) => {
    logger.warn("pricing fetch failed", { err });
  });
  Pricing.startBackgroundRefresh({ signal: shutdownController.signal });

  const db = Storage.initDb(Config.dbPath);
  Storage.recoverStalePending(db);
  const usageService = UsageService.create(db);
  UsageService.startCostBackfillLoop(usageService, { signal: shutdownController.signal });
  const handleRequest = Handler.create(usageService);

  Correlator.start(usageService, { signal: shutdownController.signal });
  await usageService.startQuotaRefresh({ signal: shutdownController.signal });

  Bun.serve({
    port: Config.port,
    hostname: Config.host,
    idleTimeout: 0,
    fetch: handleRequest,
    development:
      process.env.NODE_ENV !== "production"
        ? { hmr: true, console: true }
        : undefined,
  });

  logger.info("server running", { host: Config.host, port: Config.port, url: `http://${Config.host}:${Config.port}` });
}

main().catch((err) => {
  if (err instanceof Error && (err as { code?: string }).code === "CONFIG_INVALID") {
    logger.error("configuration validation failed", { event: "config.error", err, issues: (err as { issues?: unknown }).issues });
  } else {
    logger.error("startup failed", { event: "startup.error", err });
  }
  process.exit(1);
});
