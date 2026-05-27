import { join, normalize, resolve } from "node:path";
import { Logger } from "../util/logger";

const logger = Logger.fromConfig().child({ component: "dashboard" });
// resolve relative to the bundle's own directory so it works both in dev (cwd=project root)
// and in production (cwd=runtime dir where dashboard/ sits next to index.js)
const bundleDir = typeof import.meta.dir === "string" ? import.meta.dir : process.cwd();
const distRoot = resolve(bundleDir, "dashboard");
const distRootFallback = resolve("dist/dashboard");
const devIndex = resolve("src/dashboard/index.html");
const distIndex = join(distRoot, "index.html");
const distIndexFallback = join(distRootFallback, "index.html");

export namespace Dashboard {
  export function createHandler() {
    return async function handleDashboard(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const distIndexFile = Bun.file(distIndex);
      if (await distIndexFile.exists()) return serveFromDist(url.pathname, distRoot, distIndexFile);

      const fallbackIndexFile = Bun.file(distIndexFallback);
      if (await fallbackIndexFile.exists()) return serveFromDist(url.pathname, distRootFallback, fallbackIndexFile);

      const devIndexFile = Bun.file(devIndex);
      if (process.env.NODE_ENV !== "production" && await devIndexFile.exists()) {
        return fileResponse(devIndexFile, "text/html");
      }

      logger.warn("dashboard asset missing", { event: "dashboard.missing", path: url.pathname });
      return new Response("Dashboard not built", { status: 404 });
    };
  }
}

async function serveFromDist(pathname: string, root: string, indexFile: Bun.BunFile): Promise<Response> {
  const relative = pathname.replace(/^\/dashboard\/?/, "") || "index.html";
  const filePath = safeJoin(root, relative);
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
