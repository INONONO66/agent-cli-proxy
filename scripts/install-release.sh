#!/usr/bin/env bash
set -euo pipefail

REPO="${AGENT_CLI_PROXY_REPO:-INONONO66/agent-cli-proxy}"
VERSION="${AGENT_CLI_PROXY_VERSION:-latest}"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
BIN_HOME="${AGENT_CLI_PROXY_BIN_DIR:-$HOME/.local/bin}"
INSTALL_DIR="${AGENT_CLI_PROXY_INSTALL_DIR:-$DATA_HOME/agent-cli-proxy/runtime}"
CONFIG_PATH="${AGENT_CLI_PROXY_ENV:-$HOME/.config/agent-cli-proxy/.env}"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

require_cmd curl
require_cmd tar
require_cmd bun

if [ -n "${AGENT_CLI_PROXY_TARBALL_URL:-}" ]; then
  URL="$AGENT_CLI_PROXY_TARBALL_URL"
elif [ "$VERSION" = "latest" ]; then
  URL="https://github.com/$REPO/releases/latest/download/agent-cli-proxy.tar.gz"
else
  URL="https://github.com/$REPO/releases/download/$VERSION/agent-cli-proxy.tar.gz"
fi

mkdir -p "$INSTALL_DIR" "$BIN_HOME" "$(dirname "$CONFIG_PATH")"

printf 'Downloading %s\n' "$URL"
curl -fsSL "$URL" -o "$TMP_DIR/agent-cli-proxy.tar.gz"
tar -xzf "$TMP_DIR/agent-cli-proxy.tar.gz" -C "$TMP_DIR"

rm -rf "$INSTALL_DIR.new"
mkdir -p "$INSTALL_DIR.new"
cp -R "$TMP_DIR/agent-cli-proxy/." "$INSTALL_DIR.new/"
if [ -d "$INSTALL_DIR" ]; then
  rm -rf "$INSTALL_DIR.previous"
  mv "$INSTALL_DIR" "$INSTALL_DIR.previous"
fi
mv "$INSTALL_DIR.new" "$INSTALL_DIR"

cat > "$BIN_HOME/agent-cli-proxy" <<EOF_WRAPPER
#!/usr/bin/env bash
exec bun "$INSTALL_DIR/cli.js" "\$@"
EOF_WRAPPER
chmod 0755 "$BIN_HOME/agent-cli-proxy"

printf 'Installed agent-cli-proxy to %s\n' "$INSTALL_DIR"
printf 'CLI wrapper: %s/agent-cli-proxy\n' "$BIN_HOME"

if [ ! -f "$CONFIG_PATH" ] && { [ "${AGENT_CLI_PROXY_INIT:-0}" = "1" ] || [ "${AGENT_CLI_PROXY_SERVICE:-0}" = "1" ]; }; then
  "$BIN_HOME/agent-cli-proxy" init --non-interactive --env "$CONFIG_PATH" --runtime-dir "$INSTALL_DIR" --merge
fi

if [ "${AGENT_CLI_PROXY_SERVICE:-0}" = "1" ]; then
  "$BIN_HOME/agent-cli-proxy" service install --env "$CONFIG_PATH" --runtime-dir "$INSTALL_DIR" --skip-runtime
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user daemon-reload
    systemctl --user enable agent-cli-proxy.service
    systemctl --user restart agent-cli-proxy.service
  fi
fi

printf '\nNext steps:\n'
printf '  export PATH="%s:$PATH"\n' "$BIN_HOME"
printf '  agent-cli-proxy init --non-interactive --env %s --runtime-dir %s --merge\n' "$CONFIG_PATH" "$INSTALL_DIR"
printf '  agent-cli-proxy service install --env %s --runtime-dir %s\n' "$CONFIG_PATH" "$INSTALL_DIR"
