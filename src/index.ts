import { Storage } from "./storage/db";
import { UsageService } from "./storage/service";
import { Pricing } from "./storage/pricing";
import { Handler } from "./server/handler";
import { Correlator } from "./cliproxy/correlator";
import { Config } from "./config";

Pricing.fetchPricing().catch((err) => {
  console.warn("[startup] pricing fetch failed:", err);
});

const db = Storage.initDb(Config.dbPath);
const usageService = UsageService.create(db);
const handleRequest = Handler.create(usageService);

Correlator.start(usageService);

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

console.log(`Server running at http://${Config.host}:${Config.port}`);
