#!/usr/bin/env bash
set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-inonono}"
REMOTE_DIR="${REMOTE_DIR:-/home/inonono/agent-cli-proxy}"

bun run build

rsync -az --delete \
  --exclude='.git' \
  --exclude='data' \
  --exclude='node_modules' \
  --exclude='.env*' \
  --exclude='dashboard' \
  ./ "${REMOTE_HOST}:${REMOTE_DIR}/"

ssh "${REMOTE_HOST}" "
  set -e
  mkdir -p ~/.config/systemd/user '${REMOTE_DIR}/data'
  [ ! -f '${REMOTE_DIR}/.env' ] || chmod 600 '${REMOTE_DIR}/.env'
  rm -rf '${REMOTE_DIR}/dashboard'
  cp '${REMOTE_DIR}/agent-cli-proxy.user.service' ~/.config/systemd/user/agent-cli-proxy.service 2>/dev/null || cp '${REMOTE_DIR}/agent-cli-proxy.service' ~/.config/systemd/user/agent-cli-proxy.service
  systemctl --user daemon-reload
  systemctl --user enable agent-cli-proxy
  systemctl --user restart agent-cli-proxy
  systemctl --user --no-pager status agent-cli-proxy | head -10
"
