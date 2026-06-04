import { Logger } from "./util/logger";
import { UnsupportedBunVersionError, assertSupportedBunVersion } from "./runtime/bun-version";

const logger = Logger.fromConfig().child({ component: "startup" });
export const shutdownController = new AbortController();

async function main(): Promise<void> {
  assertSupportedBunVersion(Bun.version);

  const { Config } = await import("./config");
  const { UpstreamClient } = await import("./upstream/client");
  const { Storage } = await import("./storage/db");
  const { UsageService } = await import("./storage/service");
  const { Pricing } = await import("./storage/pricing");
  const { Handler } = await import("./server/handler");
  const { Session } = await import("./admin/session");
  const { Correlator } = await import("./cliproxy/correlator");
  const { Supervisor } = await import("./runtime/supervisor");
  const { Shutdown } = await import("./runtime/shutdown");

  UpstreamClient.configure({
    breakerOpenAfterFailures: Config.breakerOpenAfterFailures,
    breakerHalfOpenAfterMs: Config.breakerHalfOpenAfterMs,
    breakerEvictAfterMs: Config.breakerEvictAfterMs,
    rateLimitMaxRetries: Config.rateLimitMaxRetries,
  });

  Pricing.fetchPricing().catch((err) => {
    logger.warn("pricing fetch failed", { err });
  });
  Pricing.startBackgroundRefresh({ signal: shutdownController.signal });

  Storage.backupBeforeStart(Config.dbPath);
  const db = Storage.initDb(Config.dbPath);
  Storage.recoverStalePending(db, Config.stalePendingMaxAgeMs);
  const usageService = UsageService.create(db);
  UsageService.startCostBackfillLoop(usageService, { signal: shutdownController.signal });
  const dashboardSessionSecret = Config.dashboardSessionSecret || await Session.resolveSecret(Config.dbPath);
  const handleRequest = Handler.create(usageService, {
    sessionConfig: {
      passwordHash: Config.dashboardPasswordHash,
      secret: dashboardSessionSecret,
      ttlMs: Config.dashboardSessionTtlMs,
    },
    oauthConfig: {
      authDir: Config.cliproxyAuthDir,
      binaryPath: Config.cliproxyBinaryPath,
      configPath: Config.cliproxyConfigPath,
      timeoutMs: Config.oauthJobTimeoutMs,
    },
  });

  Correlator.start(usageService, { signal: shutdownController.signal });
  await usageService.startQuotaRefresh({ signal: shutdownController.signal });
  Supervisor.startQuotaRetentionLoop(db, { signal: shutdownController.signal });

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      port: Config.port,
      hostname: Config.host,
      idleTimeout: 0,
      fetch: handleRequest,
      development:
        process.env.NODE_ENV !== "production"
          ? { hmr: true, console: true }
          : undefined,
    });
  } catch (err) {
    if (isPortInUseError(err, Config.port)) {
      logger.error("port already in use", {
        event: "startup.port_in_use",
        err,
        host: Config.host,
        port: Config.port,
        hint: "another agent-cli-proxy may be running, or set PROXY_PORT to a different port",
      });
      process.exit(1);
    }
    throw err;
  }

  if (process.env.NODE_ENV !== "test" && process.env.DISABLE_SHUTDOWN_HANDLERS !== "1") {
    const shutdownOptions = { server, db, supervisor: Supervisor };
    Shutdown.register(shutdownOptions);
    Shutdown.registerCrashHandlers(shutdownOptions);
  }

  logger.info("server running", { host: Config.host, port: Config.port, url: `http://${Config.host}:${Config.port}` });
}

main().catch((err) => {
  if (err instanceof Error && (err as { code?: string }).code === "CONFIG_INVALID") {
    logger.error("configuration validation failed", { event: "config.error", err, issues: (err as { issues?: unknown }).issues });
  } else if (err instanceof UnsupportedBunVersionError) {
    logger.error("unsupported Bun runtime", {
      event: "startup.bun_version_unsupported",
      err,
      currentVersion: err.currentVersion,
      minimumVersion: err.minimumVersion,
    });
  } else {
    logger.error("startup failed", { event: "startup.error", err });
  }
  process.exit(1);
});

function isPortInUseError(err: unknown, port: number): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (code === "EADDRINUSE") return true;
  const message = err.message.toLowerCase();
  return message.includes("eaddrinuse") || message.includes(`port ${port} in use`);
}
