import { config } from "./config";
import { handleRequest } from "./server/handleRequest";
import { fetchPricing } from "./services/pricingService";

fetchPricing().catch((err) => {
  console.warn("[startup] pricing fetch failed:", err);
});

const server = Bun.serve({
  port: config.port,
  idleTimeout: 0,
  fetch: handleRequest,
});

console.log(`Server running at http://localhost:${config.port}`);
