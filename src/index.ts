import { config } from "./config";
import { handleRequest } from "./server/handleRequest";

const server = Bun.serve({
  port: config.port,
  idleTimeout: 0,
  fetch: handleRequest,
});

console.log(`Server running at http://localhost:${config.port}`);
