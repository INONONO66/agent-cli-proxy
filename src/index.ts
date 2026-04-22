import { Storage } from "./storage/db";
import { UsageService } from "./storage/service";
import { Pricing } from "./storage/pricing";
import { Handler } from "./server/handler";
import { Config } from "./config";

Pricing.fetchPricing().catch((err) => {
  console.warn("[startup] pricing fetch failed:", err);
});

const db = Storage.initDb(Config.dbPath);
const usageService = UsageService.create(db);
const handleRequest = Handler.create(usageService);

const server = Bun.serve({
  port: Config.port,
  idleTimeout: 0,
  fetch: handleRequest,
});

console.log(`Server running at http://localhost:${Config.port}`);
