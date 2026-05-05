#!/usr/bin/env bun
import { mkdir, chmod, copyFile, rm, cp, writeFile, open } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Storage } from "./storage/db";
import { ConfigError } from "./config/validate";
import { Logger } from "./util/logger";

type EnvMap = Record<string, string>;

const APP_NAME = "agent-cli-proxy";
const HOME = homedir();
const XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME ?? join(HOME, ".config");
const XDG_DATA_HOME = process.env.XDG_DATA_HOME ?? join(HOME, ".local", "share");

const defaultConfigDir = join(XDG_CONFIG_HOME, APP_NAME);
const defaultDataDir = join(XDG_DATA_HOME, APP_NAME);
const defaultRuntimeDir = join(XDG_DATA_HOME, APP_NAME, "runtime");
const defaultEnvPath = join(defaultConfigDir, ".env");
const defaultDbPath = join(defaultDataDir, "proxy.db");
const defaultPricingCachePath = join(defaultDataDir, "pricing-cache.json");

const packageRoot = resolve(dirname(Bun.fileURLToPath(import.meta.url)), "..");
const packagedDistDir = dirname(Bun.fileURLToPath(import.meta.url));
const logger = Logger.fromConfig().child({ component: "cli" });

function writeOut(message = ""): void {
  process.stdout.write(`${message}\n`);
}

function writeErr(message = ""): void {
  process.stderr.write(`${message}\n`);
}

async function main(): Promise<void> {
  const [command = "help", subcommand = ""] = process.argv.slice(2);

  switch (command) {
    case "init":
      await initCommand();
      return;
    case "db":
      if (subcommand === "init") {
        await initDbCommand();
        return;
      }
      break;
    case "service":
      await serviceCommand(subcommand);
      return;
    case "backfill-costs":
      await backfillCostsCommand();
      return;
    case "paths":
      printPaths();
      return;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
  }

  writeErr(`Unknown command: ${command}${subcommand ? ` ${subcommand}` : ""}`);
  printHelp();
  process.exit(1);
}

async function initCommand(): Promise<void> {
  const rl = createInterface({ input, output });
  try {
    writeOut("agent-cli-proxy installer\n");

    const envPath = await ask(rl, "Config .env path", defaultEnvPath);
    const dataDir = await ask(rl, "Data directory", defaultDataDir);
    const runtimeDir = await ask(rl, "Runtime directory", defaultRuntimeDir);
    const host = await ask(rl, "Proxy host", "127.0.0.1");
    const port = await ask(rl, "Proxy port", "3100");
    const cliProxyApiUrl = await ask(rl, "CLIProxyAPI URL", "http://localhost:8317");
    const cliProxyApiKey = await askSecret(rl, "CLIProxyAPI proxy key", "proxy");

    const exposeAdmin = host !== "127.0.0.1" && host !== "localhost" && host !== "::1";
    const adminApiKey = exposeAdmin || await confirm(rl, "Generate ADMIN_API_KEY for admin API?", false)
      ? crypto.randomUUID().replaceAll("-", "")
      : "";

    const enableCliproxyCorrelation = await confirm(rl, "Enable CLIProxyAPI account correlation?", false);
    const cliproxyMgmtKey = enableCliproxyCorrelation
      ? await askSecret(rl, "CLIProxyAPI management key", "")
      : "";
    const enableQuotaRefresh = await confirm(rl, "Enable subscription quota checks from local CLIProxyAPI auth files?", false);
    const cliproxyAuthDir = enableQuotaRefresh
      ? await ask(rl, "CLIProxyAPI auth directory", join(HOME, ".cli-proxy-api"))
      : "";

    const env: EnvMap = {
      PROXY_HOST: host,
      PROXY_PORT: port,
      ADMIN_API_KEY: adminApiKey,
      CLI_PROXY_API_URL: cliProxyApiUrl,
      CLI_PROXY_API_KEY: cliProxyApiKey,
      CLAUDE_CODE_VERSION: "2.1.87",
      DB_PATH: join(dataDir, "proxy.db"),
      PRICING_CACHE_PATH: join(dataDir, "pricing-cache.json"),
      PRICING_CACHE_TTL_MS: "3600000",
      CLIENT_NAME_MAPPING: "",
      CLIPROXY_MGMT_KEY: cliproxyMgmtKey,
      CLIPROXY_CORRELATION_INTERVAL_MS: "15000",
      CLIPROXY_CORRELATION_LOOKBACK_MS: "300000",
      CLIPROXY_AUTH_DIR: cliproxyAuthDir,
      QUOTA_REFRESH_TIMEOUT_MS: "15000",
    };

    await mkdir(dirname(envPath), { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await mkdir(runtimeDir, { recursive: true });
    await writeEnv(envPath, env);
    await chmod(envPath, 0o600);
    await initDbAt(env.DB_PATH);

    writeOut("\nCreated:");
    writeOut(`  env: ${envPath}`);
    writeOut(`  db:  ${env.DB_PATH}`);
    writeOut(`  data: ${dataDir}`);
    writeOut(`  runtime: ${runtimeDir}`);

    if (await confirm(rl, "Install user daemon now?", platform() === "linux" || platform() === "darwin")) {
      await installRuntime(runtimeDir, envPath);
      await installService(runtimeDir, envPath);
    }
  } finally {
    rl.close();
  }
}

async function initDbCommand(): Promise<void> {
  const envPath = getArg("--env") ?? defaultEnvPath;
  const env = parseEnvFile(envPath);
  await initDbAt(env.DB_PATH ?? defaultDbPath);
  writeOut(`Initialized DB at ${env.DB_PATH ?? defaultDbPath}`);
}

async function backfillCostsCommand(): Promise<void> {
  const envPath = getArg("--env") ?? defaultEnvPath;
  const env = parseEnvFile(envPath);
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }
  const { Config } = await import("./config/validate");
  Config.validate(process.env);
  const { UsageService } = await import("./storage/service");
  const dbPath = env.DB_PATH ?? defaultDbPath;
  const db = Storage.initDb(dbPath);
  const usageService = UsageService.create(db);
  const result = await usageService.backfillCosts({
    onlyZeroCost: !process.argv.includes("--all"),
    limit: parsePositiveLimit(),
  });
  writeOut(`[backfill-costs] scanned=${result.scanned} updated=${result.updated}`);
  db.close();
}

async function serviceCommand(subcommand: string): Promise<void> {
  const envPath = getArg("--env") ?? defaultEnvPath;
  const runtimeDir = getArg("--runtime-dir") ?? defaultRuntimeDir;

  switch (subcommand) {
    case "install":
      await installRuntime(runtimeDir, envPath);
      await installService(runtimeDir, envPath);
      return;
    case "start":
    case "stop":
    case "restart":
    case "status":
      await controlService(subcommand);
      return;
  }

  writeErr("Usage: agent-cli-proxy service <install|start|stop|restart|status>");
  process.exit(1);
}

async function installRuntime(runtimeDir: string, envPath: string): Promise<void> {
  await mkdir(runtimeDir, { recursive: true });
  const distDir = resolveDistDir();
  if (!existsSync(join(distDir, "index.js"))) {
    throw new Error("dist/index.js not found. Run `bun run build` first.");
  }

  await copyFile(join(distDir, "index.js"), join(runtimeDir, "index.js"));
  await copyGlobByPrefix(distDir, runtimeDir, "index-");
  await rm(join(runtimeDir, "migrations"), { recursive: true, force: true });
  await cp(join(distDir, "migrations"), join(runtimeDir, "migrations"), { recursive: true });
  await writeFile(join(runtimeDir, ".env.path"), `${envPath}\n`);
}

async function copyGlobByPrefix(fromDir: string, toDir: string, prefix: string): Promise<void> {
  const glob = new Bun.Glob(`${prefix}*`);
  for await (const file of glob.scan({ cwd: fromDir, onlyFiles: true })) {
    await copyFile(join(fromDir, file), join(toDir, file));
  }
}

async function installService(runtimeDir: string, envPath: string): Promise<void> {
  if (platform() === "linux") {
    const unitDir = join(XDG_CONFIG_HOME, "systemd", "user");
    const unitPath = getArg("--service-path") ?? join(unitDir, `${APP_NAME}.service`);
    await mkdir(dirname(unitPath), { recursive: true });
    await writeFile(unitPath, renderSystemdUserService(runtimeDir, envPath));
    writeOut(`Installed systemd user service: ${unitPath}`);
    writeOut(`Run: systemctl --user daemon-reload && systemctl --user enable --now ${APP_NAME}`);
    return;
  }

  if (platform() === "darwin") {
    const launchDir = join(HOME, "Library", "LaunchAgents");
    const plistPath = getArg("--service-path") ?? join(launchDir, `ai.agent-cli-proxy.plist`);
    await mkdir(dirname(plistPath), { recursive: true });
    await writeFile(plistPath, renderLaunchAgent(runtimeDir, envPath));
    writeOut(`Installed launchd agent: ${plistPath}`);
    writeOut(`Run: launchctl load ${plistPath}`);
    return;
  }

  throw new Error(`Unsupported service platform: ${platform()}`);
}

async function controlService(action: string): Promise<void> {
  if (platform() !== "linux") {
    writeOut("Service control is only automated for systemd user services. Use launchctl on macOS.");
    return;
  }
  const args = action === "status"
    ? ["--user", "--no-pager", "status", APP_NAME]
    : ["--user", action, APP_NAME];
  const proc = Bun.spawn(["systemctl", ...args], { stdout: "inherit", stderr: "inherit" });
  const exitCode = await proc.exited;
  if (exitCode !== 0) process.exit(exitCode);
}

function renderSystemdUserService(runtimeDir: string, envPath: string): string {
  assertSafePath(runtimeDir, "runtimeDir");
  assertSafePath(envPath, "envPath");
  return `[Unit]
Description=agent-cli-proxy - AI API Proxy with Usage Monitoring
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${systemdEscape(runtimeDir)}
Environment=NODE_ENV=production
Environment=PATH=${systemdEscape(`${HOME}/.bun/bin:/usr/local/bin:/usr/bin:/bin`)}
EnvironmentFile=${systemdEscape(envPath)}
ExecStart=${systemdEscape(`${HOME}/.bun/bin/bun`)} run index.js
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function renderLaunchAgent(runtimeDir: string, envPath: string): string {
  assertSafePath(runtimeDir, "runtimeDir");
  assertSafePath(envPath, "envPath");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.agent-cli-proxy</string>
  <key>WorkingDirectory</key><string>${xmlEscape(runtimeDir)}</string>
  <key>ProgramArguments</key>
  <array><string>${xmlEscape(`${HOME}/.bun/bin/bun`)}</string><string>--env-file</string><string>${xmlEscape(envPath)}</string><string>run</string><string>index.js</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>NODE_ENV</key><string>production</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
`;
}

async function initDbAt(dbPath: string): Promise<void> {
  await mkdir(dirname(dbPath), { recursive: true });
  const db = Storage.initDb(dbPath);
  db.close();
}

async function writeEnv(path: string, env: EnvMap): Promise<void> {
  const lines = Object.entries(env).map(([key, value]) => `${key}=${quoteEnv(value)}`);
  const handle = await open(path, "w", 0o600);
  try {
    await handle.writeFile(`${lines.join("\n")}\n`);
  } finally {
    await handle.close();
  }
}

function quoteEnv(value: string): string {
  if (/^[A-Za-z0-9_./:@-]*$/.test(value)) return value;
  return JSON.stringify(value);
}

function parseEnvFile(path: string): EnvMap {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf-8");
  const env: EnvMap = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    env[trimmed.slice(0, idx)] = trimmed.slice(idx + 1).replace(/^"|"$/g, "");
  }
  return env;
}

function parsePositiveLimit(): number | undefined {
  const value = getArg("--limit");
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function ask(rl: ReturnType<typeof createInterface>, question: string, fallback: string): Promise<string> {
  const answer = await rl.question(`${question} (${fallback}): `);
  return answer.trim() || fallback;
}

async function askSecret(rl: ReturnType<typeof createInterface>, question: string, fallback: string): Promise<string> {
  if (!process.stdin.isTTY) return ask(rl, question, fallback);
  const mutableOutput = output as NodeJS.WriteStream;
  const originalWrite = mutableOutput.write.bind(mutableOutput);
  let muted = false;
  mutableOutput.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((err?: Error | null) => void), cb?: (err?: Error | null) => void) => {
    if (muted) return true;
    return originalWrite(chunk, encoding as BufferEncoding, cb);
  }) as typeof mutableOutput.write;
  try {
    muted = true;
    const answer = await rl.question(`${question}${fallback ? " (configured)" : ""}: `);
    muted = false;
    originalWrite("\n");
    return answer.trim() || fallback;
  } finally {
    mutableOutput.write = originalWrite as typeof mutableOutput.write;
  }
}

function resolveDistDir(): string {
  if (existsSync(join(packagedDistDir, "index.js"))) return packagedDistDir;
  const sourceTreeDist = join(packageRoot, "dist");
  if (existsSync(join(sourceTreeDist, "index.js"))) return sourceTreeDist;
  const cwdDist = resolve("dist");
  if (existsSync(join(cwdDist, "index.js"))) return cwdDist;
  return packagedDistDir;
}

function assertSafePath(path: string, label: string): void {
  if (/[\u0000-\u001f\u007f\n\r]/.test(path)) {
    throw new Error(`${label} contains unsupported control characters`);
  }
}

function systemdEscape(value: string): string {
  if (/^[A-Za-z0-9_/@%+=:,.-]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function confirm(rl: ReturnType<typeof createInterface>, question: string, fallback: boolean): Promise<boolean> {
  const suffix = fallback ? "Y/n" : "y/N";
  const answer = (await rl.question(`${question} [${suffix}]: `)).trim().toLowerCase();
  if (!answer) return fallback;
  return answer === "y" || answer === "yes";
}

function getArg(name: string): string | undefined {
  const args = process.argv.slice(2);
  const exact = args.indexOf(name);
  if (exact >= 0) return args[exact + 1];
  const prefixed = args.find((arg) => arg.startsWith(`${name}=`));
  return prefixed?.slice(name.length + 1);
}

function printPaths(): void {
  writeOut(JSON.stringify({
    configDir: defaultConfigDir,
    dataDir: defaultDataDir,
    runtimeDir: defaultRuntimeDir,
    envPath: defaultEnvPath,
    dbPath: defaultDbPath,
    pricingCachePath: defaultPricingCachePath,
  }, null, 2));
}

function printHelp(): void {
  writeOut(`agent-cli-proxy

Usage:
  agent-cli-proxy init
  agent-cli-proxy db init [--env PATH]
  agent-cli-proxy service install [--env PATH] [--runtime-dir PATH] [--service-path PATH]
  agent-cli-proxy service start|stop|restart|status
  agent-cli-proxy backfill-costs
  agent-cli-proxy paths
`);
}

main().catch((err) => {
  if (err instanceof ConfigError || (err instanceof Error && (err as { code?: string }).code === "CONFIG_INVALID")) {
    logger.error("configuration validation failed", { event: "config.error", err, issues: (err as { issues?: unknown }).issues });
    process.exit(1);
  }
  writeErr(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
