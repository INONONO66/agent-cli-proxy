#!/usr/bin/env bun
import { mkdir, chmod, copyFile, rm, cp, writeFile, open, rename, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import defaultPlansDocument from "../data/plans.default.json";
import { Plans } from "./plans";
import { AccountSubscriptionRepo } from "./storage/account-subscriptions";
import { Storage } from "./storage/db";
import { Config, ConfigError, type ConfigIssue, type ValidatedConfig } from "./config/validate";
import { Logger } from "./util/logger";
import { validateProviderDocument, type ProviderDefinition, type ProviderSchemaIssue } from "./provider/registry-schema";

type EnvMap = Record<string, string>;
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | true>;
}

interface CommandContext {
  args: ParsedArgs;
}

interface EnvWriteOptions {
  force: boolean;
  merge?: boolean;
}

interface CheckResult {
  status: "PASS" | "FAIL";
  issues: string[];
  details?: unknown;
}

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
const defaultPlansPath = join(defaultConfigDir, "plans.json");
const defaultProvidersPath = join(defaultConfigDir, "providers.json");

const packageRoot = resolve(dirname(Bun.fileURLToPath(import.meta.url)), "..");
const packagedDistDir = dirname(Bun.fileURLToPath(import.meta.url));
const logger = Logger.fromConfig().child({ component: "cli" });

function writeOut(message = ""): void {
  process.stdout.write(`${message}\n`);
}

function writeErr(message = ""): void {
  process.stderr.write(`${message}\n`);
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const eq = arg.indexOf("=");
    if (eq > 0) {
      const name = arg.slice(0, eq);
      const value = arg.slice(eq + 1);
      if (value.startsWith("--")) throw new Error(`${name} value must not start with --`);
      flags.set(name, value);
      continue;
    }

    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(arg, next);
      index += 1;
    } else {
      flags.set(arg, true);
    }
  }

  return { positional, flags };
}

export function getFlagValue(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  if (value === undefined) return undefined;
  if (value === true) throw new Error(`${name} requires a value`);
  if (value.startsWith("--")) throw new Error(`${name} value must not start with --`);
  return value;
}

function hasFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name);
}

async function main(): Promise<void> {
  const exitCode = await runCli(process.argv.slice(2));
  if (exitCode !== 0) process.exit(exitCode);
}

export async function runCli(argv: string[]): Promise<number> {
  try {
    const args = parseArgs(argv);
    const [command = hasFlag(args, "--help") ? "help" : "help", subcommand = ""] = args.positional;
    const ctx: CommandContext = { args };

    switch (command) {
      case "init":
        await initCommand(ctx);
        return 0;
      case "doctor":
        return await doctorCommand(ctx);
      case "db":
        if (subcommand === "init") {
          await initDbCommand(ctx);
          return 0;
        }
        break;
      case "service":
        return await serviceCommand(ctx, subcommand);
      case "backfill-costs":
        await backfillCostsCommand(ctx);
        return 0;
      case "plans":
        await plansCommand(ctx, subcommand);
        return 0;
      case "providers":
        await providersCommand(ctx, subcommand);
        return 0;
      case "paths":
        printPaths();
        return 0;
      case "help":
      case "--help":
      case "-h":
        printHelp();
        return 0;
    }

    writeErr(`Unknown command: ${command}${subcommand ? ` ${subcommand}` : ""}`);
    printHelp();
    return 1;
  } catch (err) {
    if (err instanceof ConfigError || (err instanceof Error && (err as { code?: string }).code === "CONFIG_INVALID")) {
      logger.error("configuration validation failed", { event: "config.error", err, issues: (err as { issues?: unknown }).issues });
      writeErr(err instanceof Error ? err.message : String(err));
      return 1;
    }
    writeErr(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

async function initCommand(ctx: CommandContext): Promise<void> {
  if (hasFlag(ctx.args, "--non-interactive")) {
    await initNonInteractive(ctx);
    return;
  }
  await initInteractive(ctx);
}

async function initInteractive(ctx: CommandContext): Promise<void> {
  const rl = createInterface({ input, output });
  try {
    writeOut("agent-cli-proxy installer\n");

    const envPath = await ask(rl, "Config .env path", getFlagValue(ctx.args, "--env") ?? defaultEnvPath);
    const dataDir = await ask(rl, "Data directory", getFlagValue(ctx.args, "--data-dir") ?? defaultDataDir);
    const runtimeDir = await ask(rl, "Runtime directory", getFlagValue(ctx.args, "--runtime-dir") ?? defaultRuntimeDir);
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

    const env = buildEnv({
      host,
      port,
      adminApiKey,
      cliProxyApiUrl,
      cliProxyApiKey,
      dataDir,
      cliproxyMgmtKey,
      cliproxyAuthDir,
    });

    await completeInit(envPath, dataDir, runtimeDir, env, writeOptions(ctx));

    if (await confirm(rl, "Install user daemon now?", platform() === "linux" || platform() === "darwin")) {
      await installRuntime(runtimeDir, envPath);
      await installService(ctx, runtimeDir, envPath);
    }
  } finally {
    rl.close();
  }
}

async function initNonInteractive(ctx: CommandContext): Promise<void> {
  logger.info("non-interactive init started", { event: "cli.init.non_interactive" });
  const envPath = getFlagValue(ctx.args, "--env") ?? process.env.AGENT_CLI_PROXY_ENV ?? defaultEnvPath;
  const dataDir = getFlagValue(ctx.args, "--data-dir") ?? process.env.AGENT_CLI_PROXY_DATA_DIR ?? defaultDataDir;
  const runtimeDir = getFlagValue(ctx.args, "--runtime-dir") ?? process.env.AGENT_CLI_PROXY_RUNTIME_DIR ?? defaultRuntimeDir;
  const host = getFlagValue(ctx.args, "--host") ?? process.env.PROXY_HOST ?? "127.0.0.1";
  const port = getFlagValue(ctx.args, "--port") ?? process.env.PROXY_PORT ?? "3100";
  const cliProxyApiUrl = getFlagValue(ctx.args, "--cliproxy-api-url") ?? process.env.CLI_PROXY_API_URL;
  if (!cliProxyApiUrl && process.env.PROXY_LOCAL_OK !== "1") {
    throw new Error("CLI_PROXY_API_URL is required for init --non-interactive unless PROXY_LOCAL_OK=1");
  }
  const cliProxyApiKey = readSecretFromEnvFlag(ctx.args, "--cliproxy-api-key-env", "CLI_PROXY_API_KEY") ?? "proxy";
  const adminApiKey = getFlagValue(ctx.args, "--admin-token")
    ?? readNamedEnv(ctx.args, "--admin-token-env")
    ?? process.env.ADMIN_API_KEY
    ?? "";
  const cliproxyMgmtKey = readNamedEnv(ctx.args, "--cliproxy-mgmt-key-env") ?? process.env.CLIPROXY_MGMT_KEY ?? "";
  const cliproxyAuthDir = getFlagValue(ctx.args, "--cliproxy-auth-dir") ?? process.env.CLIPROXY_AUTH_DIR ?? "";

  const env = buildEnv({
    host,
    port,
    adminApiKey,
    cliProxyApiUrl: cliProxyApiUrl ?? "http://localhost:8317",
    cliProxyApiKey,
    dataDir,
    cliproxyMgmtKey,
    cliproxyAuthDir,
  });

  await completeInit(envPath, dataDir, runtimeDir, env, writeOptions(ctx));
}

function readSecretFromEnvFlag(args: ParsedArgs, flagName: string, envName: string): string | undefined {
  return readNamedEnv(args, flagName) ?? process.env[envName];
}

function readNamedEnv(args: ParsedArgs, flagName: string): string | undefined {
  const name = getFlagValue(args, flagName);
  if (!name) return undefined;
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${flagName} references missing environment variable ${name}`);
  return value;
}

function buildEnv(inputEnv: {
  host: string;
  port: string;
  adminApiKey: string;
  cliProxyApiUrl: string;
  cliProxyApiKey: string;
  dataDir: string;
  cliproxyMgmtKey: string;
  cliproxyAuthDir: string;
}): EnvMap {
  return {
    PROXY_HOST: inputEnv.host,
    PROXY_PORT: inputEnv.port,
    ADMIN_API_KEY: inputEnv.adminApiKey,
    CLI_PROXY_API_URL: inputEnv.cliProxyApiUrl,
    CLI_PROXY_API_KEY: inputEnv.cliProxyApiKey,
    CLAUDE_CODE_VERSION: "2.1.87",
    DB_PATH: join(inputEnv.dataDir, "proxy.db"),
    PRICING_CACHE_PATH: join(inputEnv.dataDir, "pricing-cache.json"),
    PRICING_CACHE_TTL_MS: "3600000",
    CLIENT_NAME_MAPPING: "",
    CLIPROXY_MGMT_KEY: inputEnv.cliproxyMgmtKey,
    CLIPROXY_CORRELATION_INTERVAL_MS: "15000",
    CLIPROXY_CORRELATION_LOOKBACK_MS: "300000",
    CLIPROXY_AUTH_DIR: inputEnv.cliproxyAuthDir,
    QUOTA_REFRESH_TIMEOUT_MS: "15000",
  };
}

async function completeInit(envPath: string, dataDir: string, runtimeDir: string, env: EnvMap, options: EnvWriteOptions): Promise<void> {
  await mkdir(dirname(envPath), { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await mkdir(runtimeDir, { recursive: true });
  await writeEnvAtomic(envPath, env, options);
  const persistedEnv = parseEnvFile(envPath);
  await initDbAt(persistedEnv.DB_PATH ?? env.DB_PATH);

  writeOut("\nCreated:");
  writeOut(`  env: ${envPath}`);
  writeOut(`  db:  ${persistedEnv.DB_PATH ?? env.DB_PATH}`);
  writeOut(`  data: ${dataDir}`);
  writeOut(`  runtime: ${runtimeDir}`);
}

function writeOptions(ctx: CommandContext): EnvWriteOptions {
  return { force: hasFlag(ctx.args, "--force"), merge: hasFlag(ctx.args, "--merge") };
}

async function initDbCommand(ctx: CommandContext): Promise<void> {
  const envPath = getFlagValue(ctx.args, "--env") ?? defaultEnvPath;
  const env = parseEnvFile(envPath);
  await initDbAt(env.DB_PATH ?? defaultDbPath);
  writeOut(`Initialized DB at ${env.DB_PATH ?? defaultDbPath}`);
}

async function backfillCostsCommand(ctx: CommandContext): Promise<void> {
  const envPath = getFlagValue(ctx.args, "--env") ?? defaultEnvPath;
  const env = parseEnvFile(envPath);
  applyEnv(env);
  const { UsageService } = await import("./storage/service");
  Config.validate(process.env);
  const dbPath = env.DB_PATH ?? defaultDbPath;
  const db = Storage.initDb(dbPath);
  const usageService = UsageService.create(db);
  const result = await usageService.backfillCosts({
    all: hasFlag(ctx.args, "--all"),
    limit: parsePositiveLimit(ctx.args),
  });
  writeOut(`[backfill-costs] scanned=${result.scanned} updated=${result.updated} ok=${result.ok} pending=${result.pending} unsupported=${result.unsupported}`);
  db.close();
}

async function doctorCommand(ctx: CommandContext): Promise<number> {
  logger.info("doctor started", { event: "cli.doctor.started" });
  const report = await collectDoctorReport(ctx);
  if (hasFlag(ctx.args, "--json")) writeOut(JSON.stringify(report, null, 2));
  else printDoctorReport(report);
  return report.status === "PASS" ? 0 : 1;
}

async function collectDoctorReport(ctx: CommandContext): Promise<{ status: "PASS" | "FAIL"; checks: Record<string, CheckResult> }> {
  const { envPath, env } = loadConfigEnv(ctx.args);
  applyEnv(env);
  const checks: Record<string, CheckResult> = {};

  let config: ValidatedConfig | null = null;
  try {
    config = Config.validate(env);
    checks.config = { status: "PASS", issues: [], details: { envPath } };
  } catch (err) {
    const issues = err instanceof ConfigError ? err.issues.map(formatConfigIssue) : [errorMessage(err)];
    checks.config = { status: "FAIL", issues, details: { envPath } };
  }

  const dbPath = config?.dbPath ?? env.DB_PATH ?? defaultDbPath;
  checks.database = databaseCheck(dbPath);
  checks.plans = plansCheck();
  checks.providers = await providersCheck(Boolean(config));
  checks.pricingCache = await pricingCacheCheck(config?.pricingCachePath ?? env.PRICING_CACHE_PATH ?? defaultPricingCachePath);
  checks.upstream = config ? await upstreamCheck(config) : { status: "FAIL", issues: ["skipped because config is invalid"] };
  checks.supervisor = await supervisorCheck();

  const status = Object.values(checks).every((check) => check.status === "PASS") ? "PASS" : "FAIL";
  return { status, checks };
}

function loadConfigEnv(args: ParsedArgs): { envPath: string; env: EnvMap } {
  const envPath = getFlagValue(args, "--env") ?? defaultEnvPath;
  return { envPath, env: { ...envFromProcess(), ...parseEnvFile(envPath) } };
}

function envFromProcess(): EnvMap {
  const env: EnvMap = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function databaseCheck(dbPath: string): CheckResult {
  let db: ReturnType<typeof Storage.initDb> | null = null;
  try {
    db = Storage.initDb(dbPath);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>;
    const migrations = db.prepare("SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 10").all() as Array<{ name: string }>;
    return {
      status: "PASS",
      issues: [],
      details: {
        path: dbPath,
        tablesCount: tables.length,
        tables: tables.map((table) => table.name),
        appliedMigrations: migrations.map((migration) => migration.name),
      },
    };
  } catch (err) {
    return { status: "FAIL", issues: [errorMessage(err)], details: { path: dbPath } };
  } finally {
    db?.close();
  }
}

function plansCheck(): CheckResult {
  try {
    Plans.reload();
    const plans = Plans.list();
    const source = resolvePlansSource();
    return {
      status: "PASS",
      issues: [],
      details: {
        count: plans.length,
        source: source.kind,
        path: source.path ?? null,
      },
    };
  } catch (err) {
    return { status: "FAIL", issues: [errorMessage(err)] };
  }
}

async function providersCheck(canLoadRegistry: boolean): Promise<CheckResult> {
  const inspection = inspectProviderConfig(process.env);
  if (!canLoadRegistry) {
    return {
      status: "FAIL",
      issues: ["skipped because config is invalid", ...inspection.invalid.map((entry) => entry.reason)],
      details: { source: inspection.source, invalid: inspection.invalid },
    };
  }
  try {
    const { ProviderRegistry } = await import("./provider/registry");
    const providers = ProviderRegistry.forceReload();
    return {
      status: inspection.invalid.length === 0 ? "PASS" : "FAIL",
      issues: inspection.invalid.map((entry) => entry.reason),
      details: {
        count: providers.length,
        source: inspection.source,
        invalid: inspection.invalid,
      },
    };
  } catch (err) {
    return { status: "FAIL", issues: [errorMessage(err)], details: { invalid: inspection.invalid } };
  }
}

async function pricingCacheCheck(path: string): Promise<CheckResult> {
  try {
    const info = await stat(path);
    return {
      status: "PASS",
      issues: [],
      details: {
        path,
        exists: true,
        size: info.size,
        ageMs: Date.now() - info.mtimeMs,
      },
    };
  } catch (err) {
    return { status: "FAIL", issues: [errorMessage(err)], details: { path, exists: false } };
  }
}

async function upstreamCheck(config: ValidatedConfig): Promise<CheckResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("doctor upstream timeout")), 2_000);
  try {
    const { UpstreamClient } = await import("./upstream/client");
    const response = await UpstreamClient.fetch({
      method: "HEAD",
      url: `${config.cliProxyApiUrl}/health`,
      providerId: "doctor",
      idempotent: true,
      signal: controller.signal,
    });
    if (response.status >= 200 && response.status < 500) {
      return { status: "PASS", issues: [], details: { statusCode: response.status } };
    }
    return { status: "FAIL", issues: [`upstream returned HTTP ${response.status}`], details: { statusCode: response.status } };
  } catch (err) {
    return { status: "FAIL", issues: [errorMessage(err)] };
  } finally {
    clearTimeout(timeout);
  }
}

async function supervisorCheck(): Promise<CheckResult> {
  try {
    const { Supervisor } = await import("./runtime/supervisor");
    return { status: "PASS", issues: [], details: { loops: Supervisor.list() } };
  } catch (err) {
    return { status: "FAIL", issues: [errorMessage(err)] };
  }
}

function printDoctorReport(report: { status: "PASS" | "FAIL"; checks: Record<string, CheckResult> }): void {
  writeOut(`doctor: ${report.status}`);
  for (const [name, check] of Object.entries(report.checks)) {
    writeOut(`${check.status === "PASS" ? "PASS" : "FAIL"} ${name}`);
    if (check.issues.length > 0) {
      for (const issue of check.issues) writeOut(`  - ${issue}`);
    }
    if (check.details !== undefined) writeOut(`  ${JSON.stringify(check.details)}`);
  }
}

async function plansCommand(ctx: CommandContext, subcommand: string): Promise<void> {
  const planArgs = ctx.args.positional.slice(2);
  const [accountArg = "", codeArg = ""] = planArgs;

  switch (subcommand) {
    case "show": {
      Plans.reload();
      const plans = Plans.list();
      if (hasFlag(ctx.args, "--json")) writeOut(JSON.stringify(plans, null, 2));
      else printPlansTable(plans);
      return;
    }
    case "path": {
      const source = resolvePlansSource();
      writeOut(source.path ?? source.label);
      return;
    }
    case "init": {
      await initPlansFile(hasFlag(ctx.args, "--force"));
      return;
    }
    case "edit": {
      const path = await ensureEditablePlansFile(hasFlag(ctx.args, "--force"));
      await openEditor(path);
      return;
    }
    case "bind": {
      const { account, code } = Plans.validateBindingInput(accountArg, codeArg);
      const db = await openConfiguredDb(ctx);
      try {
        AccountSubscriptionRepo.bind(db, account, code);
      } finally {
        db.close();
      }
      writeOut(`Bound ${account} → ${code}`);
      return;
    }
    case "unbind": {
      const account = accountArg.trim();
      if (!account) throw new Error("Account must be a non-empty string");
      const db = await openConfiguredDb(ctx);
      try {
        AccountSubscriptionRepo.unbind(db, account);
      } finally {
        db.close();
      }
      writeOut(`Unbound ${account}`);
      return;
    }
    case "list": {
      const db = await openConfiguredDb(ctx);
      try {
        writeOut("Plans:");
        for (const plan of Plans.list()) {
          writeOut(`  ${plan.code} - ${plan.display_name}`);
        }
        writeOut("Bindings:");
        const bindings = AccountSubscriptionRepo.list(db);
        if (bindings.length === 0) {
          writeOut("  (none)");
        } else {
          for (const binding of bindings) {
            writeOut(`  ${binding.cliproxy_account} → ${binding.subscription_code} (${binding.bound_at})`);
          }
        }
      } finally {
        db.close();
      }
      return;
    }
  }

  writeErr("Usage: agent-cli-proxy plans <show|edit|path|init|bind|unbind|list>");
  throw new Error("invalid plans subcommand");
}

async function providersCommand(ctx: CommandContext, subcommand: string): Promise<void> {
  switch (subcommand) {
    case "show": {
      const { ProviderRegistry } = await import("./provider/registry");
      const providers = ProviderRegistry.all().map(maskProvider);
      if (hasFlag(ctx.args, "--json")) writeOut(JSON.stringify(providers, null, 2));
      else printProvidersTable(providers);
      return;
    }
    case "reload": {
      const { ProviderRegistry } = await import("./provider/registry");
      const providers = ProviderRegistry.forceReload();
      writeOut(`Reloaded providers: ${providers.length}`);
      return;
    }
    case "path": {
      writeOut(providerPathLabel(process.env));
      return;
    }
    case "init": {
      const path = getFlagValue(ctx.args, "--path") ?? process.env.PROVIDERS_CONFIG_PATH ?? defaultProvidersPath;
      await writeJsonAtomic(path, starterProvidersDocument(), { force: hasFlag(ctx.args, "--force") });
      writeOut(`Created providers config: ${path}`);
      return;
    }
  }

  writeErr("Usage: agent-cli-proxy providers <show|reload|path|init>");
  throw new Error("invalid providers subcommand");
}

async function serviceCommand(ctx: CommandContext, subcommand: string): Promise<number> {
  const envPath = getFlagValue(ctx.args, "--env") ?? defaultEnvPath;
  const runtimeDir = getFlagValue(ctx.args, "--runtime-dir") ?? defaultRuntimeDir;

  switch (subcommand) {
    case "install":
      await installRuntime(runtimeDir, envPath);
      await installService(ctx, runtimeDir, envPath);
      return 0;
    case "start":
    case "stop":
    case "restart":
    case "status":
      return await controlService(subcommand);
    case "logs":
      return await serviceLogsCommand(hasFlag(ctx.args, "--follow"));
  }

  writeErr("Usage: agent-cli-proxy service <install|start|stop|restart|status|logs [--follow]>");
  return 1;
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

async function installService(ctx: CommandContext, runtimeDir: string, envPath: string): Promise<void> {
  if (platform() === "linux") {
    const unitDir = join(XDG_CONFIG_HOME, "systemd", "user");
    const unitPath = getFlagValue(ctx.args, "--service-path") ?? join(unitDir, `${APP_NAME}.service`);
    await mkdir(dirname(unitPath), { recursive: true });
    await writeFile(unitPath, renderSystemdUserService(runtimeDir, envPath));
    writeOut(`Installed systemd user service: ${unitPath}`);
    writeOut(`Run: systemctl --user daemon-reload && systemctl --user enable --now ${APP_NAME}`);
    return;
  }

  if (platform() === "darwin") {
    const launchDir = join(HOME, "Library", "LaunchAgents");
    const plistPath = getFlagValue(ctx.args, "--service-path") ?? join(launchDir, `ai.agent-cli-proxy.plist`);
    await mkdir(dirname(plistPath), { recursive: true });
    await writeFile(plistPath, renderLaunchAgent(runtimeDir, envPath));
    writeOut(`Installed launchd agent: ${plistPath}`);
    writeOut(`Run: launchctl load ${plistPath}`);
    return;
  }

  throw new Error(`Unsupported service platform: ${platform()}`);
}

async function controlService(action: string): Promise<number> {
  if (platform() !== "linux") {
    writeOut("Service control is only automated for systemd user services. Use launchctl on macOS.");
    return 0;
  }
  const args = action === "status"
    ? ["--user", "--no-pager", "status", APP_NAME]
    : ["--user", action, APP_NAME];
  const proc = Bun.spawn(["systemctl", ...args], { stdout: "inherit", stderr: "inherit" });
  return await proc.exited;
}

async function serviceLogsCommand(follow: boolean): Promise<number> {
  const os = platform();
  if (os === "linux") {
    const args = ["--user", "-u", `${APP_NAME}.service`];
    if (follow) args.push("-f");
    const proc = Bun.spawn(["journalctl", ...args], { stdout: "inherit", stderr: "inherit" });
    return await proc.exited;
  }
  if (os === "darwin") {
    const command = follow ? "stream" : "show";
    const args = [command, "--predicate", `process == \"${APP_NAME}\"`, "--style", "compact"];
    const proc = Bun.spawn(["log", ...args], { stdout: "inherit", stderr: "inherit" });
    return await proc.exited;
  }
  writeErr("service logs not supported on this platform; check stderr/stdout");
  return 1;
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

async function openConfiguredDb(ctx: CommandContext) {
  const envPath = getFlagValue(ctx.args, "--env") ?? defaultEnvPath;
  const env = parseEnvFile(envPath);
  applyEnv(env);
  Config.validate(process.env);
  return Storage.initDb(env.DB_PATH ?? process.env.DB_PATH ?? defaultDbPath);
}

export async function writeEnvAtomic(path: string, envMap: EnvMap, opts: EnvWriteOptions): Promise<void> {
  if (existsSync(path) && !opts.force && !opts.merge) {
    throw new Error(`${path} already exists; use --force to overwrite, or --merge to preserve existing values`);
  }
  const existing = opts.merge ? parseEnvFile(path) : {};
  const finalEnv = opts.merge ? { ...envMap, ...existing } : envMap;
  await writeTextAtomic(path, renderEnv(finalEnv), 0o600);
}

async function writeJsonAtomic(path: string, value: JsonValue, opts: { force: boolean }): Promise<void> {
  if (existsSync(path) && !opts.force) throw new Error(`${path} already exists; use --force to overwrite`);
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`, 0o600);
}

async function writeTextAtomic(path: string, text: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp.${process.pid}.${crypto.randomUUID()}`;
  const handle = await open(temp, "w", mode);
  try {
    await handle.writeFile(text);
  } finally {
    await handle.close();
  }
  await chmod(temp, mode);
  await rename(temp, path);
  await chmod(path, mode);
}

function renderEnv(env: EnvMap): string {
  const lines = Object.entries(env).map(([key, value]) => `${key}=${quoteEnv(value)}`);
  return `${lines.join("\n")}\n`;
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
    env[trimmed.slice(0, idx)] = parseEnvValue(trimmed.slice(idx + 1));
  }
  return env;
}

function parseEnvValue(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "string" ? parsed : raw.replace(/^"|"$/g, "");
  } catch {
    return raw.replace(/^"|"$/g, "");
  }
}

function parsePositiveLimit(args: ParsedArgs): number | undefined {
  const value = getFlagValue(args, "--limit");
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function ask(rl: ReturnType<typeof createInterface>, question: string, fallback: string): Promise<string> {
  const answer = await rl.question(`${question} (${fallback}): `);
  return answer.trim() || fallback;
}

async function askSecret(rl: ReturnType<typeof createInterface>, question: string, fallback: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(`${question} requires a TTY; use init --non-interactive with environment-backed secret flags`);
  }
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

function printPaths(): void {
  writeOut(JSON.stringify({
    configDir: defaultConfigDir,
    dataDir: defaultDataDir,
    runtimeDir: defaultRuntimeDir,
    envPath: defaultEnvPath,
    dbPath: defaultDbPath,
    pricingCachePath: defaultPricingCachePath,
    plansPath: defaultPlansPath,
    providersPath: defaultProvidersPath,
  }, null, 2));
}

function printHelp(): void {
  writeOut(`agent-cli-proxy

Usage:
  agent-cli-proxy init [--force|--merge]
  agent-cli-proxy init --non-interactive [--env PATH] [--data-dir PATH] [--runtime-dir PATH] [--admin-token VALUE|--admin-token-env NAME] [--cliproxy-mgmt-key-env NAME] [--force|--merge]
  agent-cli-proxy doctor [--env PATH] [--json]
  agent-cli-proxy db init [--env PATH]
  agent-cli-proxy service install [--env PATH] [--runtime-dir PATH] [--service-path PATH]
  agent-cli-proxy service start|stop|restart|status
  agent-cli-proxy service logs [--follow]
  agent-cli-proxy backfill-costs [--all] [--limit N]
  agent-cli-proxy plans show [--json]
  agent-cli-proxy plans edit|path|init [--force]
  agent-cli-proxy plans bind <account> <code> [--env PATH]
  agent-cli-proxy plans unbind <account> [--env PATH]
  agent-cli-proxy plans list [--env PATH]
  agent-cli-proxy providers show [--json]
  agent-cli-proxy providers reload|path|init [--force]
  agent-cli-proxy paths
`);
}

function applyEnv(env: EnvMap): void {
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
}

function formatConfigIssue(issue: ConfigIssue): string {
  return `${issue.path} ${issue.message}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function resolvePlansSource(): { kind: string; path?: string; label: string } {
  if (process.env.PLANS_JSON?.trim()) return { kind: "PLANS_JSON", label: "PLANS_JSON inline" };
  const envPath = process.env.PLANS_PATH?.trim();
  if (envPath) return { kind: "PLANS_PATH", path: envPath, label: envPath };
  if (existsSync(defaultPlansPath)) return { kind: "XDG_CONFIG_HOME", path: defaultPlansPath, label: defaultPlansPath };
  return { kind: "packaged", label: "packaged default" };
}

async function initPlansFile(force: boolean): Promise<void> {
  await writeJsonAtomic(defaultPlansPath, defaultPlansDocument as JsonValue, { force });
  writeOut(`Created plans config: ${defaultPlansPath}`);
}

async function ensureEditablePlansFile(force: boolean): Promise<string> {
  const source = resolvePlansSource();
  if (source.path && source.kind !== "packaged") return source.path;
  if (existsSync(defaultPlansPath) && !force) return defaultPlansPath;
  await writeJsonAtomic(defaultPlansPath, defaultPlansDocument as JsonValue, { force: force || !existsSync(defaultPlansPath) });
  return defaultPlansPath;
}

async function openEditor(path: string): Promise<void> {
  const editor = process.env.EDITOR?.trim() || "vi";
  const proc = Bun.spawn([editor, path], { stdout: "inherit", stderr: "inherit", stdin: "inherit" });
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`${editor} exited with ${exitCode}`);
}

function printPlansTable(plans: Plans.Plan[]): void {
  writeOut("code\tprovider\tprice\tdisplay_name");
  for (const plan of plans) {
    writeOut(`${plan.code}\t${plan.provider}\t${plan.monthly_price_usd} ${plan.currency}/${plan.billing_period_days}d\t${plan.display_name}`);
  }
}

function printProvidersTable(providers: ProviderDefinition[]): void {
  writeOut("id\ttype\tpaths\tmodels\tauth");
  for (const provider of providers) {
    writeOut(`${provider.id}\t${provider.type}\t${provider.paths.join(",")}\t${provider.models?.join(",") ?? ""}\t${formatAuth(provider.auth)}`);
  }
}

function maskProvider(provider: ProviderDefinition): ProviderDefinition {
  if (typeof provider.auth !== "object" || provider.auth === null) return { ...provider };
  const auth = { ...provider.auth };
  if (auth.value !== undefined) auth.value = "[redacted]";
  return { ...provider, auth };
}

function formatAuth(auth: ProviderDefinition["auth"]): string {
  if (auth === undefined) return "";
  if (typeof auth === "string") return auth;
  if (auth.env) return `${auth.type} env:${auth.env}`;
  if (auth.value) return `${auth.type} value:[redacted]`;
  return auth.type;
}

function providerPathLabel(env: NodeJS.ProcessEnv): string {
  if (env.PROVIDERS_JSON?.trim()) return "PROVIDERS_JSON inline";
  if (env.PROVIDERS_CONFIG_PATH?.trim()) return env.PROVIDERS_CONFIG_PATH.trim();
  return "(no custom providers configured)";
}

function starterProvidersDocument(): JsonValue {
  return {
    providers: [
      {
        id: "local",
        type: "openai-compatible",
        paths: ["/v1/chat/completions"],
        upstreamBaseUrl: "http://localhost:11434",
        upstreamPath: "/v1/chat/completions",
        models: ["llama", "qwen"],
        auth: "none",
      },
      {
        id: "glm",
        type: "openai-compatible",
        paths: ["/v1/chat/completions"],
        upstreamBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
        models: ["glm"],
        auth: { type: "bearer", env: "GLM_API_KEY" },
      },
    ],
  };
}

function inspectProviderConfig(env: NodeJS.ProcessEnv): { source: string; invalid: Array<{ path: string; reason: string; issues: ProviderSchemaIssue[] }> } {
  const inline = env.PROVIDERS_JSON;
  if (inline !== undefined && inline.trim() !== "") return inspectProviderRaw("PROVIDERS_JSON", inline);
  const configPath = env.PROVIDERS_CONFIG_PATH?.trim();
  if (!configPath) return { source: "built-in", invalid: [] };
  try {
    return inspectProviderRaw(configPath, readFileSync(configPath, "utf-8"));
  } catch (err) {
    return { source: configPath, invalid: [{ path: "PROVIDERS_CONFIG_PATH", reason: errorMessage(err), issues: [{ path: "PROVIDERS_CONFIG_PATH", message: errorMessage(err) }] }] };
  }
}

function inspectProviderRaw(source: string, raw: string): { source: string; invalid: Array<{ path: string; reason: string; issues: ProviderSchemaIssue[] }> } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const issue = { path: source, message: errorMessage(err) };
    return { source, invalid: [{ path: source, reason: `${source} must be valid JSON: ${issue.message}`, issues: [issue] }] };
  }
  const result = validateProviderDocument(parsed);
  const grouped = new Map<string, ProviderSchemaIssue[]>();
  for (const issue of result.issues) {
    const match = /^providers\[(\d+)]/.exec(issue.path);
    const path = match ? `providers[${match[1]}]` : issue.path;
    const issues = grouped.get(path) ?? [];
    issues.push(issue);
    grouped.set(path, issues);
  }
  return {
    source,
    invalid: Array.from(grouped, ([path, issues]) => ({
      path,
      reason: issues.map((issue) => `${issue.path} ${issue.message}`).join("; "),
      issues,
    })),
  };
}

if (import.meta.main) {
  main().catch((err) => {
    writeErr(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
