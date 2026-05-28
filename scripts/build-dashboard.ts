import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const outDir = "dist/dashboard";
const assetsDir = join(outDir, "assets");

await rm(outDir, { recursive: true, force: true });
await mkdir(assetsDir, { recursive: true });

const result = await Bun.build({
  entrypoints: ["src/dashboard/app.ts"],
  target: "browser",
  minify: true,
  outdir: assetsDir,
  naming: "app.js",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

await Bun.write(join(outDir, "index.html"), await Bun.file("src/dashboard/index.html").text());
await Bun.write(join(outDir, "styles.css"), await Bun.file("src/dashboard/styles.css").text());
