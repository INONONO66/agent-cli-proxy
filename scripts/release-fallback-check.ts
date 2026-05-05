import { stat } from "node:fs/promises";

const requiredFiles = ["dist/cli.js", "dist/index.js"];

async function assertFile(path: string): Promise<void> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`${path} is not a file`);
}

for (const path of requiredFiles) {
  await assertFile(path);
}

const cliText = await Bun.file("dist/cli.js").text();
if (!cliText.startsWith("#!/usr/bin/env bun")) {
  throw new Error("dist/cli.js is missing the Bun shebang");
}

console.log("Fallback release artifact check passed");
