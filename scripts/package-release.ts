#!/usr/bin/env bun

import { cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

interface PackageJson {
  version: string;
}

const root = resolve(import.meta.dir, "..");
const releaseDir = join(root, "dist", "release");
const payloadDir = join(releaseDir, "agent-cli-proxy");
const packageJson = await Bun.file(join(root, "package.json")).json() as PackageJson;
const version = packageJson.version;
const stableArchive = join(releaseDir, "agent-cli-proxy.tar.gz");
const versionedArchive = join(releaseDir, `agent-cli-proxy-v${version}.tar.gz`);

async function copyIfExists(from: string, to: string): Promise<void> {
  try {
    await stat(from);
  } catch {
    return;
  }
  await cp(from, to, { recursive: true });
}

async function copyFilesByPrefix(fromDir: string, toDir: string, prefix: string): Promise<void> {
  const glob = new Bun.Glob(`${prefix}*`);
  for await (const file of glob.scan({ cwd: fromDir, onlyFiles: true })) {
    await cp(join(fromDir, file), join(toDir, file));
  }
}

await rm(releaseDir, { recursive: true, force: true });
await mkdir(payloadDir, { recursive: true });

await cp(join(root, "dist", "index.js"), join(payloadDir, "index.js"));
await cp(join(root, "dist", "cli.js"), join(payloadDir, "cli.js"));
await copyFilesByPrefix(join(root, "dist"), payloadDir, "index-");
await copyIfExists(join(root, "dist", "dashboard-server.js"), join(payloadDir, "dashboard-server.js"));
await copyIfExists(join(root, "dist", "migrations"), join(payloadDir, "migrations"));
await copyIfExists(join(root, "dist", "dashboard"), join(payloadDir, "dashboard"));
await copyIfExists(join(root, "README.md"), join(payloadDir, "README.md"));
await copyIfExists(join(root, "CHANGELOG.md"), join(payloadDir, "CHANGELOG.md"));
await copyIfExists(join(root, "LICENSE"), join(payloadDir, "LICENSE"));
await writeFile(join(payloadDir, "VERSION"), `${version}\n`);

for (const output of [stableArchive, versionedArchive]) {
  const proc = Bun.spawn(["tar", "-czf", output, "agent-cli-proxy"], {
    cwd: releaseDir,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`tar failed with exit code ${code}`);
}

console.log(`Created ${stableArchive}`);
console.log(`Created ${versionedArchive}`);
