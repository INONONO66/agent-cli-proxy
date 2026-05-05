import { chmod } from "node:fs/promises";

const cliPath = "dist/cli.js";
const shebang = "#!/usr/bin/env bun\n";

const cliFile = Bun.file(cliPath);
const cliText = await cliFile.text();

if (!cliText.startsWith("#!/usr/bin/env")) {
  await Bun.write(cliPath, `${shebang}${cliText}`);
}

await chmod(cliPath, 0o755);
