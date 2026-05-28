#!/bin/bash
set -e

CONFIG_DIR=/etc/agent-cli-proxy
ENV_FILE="$CONFIG_DIR/agent-cli-proxy.env"
DATA_DIR=/var/lib/agent-cli-proxy
CACHE_DIR=/var/cache/agent-cli-proxy
RUNTIME_DIR=/opt/agent-cli-proxy
LEGACY_ENV_FILE="$RUNTIME_DIR/.env"
LEGACY_DATA_DIR="$RUNTIME_DIR/data"
SERVICE_WAS_ACTIVE=0

copy_if_missing() {
  local source_path="$1"
  local target_path="$2"
  if [ -f "$source_path" ] && [ ! -f "$target_path" ]; then
    cp -a "$source_path" "$target_path"
    return 0
  fi
  return 1
}

legacy_env_value() {
  local key="$1"
  [ -f "$LEGACY_ENV_FILE" ] || return 0
  grep -E "^${key}=" "$LEGACY_ENV_FILE" | tail -n 1 | cut -d= -f2- | sed 's/^"//; s/"$//'
}

resolve_legacy_path() {
  local path="$1"
  [ -n "$path" ] || return 0
  if [ "${path#/}" = "$path" ]; then
    printf '%s\n' "$RUNTIME_DIR/$path"
  else
    printf '%s\n' "$path"
  fi
}

copy_configured_legacy_db() {
  local configured resolved copied=1
  configured=$(legacy_env_value DB_PATH)
  resolved=$(resolve_legacy_path "$configured")
  [ -n "$resolved" ] || return 1
  case "$resolved" in
    "$RUNTIME_DIR"/*) ;;
    *) return 1 ;;
  esac

  if copy_if_missing "$resolved" "$DATA_DIR/proxy.db"; then
    copied=0
  fi
  if copy_if_missing "$resolved-wal" "$DATA_DIR/proxy.db-wal"; then
    copied=0
  fi
  if copy_if_missing "$resolved-shm" "$DATA_DIR/proxy.db-shm"; then
    copied=0
  fi
  chown agent-proxy:agent-proxy "$DATA_DIR"/proxy.db* 2>/dev/null || true
  return "$copied"
}

copy_configured_legacy_pricing_cache() {
  local configured resolved
  configured=$(legacy_env_value PRICING_CACHE_PATH)
  resolved=$(resolve_legacy_path "$configured")
  [ -n "$resolved" ] || return 1
  case "$resolved" in
    "$RUNTIME_DIR"/*) ;;
    *) return 1 ;;
  esac

  if copy_if_missing "$resolved" "$CACHE_DIR/pricing-cache.json"; then
    chown agent-proxy:agent-proxy "$CACHE_DIR/pricing-cache.json"
    return 0
  fi
  return 1
}

copy_legacy_state() {
  local copied=0

  if copy_if_missing "$LEGACY_ENV_FILE" "$ENV_FILE"; then
    chown root:agent-proxy "$ENV_FILE"
    chmod 0640 "$ENV_FILE"
    echo "Copied existing environment to $ENV_FILE"
    copied=1
  fi

  if copy_configured_legacy_db; then
    copied=1
  elif compgen -G "$LEGACY_DATA_DIR/proxy.db*" > /dev/null; then
    for file in "$LEGACY_DATA_DIR"/proxy.db*; do
      [ -f "$file" ] || continue
      if copy_if_missing "$file" "$DATA_DIR/$(basename "$file")"; then
        copied=1
      fi
    done
    chown agent-proxy:agent-proxy "$DATA_DIR"/proxy.db* 2>/dev/null || true
  fi

  if copy_configured_legacy_pricing_cache; then
    copied=1
  elif copy_if_missing "$LEGACY_DATA_DIR/pricing-cache.json" "$CACHE_DIR/pricing-cache.json"; then
    chown agent-proxy:agent-proxy "$CACHE_DIR/pricing-cache.json"
    copied=1
  fi

  if [ "$copied" -eq 1 ]; then
    echo "Copied legacy state from $RUNTIME_DIR into external config/data paths."
  fi
}

set_env_value() {
  local key="$1"
  local value="$2"
  local tmp
  tmp=$(mktemp)
  awk -v key="$key" -v value="$value" '
    BEGIN { written = 0 }
    $0 ~ "^" key "=" {
      if (written == 0) {
        print key "=" value
        written = 1
      }
      next
    }
    { print }
    END {
      if (written == 0) print key "=" value
    }
  ' "$ENV_FILE" > "$tmp"
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
}

current_env_value() {
  local key="$1"
  grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- | sed 's/^"//; s/"$//'
}

needs_external_state_path() {
  local current="$1"
  [ -z "$current" ] && return 0
  [ "${current#/}" = "$current" ] && return 0
  case "$current" in
    "$RUNTIME_DIR"/*|"$LEGACY_DATA_DIR"/*) return 0 ;;
  esac
  return 1
}

ensure_external_state_paths() {
  local current_db current_pricing
  current_db=$(current_env_value DB_PATH)
  current_pricing=$(current_env_value PRICING_CACHE_PATH)

  if needs_external_state_path "$current_db"; then
    set_env_value DB_PATH "$DATA_DIR/proxy.db"
  fi
  if needs_external_state_path "$current_pricing"; then
    set_env_value PRICING_CACHE_PATH "$CACHE_DIR/pricing-cache.json"
  fi
}

pause_active_service_for_migration() {
  SERVICE_WAS_ACTIVE=0
  if systemctl is-active --quiet agent-cli-proxy; then
    SERVICE_WAS_ACTIVE=1
    echo "Stopping active agent-cli-proxy service before copying SQLite state..."
    systemctl stop agent-cli-proxy
  fi
}

restart_service_if_previously_active() {
  if [ "$SERVICE_WAS_ACTIVE" -eq 1 ]; then
    echo "Restarting agent-cli-proxy service after migration..."
    systemctl restart agent-cli-proxy
  fi
}

main() {
  printf '%s\n' "Agent CLI Proxy Server Setup" "============================"

  if [ "${AGENT_CLI_PROXY_SETUP_SKIP_ROOT_CHECK:-0}" != "1" ] && [ "$EUID" -ne 0 ]; then
    echo "Please run as root (use sudo)"
    exit 1
  fi

  if ! command -v bun &> /dev/null; then
    echo "Installing Bun..."
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
  fi

  if ! id -u agent-proxy &> /dev/null; then
    echo "Creating agent-proxy user..."
    useradd -r -s /bin/false -m -d /opt/agent-cli-proxy agent-proxy
  fi

  mkdir -p "$CONFIG_DIR" "$DATA_DIR" "$CACHE_DIR"
  chown -R agent-proxy:agent-proxy "$DATA_DIR" "$CACHE_DIR"
  chown root:agent-proxy "$CONFIG_DIR"
  chmod 0750 "$CONFIG_DIR" "$DATA_DIR" "$CACHE_DIR"

  pause_active_service_for_migration

  echo "Snapshotting legacy environment and state..."
  copy_legacy_state

  echo "Copying files..."
  rsync -av --include='.env.example' --exclude='.env*' --exclude='node_modules' --exclude='data' --exclude='.git' \
    "$(dirname "$0")/" "$RUNTIME_DIR/"

  echo "Installing dependencies..."
  cd "$RUNTIME_DIR"
  bun install

  chown -R agent-proxy:agent-proxy "$RUNTIME_DIR" "$DATA_DIR" "$CACHE_DIR"
  chown root:agent-proxy "$CONFIG_DIR"
  chmod 0750 "$CONFIG_DIR" "$DATA_DIR" "$CACHE_DIR"

  echo "Setting up environment and external state..."
  if [ ! -f "$ENV_FILE" ]; then
    install -m 0640 -o root -g agent-proxy "$RUNTIME_DIR/.env.example" "$ENV_FILE"
    {
      echo ""
      echo "# System install state paths. Keep these outside $RUNTIME_DIR so deploys do not wipe them."
      echo "DB_PATH=$DATA_DIR/proxy.db"
      echo "PRICING_CACHE_PATH=$CACHE_DIR/pricing-cache.json"
    } >> "$ENV_FILE"
    echo "Created $ENV_FILE. Please edit it with your configuration."
  else
    ensure_external_state_paths
  fi

  chown root:agent-proxy "$ENV_FILE"
  chmod 0640 "$ENV_FILE"

  echo "Installing systemd service..."
  cp "$RUNTIME_DIR/agent-cli-proxy.service" /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable agent-cli-proxy
  restart_service_if_previously_active

  echo ""
  echo "Setup complete!"
  echo ""
  echo "Next steps:"
  echo "1. Edit $ENV_FILE with your configuration"
  echo "2. Start the service: sudo systemctl start agent-cli-proxy"
  echo "3. Check status: sudo systemctl status agent-cli-proxy"
  echo "4. View logs: sudo journalctl -u agent-cli-proxy -f"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
