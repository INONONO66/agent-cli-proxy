import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const rootDir = join(import.meta.dir, "..", "..");
let tempDirs: string[] = [];

afterEach(() => {
  const dirs = tempDirs;
  tempDirs = [];
  return Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function waitForExit(proc: Bun.Subprocess<"ignore", "pipe", "pipe">, timeoutMs: number): Promise<number> {
  let timeout: Timer | null = null;
  try {
    return await Promise.race([
      proc.exited,
      new Promise<number>((resolve) => {
        timeout = setTimeout(() => {
          proc.kill();
          resolve(-1);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

test("startup reports a clear port-in-use error when Bun.serve cannot bind", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-cli-proxy-startup-port-"));
  tempDirs.push(dir);
  const pricingCachePath = join(dir, "pricing-cache.json");
  await writeFile(pricingCachePath, "{}\n");
  const occupied = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      return new Response("occupied");
    },
  });

  try {
    const proc = Bun.spawn(["bun", "run", "src/index.ts"], {
      cwd: rootDir,
      env: {
        ...process.env,
        PROXY_HOST: "127.0.0.1",
        PROXY_PORT: String(occupied.port),
        PROXY_LOCAL_OK: "1",
        CLI_PROXY_API_URL: "http://localhost:8317",
        DB_PATH: join(dir, "proxy.db"),
        PRICING_CACHE_PATH: pricingCachePath,
        DISABLE_SHUTDOWN_HANDLERS: "1",
        LOG_LEVEL: "error",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      waitForExit(proc, 5_000),
    ]);

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("startup.port_in_use");
    expect(stderr).toContain("set PROXY_PORT to a different port");
  } finally {
    await occupied.stop(true);
  }
});
