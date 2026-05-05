import { expect, test } from "bun:test";

const rootDir = new URL("../..", import.meta.url).pathname;

async function run(command: string[]): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn(command, {
    cwd: rootDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, output: `${stdout}\n${stderr}` };
}

test("release package metadata is populated for npm publishing", async () => {
  const pkg = await Bun.file(`${rootDir}/package.json`).json();

  expect(pkg.private).toBe(false);
  expect(pkg.description).toContain("AI API proxy");
  expect(pkg.keywords).toEqual(expect.arrayContaining(["ai", "proxy", "anthropic", "openai", "self-hosted"]));
  expect(pkg.homepage).toBe("https://github.com/INONONO66/agent-cli-proxy");
  expect(pkg.repository).toEqual({
    type: "git",
    url: "git+https://github.com/INONONO66/agent-cli-proxy.git",
  });
  expect(pkg.bugs).toEqual({ url: "https://github.com/INONONO66/agent-cli-proxy/issues" });
  expect(pkg.license).toBe("MIT");
  expect(pkg.author).toBe("Agent CLI Proxy contributors");
  expect(pkg.engines).toEqual({ bun: ">=1.0.0", node: ">=20.0.0" });
  expect(pkg.bin).toEqual({ "agent-cli-proxy": "./dist/cli.js" });
  expect(pkg.files).toEqual(["dist", "README.md", "LICENSE"]);
});

test("pack dry-run includes only required install artifacts after build", async () => {
  const build = await run(["bun", "run", "build"]);
  expect(build.exitCode, build.output).toBe(0);

  const cliText = await Bun.file(`${rootDir}/dist/cli.js`).text();
  expect(cliText.startsWith("#!/usr/bin/env bun")).toBe(true);

  const pack = await run(["bun", "pm", "pack", "--dry-run"]);
  expect(pack.exitCode, pack.output).toBe(0);

  for (const expected of ["dist/index.js", "dist/cli.js", "README.md", "LICENSE", "package.json"]) {
    expect(pack.output).toContain(expected);
  }
});
