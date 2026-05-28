# Persistent config and data outside deploy artifacts

Deployments must not store mutable state in the directory that is replaced by a release. Keep the environment file, SQLite database, SQLite WAL/SHM sidecars, and pricing cache in stable host-owned paths.

## Recommended paths

| Install type | Config/env | Database and WAL/SHM | Pricing cache | Runtime/release files |
| --- | --- | --- | --- | --- |
| User service | `~/.config/agent-cli-proxy/.env` | `~/.local/share/agent-cli-proxy/proxy.db` plus `proxy.db-wal` and `proxy.db-shm` | `~/.local/share/agent-cli-proxy/pricing-cache.json` | `~/.local/share/agent-cli-proxy/runtime` |
| System service | `/etc/agent-cli-proxy/agent-cli-proxy.env` | `/var/lib/agent-cli-proxy/proxy.db` plus `proxy.db-wal` and `proxy.db-shm` | `/var/cache/agent-cli-proxy/pricing-cache.json` | `/opt/agent-cli-proxy` |

The runtime defaults now use `AGENT_CLI_PROXY_DATA_DIR`, `XDG_DATA_HOME`, or `~/.local/share/agent-cli-proxy` for mutable state when `DB_PATH` and `PRICING_CACHE_PATH` are not set. Relative paths still work for local development, but startup validation warns because relative paths can be under a deploy directory.

## Configure a user install

Use `init` with explicit external paths:

```bash
agent-cli-proxy init --non-interactive \
  --env ~/.config/agent-cli-proxy/.env \
  --data-dir ~/.local/share/agent-cli-proxy \
  --runtime-dir ~/.local/share/agent-cli-proxy/runtime \
  --cliproxy-api-url http://localhost:8317
```

The generated `.env` contains absolute `DB_PATH` and `PRICING_CACHE_PATH` values under the data directory. The generated user service points at the runtime directory and reads the env file from `~/.config/agent-cli-proxy/.env`.

## Configure a system install

System installs should keep secrets in `/etc`, durable SQLite state in `/var/lib`, and caches in `/var/cache`:

```dotenv
# /etc/agent-cli-proxy/agent-cli-proxy.env
DB_PATH=/var/lib/agent-cli-proxy/proxy.db
PRICING_CACHE_PATH=/var/cache/agent-cli-proxy/pricing-cache.json
```

The packaged systemd service also sets:

```ini
Environment="AGENT_CLI_PROXY_DATA_DIR=/var/lib/agent-cli-proxy"
EnvironmentFile=/etc/agent-cli-proxy/agent-cli-proxy.env
```

`setup.sh` creates these directories and installs the env file as `root:agent-proxy` with group-read access so the service user can read it while ordinary users cannot. On existing `/opt/agent-cli-proxy` installs, it stops an active `agent-cli-proxy` service before copying SQLite state, uses copy-first migration for legacy `.env`, `data/proxy.db*`, and `data/pricing-cache.json`, then restarts the service if it was active before setup.

## Safe migration from repo-local state

Do not destructively move files during a release. Copy first, validate, and only then remove old copies.

1. Stop the service:
   ```bash
   sudo systemctl stop agent-cli-proxy
   ```
2. Back up the current env, database, SQLite sidecars, and pricing cache:
   ```bash
   sudo mkdir -p /var/backups/agent-cli-proxy
   sudo cp -a /opt/agent-cli-proxy/.env /var/backups/agent-cli-proxy/env.$(date +%Y%m%d%H%M%S) 2>/dev/null || true
   sudo cp -a /opt/agent-cli-proxy/data/proxy.db* /var/backups/agent-cli-proxy/ 2>/dev/null || true
   sudo cp -a /opt/agent-cli-proxy/data/pricing-cache.json /var/backups/agent-cli-proxy/ 2>/dev/null || true
   ```
3. Create external state directories:
   ```bash
   sudo install -d -m 0750 -o agent-proxy -g agent-proxy /var/lib/agent-cli-proxy
   sudo install -d -m 0750 -o agent-proxy -g agent-proxy /var/cache/agent-cli-proxy
   sudo install -d -m 0750 -o root -g agent-proxy /etc/agent-cli-proxy
   ```
4. Copy, rather than move, the database and its sidecars. If the old env file used custom `DB_PATH` or `PRICING_CACHE_PATH`, resolve relative paths from `/opt/agent-cli-proxy` and copy those files instead of only the default names:
   ```bash
   # Default legacy locations:
   sudo cp -a /opt/agent-cli-proxy/data/proxy.db* /var/lib/agent-cli-proxy/ 2>/dev/null || true
   sudo cp -a /opt/agent-cli-proxy/data/pricing-cache.json /var/cache/agent-cli-proxy/pricing-cache.json 2>/dev/null || true

   # Custom legacy DB example: DB_PATH=data/custom.db
   sudo cp -a /opt/agent-cli-proxy/data/custom.db /var/lib/agent-cli-proxy/proxy.db 2>/dev/null || true
   sudo cp -a /opt/agent-cli-proxy/data/custom.db-wal /var/lib/agent-cli-proxy/proxy.db-wal 2>/dev/null || true
   sudo cp -a /opt/agent-cli-proxy/data/custom.db-shm /var/lib/agent-cli-proxy/proxy.db-shm 2>/dev/null || true

   # Custom legacy pricing cache example: PRICING_CACHE_PATH=data/custom-pricing.json
   sudo cp -a /opt/agent-cli-proxy/data/custom-pricing.json /var/cache/agent-cli-proxy/pricing-cache.json 2>/dev/null || true

   sudo chown agent-proxy:agent-proxy /var/lib/agent-cli-proxy/proxy.db* /var/cache/agent-cli-proxy/pricing-cache.json 2>/dev/null || true
   ```
5. Copy the env file to `/etc/agent-cli-proxy/agent-cli-proxy.env`, then set durable paths:
   ```bash
   sudo cp -a /opt/agent-cli-proxy/.env /etc/agent-cli-proxy/agent-cli-proxy.env
   sudo chown root:agent-proxy /etc/agent-cli-proxy/agent-cli-proxy.env
   sudo chmod 0640 /etc/agent-cli-proxy/agent-cli-proxy.env
   sudo editor /etc/agent-cli-proxy/agent-cli-proxy.env
   ```
   Ensure it contains:
   ```dotenv
   DB_PATH=/var/lib/agent-cli-proxy/proxy.db
   PRICING_CACHE_PATH=/var/cache/agent-cli-proxy/pricing-cache.json
   ```
6. Reload and start the service:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl start agent-cli-proxy
   ```
7. Validate the new paths:
   ```bash
   sudo -u agent-proxy agent-cli-proxy doctor --env /etc/agent-cli-proxy/agent-cli-proxy.env
   ```
8. After a successful doctor check and a functional dashboard/API smoke test, delete old repo-local copies in a separate cleanup window.

## Rollback

If the migrated service fails, stop it, restore the previous service unit or env file from backup, start the service, and inspect logs. Because the migration used copy-first semantics, the old repo-local files remain available until the final cleanup step.
