#!/usr/bin/env bash
set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-inonono}"
SOURCE_DIR="${SOURCE_DIR:-/home/inonono/agent-cli-proxy}"
RUNTIME_DIR="${RUNTIME_DIR:-/home/inonono/.local/share/agent-cli-proxy}"
PACKAGE_DIR="${PACKAGE_DIR:-.runtime-package}"

bun run build

rm -rf "${PACKAGE_DIR}"
mkdir -p "${PACKAGE_DIR}"

cp dist/index.js "${PACKAGE_DIR}/index.js"
cp dist/index-* "${PACKAGE_DIR}/"
cp -R dist/dashboard "${PACKAGE_DIR}/dashboard"
cp -R dist/migrations "${PACKAGE_DIR}/migrations"
cp agent-cli-proxy.runtime.user.service "${PACKAGE_DIR}/agent-cli-proxy.service"

rsync -az --delete \
  --exclude='.env' \
  --exclude='data' \
  "${PACKAGE_DIR}/" "${REMOTE_HOST}:${RUNTIME_DIR}/"

ssh "${REMOTE_HOST}" "set -euo pipefail; \
  mkdir -p ~/.config/systemd/user '${RUNTIME_DIR}/data'; \
  if [ ! -f '${RUNTIME_DIR}/.env' ] && [ -f '${SOURCE_DIR}/.env' ]; then cp '${SOURCE_DIR}/.env' '${RUNTIME_DIR}/.env'; fi; \
  if [ ! -f '${RUNTIME_DIR}/data/proxy.db' ] && [ -f '${SOURCE_DIR}/data/proxy.db' ]; then cp -a '${SOURCE_DIR}/data/.' '${RUNTIME_DIR}/data/'; fi; \
  chmod 600 '${RUNTIME_DIR}/.env'; \
  cp '${RUNTIME_DIR}/agent-cli-proxy.service' ~/.config/systemd/user/agent-cli-proxy.service; \
  systemctl --user daemon-reload; \
  systemctl --user enable agent-cli-proxy; \
  systemctl --user restart agent-cli-proxy; \
  sleep 2; \
  systemctl --user --no-pager status agent-cli-proxy; \
  curl -fsS http://127.0.0.1:3100/health"
