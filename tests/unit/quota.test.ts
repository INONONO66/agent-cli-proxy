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

test("QuotaProbe.refresh skips disabled auth files without probing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-cli-proxy-quota-disabled-"));
  tempDirs.push(dir);
  await writeFile(join(dir, "account.json"), JSON.stringify({
    type: "claude",
    email: "disabled@example.com",
    disabled: true,
  }));

  const script = [
    "const { QuotaProbe } = await import('./src/cliproxy/quota/index.ts');",
    "const result = await QuotaProbe.refresh();",
    "console.log(JSON.stringify(result.accounts));",
  ].join(" ");
  const proc = Bun.spawn(["bun", "--eval", script], {
    cwd: rootDir,
    env: {
      ...process.env,
      CLIPROXY_AUTH_DIR: dir,
      PROXY_LOCAL_OK: "1",
      LOG_LEVEL: "error",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  const accounts = JSON.parse(stdout) as unknown;

  expect(accounts).toEqual([expect.objectContaining({
    provider: "claude",
    account: "disabled@example.com",
    status: "disabled",
    unavailable: false,
    disabled: true,
    error: "auth file marked disabled",
    windows: [],
  })]);
});
