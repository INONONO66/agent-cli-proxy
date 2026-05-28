import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function readRepoFile(path: string): Promise<string> {
  return await Bun.file(new URL(`../../${path}`, import.meta.url)).text();
}

function activeEnvLineRegex(key: string, value: string): RegExp {
  return new RegExp(`^${key}=${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m");
}

describe("deployment state persistence docs and templates", () => {
  test("document copy-first external state migration", async () => {
    const text = await readRepoFile("docs/deployment-state.md");

    for (const required of [
      "/etc/agent-cli-proxy/agent-cli-proxy.env",
      "/var/lib/agent-cli-proxy/proxy.db",
      "/var/cache/agent-cli-proxy/pricing-cache.json",
      "proxy.db-wal",
      "proxy.db-shm",
      "Copy, rather than move",
      "doctor --env /etc/agent-cli-proxy/agent-cli-proxy.env",
      "Rollback",
    ]) {
      expect(text).toContain(required);
    }
  });

  test("example env avoids repo-local active state paths", async () => {
    const text = await readRepoFile(".env.example");

    expect(text).not.toMatch(activeEnvLineRegex("DB_PATH", "data/proxy.db"));
    expect(text).not.toMatch(activeEnvLineRegex("PRICING_CACHE_PATH", "data/pricing-cache.json"));
    expect(text).toContain("Defaults use $XDG_DATA_HOME/agent-cli-proxy");
  });

  test("system service keeps env and mutable state outside runtime", async () => {
    const text = await readRepoFile("agent-cli-proxy.service");

    expect(text).toContain("EnvironmentFile=/etc/agent-cli-proxy/agent-cli-proxy.env");
    expect(text).toContain("AGENT_CLI_PROXY_DATA_DIR=/var/lib/agent-cli-proxy");
    expect(text).toContain("PRICING_CACHE_PATH=/var/cache/agent-cli-proxy/pricing-cache.json");
    expect(text).not.toContain("EnvironmentFile=/opt/agent-cli-proxy/.env");
  });

  test("user services point to XDG config and separate runtime/data paths", async () => {
    const userService = await readRepoFile("agent-cli-proxy.user.service");
    const runtimeService = await readRepoFile("agent-cli-proxy.runtime.user.service");

    for (const text of [userService, runtimeService]) {
      expect(text).toContain("EnvironmentFile=%h/.config/agent-cli-proxy/.env");
      expect(text).toContain("AGENT_CLI_PROXY_DATA_DIR=%h/.local/share/agent-cli-proxy");
      expect(text).not.toContain("EnvironmentFile=%h/agent-cli-proxy/.env");
    }
    expect(runtimeService).toContain("WorkingDirectory=%h/.local/share/agent-cli-proxy/runtime");
  });

  test("setup script installs config and state outside /opt runtime", async () => {
    const text = await readRepoFile("setup.sh");

    expect(text).toContain("CONFIG_DIR=/etc/agent-cli-proxy");
    expect(text).toContain('ENV_FILE="$CONFIG_DIR/agent-cli-proxy.env"');
    expect(text).toContain("DATA_DIR=/var/lib/agent-cli-proxy");
    expect(text).toContain("CACHE_DIR=/var/cache/agent-cli-proxy");
    expect(text).toContain('chown root:agent-proxy "$CONFIG_DIR"');
    expect(text).toContain("copy_legacy_state");
    expect(text).toContain("copy_configured_legacy_db");
    expect(text).toContain("copy_configured_legacy_pricing_cache");
    expect(text).toContain("resolve_legacy_path");
    expect(text).toContain("LEGACY_ENV_FILE");
    expect(text).toContain("LEGACY_DATA_DIR");
    expect(text).toContain("proxy.db*");
    expect(text).toContain("ensure_external_state_paths");
    expect(text).toContain("pause_active_service_for_migration");
    expect(text).toContain("systemctl is-active --quiet agent-cli-proxy");
    expect(text).toContain("systemctl stop agent-cli-proxy");
    expect(text).toContain("restart_service_if_previously_active");
    expect(text).toContain("systemctl restart agent-cli-proxy");
    expect(text).toContain("Snapshotting legacy environment and state");
    expect(text).toContain("--include='.env.example'");
    expect(text).toContain("--exclude='.env*'");
    expect(text).toContain("install -m 0640 -o root -g agent-proxy");
  });

  test("setup helpers copy custom legacy state before rewriting external paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-cli-proxy-setup-migration-"));
    const setupPath = new URL("../../setup.sh", import.meta.url).pathname;
    const script = String.raw`
set -euo pipefail
source "$SETUP_PATH"
chown() { :; }
CONFIG_DIR="$ROOT/etc"
ENV_FILE="$CONFIG_DIR/agent-cli-proxy.env"
DATA_DIR="$ROOT/var-lib"
CACHE_DIR="$ROOT/var-cache"
RUNTIME_DIR="$ROOT/opt-runtime"
LEGACY_ENV_FILE="$RUNTIME_DIR/.env"
LEGACY_DATA_DIR="$RUNTIME_DIR/data"
mkdir -p "$CONFIG_DIR" "$DATA_DIR" "$CACHE_DIR" "$LEGACY_DATA_DIR"
cat > "$LEGACY_ENV_FILE" <<'ENV'
ADMIN_API_KEY=keep-secret
DB_PATH=data/custom.db
PRICING_CACHE_PATH=data/custom-pricing.json
ENV
printf 'db' > "$LEGACY_DATA_DIR/custom.db"
printf 'wal' > "$LEGACY_DATA_DIR/custom.db-wal"
printf 'shm' > "$LEGACY_DATA_DIR/custom.db-shm"
printf 'pricing' > "$LEGACY_DATA_DIR/custom-pricing.json"
copy_legacy_state
ensure_external_state_paths
test -f "$DATA_DIR/proxy.db"
test -f "$DATA_DIR/proxy.db-wal"
test -f "$DATA_DIR/proxy.db-shm"
test -f "$CACHE_DIR/pricing-cache.json"
grep -q "ADMIN_API_KEY=keep-secret" "$ENV_FILE"
grep -q "DB_PATH=$DATA_DIR/proxy.db" "$ENV_FILE"
grep -q "PRICING_CACHE_PATH=$CACHE_DIR/pricing-cache.json" "$ENV_FILE"
`;

    const proc = Bun.spawn(["bash", "-c", script], {
      env: { ...process.env, ROOT: root, SETUP_PATH: setupPath },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    expect(await proc.exited).toBe(0);
    expect(`${stdout}${stderr}`).toContain("Copied legacy state");
    expect(readFileSync(join(root, "var-lib", "proxy.db"), "utf-8")).toBe("db");
    expect(readFileSync(join(root, "var-cache", "pricing-cache.json"), "utf-8")).toBe("pricing");
    expect(existsSync(join(root, "opt-runtime", "data", "custom.db"))).toBe(true);
  });


  test("setup snapshots legacy state before rsync and excludes source env files", async () => {
    const text = await readRepoFile("setup.sh");
    const snapshotIndex = text.indexOf("Snapshotting legacy environment and state");
    const copyIndex = text.indexOf("copy_legacy_state", snapshotIndex);
    const rsyncIndex = text.indexOf("rsync -av", copyIndex);

    expect(snapshotIndex).toBeGreaterThan(0);
    expect(copyIndex).toBeGreaterThan(snapshotIndex);
    expect(rsyncIndex).toBeGreaterThan(copyIndex);
    expect(text).toContain("--include='.env.example'");
    expect(text).toContain("--exclude='.env*'");
  });



  test("setup main fresh install keeps .env.example available while excluding local env files", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-cli-proxy-setup-fresh-"));
    const source = join(root, "source");
    const setupPath = new URL("../../setup.sh", import.meta.url).pathname;
    const script = String.raw`
set -euo pipefail
source "$SETUP_PATH"
chown() { :; }
chmod() { :; }
bun() { :; }
systemctl() { :; }
id() { return 0; }
install() {
  command cp "$RUNTIME_DIR/.env.example" "$ENV_FILE"
}
cp() {
  local target
  for target in "$@"; do :; done
  case "$target" in
    /etc/systemd/system/) return 0 ;;
  esac
  command cp "$@"
}
rsync() {
  mkdir -p "$RUNTIME_DIR"
  command cp -a ./. "$RUNTIME_DIR"/
  find "$RUNTIME_DIR" -maxdepth 1 -name ".env*" ! -name ".env.example" -delete
}
CONFIG_DIR="$ROOT/etc"
ENV_FILE="$CONFIG_DIR/agent-cli-proxy.env"
DATA_DIR="$ROOT/var-lib"
CACHE_DIR="$ROOT/var-cache"
RUNTIME_DIR="$ROOT/runtime"
LEGACY_ENV_FILE="$RUNTIME_DIR/.env"
LEGACY_DATA_DIR="$RUNTIME_DIR/data"
mkdir -p "$SOURCE"
printf 'ADMIN_API_KEY=from-source\n' > "$SOURCE/.env"
printf 'ADMIN_API_KEY=prod-local\n' > "$SOURCE/.env.production.local"
printf 'ADMIN_API_KEY=template\n' > "$SOURCE/.env.example"
printf '[Service]\nExecStart=/bin/true\n' > "$SOURCE/agent-cli-proxy.service"
cd "$SOURCE"
main
`;

    const proc = Bun.spawn(["bash", "-c", script], {
      env: { ...process.env, ROOT: root, SOURCE: source, SETUP_PATH: setupPath, AGENT_CLI_PROXY_SETUP_SKIP_ROOT_CHECK: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    expect(await proc.exited).toBe(0);
    expect(`${stdout}${stderr}`).toContain("Created");
    const envText = readFileSync(join(root, "etc", "agent-cli-proxy.env"), "utf-8");
    expect(envText).toContain("ADMIN_API_KEY=template");
    expect(envText).not.toContain("ADMIN_API_KEY=from-source");
    expect(envText).toContain(`DB_PATH=${join(root, "var-lib", "proxy.db")}`);
    expect(existsSync(join(root, "runtime", ".env"))).toBe(false);
    expect(existsSync(join(root, "runtime", ".env.production.local"))).toBe(false);
    expect(existsSync(join(root, "runtime", ".env.example"))).toBe(true);
  });


  test("setup pauses active service before copying state and restarts after install", async () => {
    const text = await readRepoFile("setup.sh");
    const pauseIndex = text.indexOf("pause_active_service_for_migration");
    const snapshotIndex = text.indexOf("Snapshotting legacy environment and state");
    const copyIndex = text.indexOf("copy_legacy_state", snapshotIndex);
    const enableIndex = text.indexOf("systemctl enable agent-cli-proxy");
    const restartIndex = text.indexOf("restart_service_if_previously_active", enableIndex);

    expect(pauseIndex).toBeGreaterThan(0);
    expect(snapshotIndex).toBeGreaterThan(pauseIndex);
    expect(copyIndex).toBeGreaterThan(snapshotIndex);
    expect(restartIndex).toBeGreaterThan(enableIndex);
  });

});
