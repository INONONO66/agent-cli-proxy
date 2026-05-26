import { join, normalize, resolve } from "node:path";
import { Logger } from "../util/logger";

const logger = Logger.fromConfig().child({ component: "dashboard" });
const distRoot = resolve("dist/dashboard");
const devIndex = resolve("src/dashboard/index.html");
const distIndex = join(distRoot, "index.html");

export namespace Dashboard {
  export function createHandler() {
    return async function handleDashboard(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const distIndexFile = Bun.file(distIndex);
      if (await distIndexFile.exists()) return serveFromDist(url.pathname, distIndexFile);

      const devIndexFile = Bun.file(devIndex);
      if (process.env.NODE_ENV !== "production" && await devIndexFile.exists()) {
        return fileResponse(devIndexFile, "text/html");
      }

      logger.warn("dashboard asset missing", { event: "dashboard.missing", path: url.pathname });
      return new Response("Dashboard not built", { status: 404 });
    };
  }
}

async function serveFromDist(pathname: string, indexFile: Bun.BunFile): Promise<Response> {
  const relative = pathname.replace(/^\/dashboard\/?/, "") || "index.html";
  const filePath = safeJoin(distRoot, relative);
  if (filePath) {
    const file = Bun.file(filePath);
    if (await file.exists()) return fileResponse(file, mimeType(filePath));
  }
  return fileResponse(indexFile, "text/html");
}

function safeJoin(root: string, relative: string): string | null {
  const normalized = normalize(relative).replace(/^(\.\.(?:\/|\\|$))+/, "");
  const resolved = resolve(root, normalized);
  return resolved.startsWith(`${root}/`) || resolved === root ? resolved : null;
}

function fileResponse(file: Bun.BunFile, contentType: string): Response {
  return new Response(file, {
    status: 200,
    headers: { "content-type": contentType },
  });
}

function mimeType(path: string): string {
  if (path.endsWith(".js")) return "application/javascript";
  if (path.endsWith(".css")) return "text/css";
  if (path.endsWith(".html")) return "text/html";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}
