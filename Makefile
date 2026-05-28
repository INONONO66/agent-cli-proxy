# agent-cli-proxy Makefile
#
# Usage:
#   make deploy          — build + install runtime + restart service
#   make build           — build dist/ only
#   make install-runtime — copy dist/ to runtime dir
#   make install-service — install systemd user service
#   make restart         — restart the service
#   make status          — show service status
#   make logs            — tail service logs
#
# Config (override via env or make args):
#   RUNTIME_DIR   — where the runtime bundle lives (default: ~/.local/share/agent-cli-proxy)
#   ENV_FILE      — path to .env (default: ~/.config/agent-cli-proxy/.env)
#   SERVICE_NAME  — systemd unit name (default: agent-cli-proxy)

SHELL := /bin/bash

BUN := $(shell command -v bun 2>/dev/null)
RUNTIME_DIR ?= $(HOME)/.local/share/agent-cli-proxy
ENV_FILE ?= $(HOME)/.config/agent-cli-proxy/.env
SERVICE_NAME ?= agent-cli-proxy
SERVICE_DIR := $(HOME)/.config/systemd/user
SERVICE_FILE := $(SERVICE_DIR)/$(SERVICE_NAME).service
DIST_DIR := dist

.PHONY: deploy build install-runtime install-service restart stop start status logs doctor clean help

help: ## show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

deploy: build install-runtime restart ## build + deploy + restart (main command)
	@echo "✓ deployed to $(RUNTIME_DIR)"

build: ## build dist/
	@test -n "$(BUN)" || { echo "error: bun not found in PATH"; exit 1; }
	$(BUN) install --frozen-lockfile
	$(BUN) run build

install-runtime: ## copy dist/ to runtime dir
	@test -d "$(DIST_DIR)" || { echo "error: dist/ not found — run 'make build' first"; exit 1; }
	@mkdir -p "$(RUNTIME_DIR)"
	@# preserve: .env (symlink or file), proxy.db, pricing-cache.json, .dashboard-session-secret, backups
	cp "$(DIST_DIR)/index.js" "$(RUNTIME_DIR)/"
	cp "$(DIST_DIR)/cli.js" "$(RUNTIME_DIR)/"
	rm -rf "$(RUNTIME_DIR)/migrations"
	cp -r "$(DIST_DIR)/migrations" "$(RUNTIME_DIR)/"
	@# ensure .env symlink exists if not already present
	@test -e "$(RUNTIME_DIR)/.env" || { \
		if test -f "$(ENV_FILE)"; then \
			ln -s "$(ENV_FILE)" "$(RUNTIME_DIR)/.env"; \
			echo "linked $(RUNTIME_DIR)/.env → $(ENV_FILE)"; \
		else \
			echo "warning: no .env found at $(ENV_FILE) — create one with 'make init'"; \
		fi; \
	}

install-service: ## install systemd user service
	@mkdir -p "$(SERVICE_DIR)"
	@printf '%s\n' \
		'[Unit]' \
		'Description=agent-cli-proxy - AI API Proxy with Usage Monitoring' \
		'After=network-online.target' \
		'' \
		'[Service]' \
		'Type=simple' \
		'WorkingDirectory=$(RUNTIME_DIR)' \
		'Environment=NODE_ENV=production' \
		'Environment=PATH=$(HOME)/.bun/bin:/usr/local/bin:/usr/bin:/bin' \
		'EnvironmentFile=$(RUNTIME_DIR)/.env' \
		'ExecStart=$(HOME)/.bun/bin/bun run index.js' \
		'Restart=always' \
		'RestartSec=5' \
		'' \
		'[Install]' \
		'WantedBy=default.target' \
		> "$(SERVICE_FILE)"
	systemctl --user daemon-reload
	systemctl --user enable $(SERVICE_NAME)
	@echo "✓ installed $(SERVICE_FILE)"

init: build install-runtime install-service ## first-time setup: build + deploy + install service
	@test -f "$(ENV_FILE)" || { \
		mkdir -p "$$(dirname "$(ENV_FILE)")"; \
		echo "# agent-cli-proxy config" > "$(ENV_FILE)"; \
		chmod 600 "$(ENV_FILE)"; \
		echo "created $(ENV_FILE) — edit it before starting"; \
	}
	@echo "✓ init complete — run 'make start' after configuring $(ENV_FILE)"

start: ## start the service
	systemctl --user start $(SERVICE_NAME)
	@echo "✓ started"

stop: ## stop the service
	systemctl --user stop $(SERVICE_NAME)
	@echo "✓ stopped"

restart: ## restart the service
	@systemctl --user is-active $(SERVICE_NAME) >/dev/null 2>&1 && \
		systemctl --user restart $(SERVICE_NAME) || \
		systemctl --user start $(SERVICE_NAME)
	@sleep 2
	@systemctl --user is-active $(SERVICE_NAME) >/dev/null 2>&1 && echo "✓ running" || { echo "✗ failed to start — check 'make logs'"; exit 1; }

status: ## show service status
	systemctl --user status $(SERVICE_NAME) --no-pager

logs: ## tail service logs
	journalctl --user -u $(SERVICE_NAME).service -f

doctor: ## run health checks
	@curl -sf http://127.0.0.1:$${PROXY_PORT:-3100}/health && echo " health ok" || echo "✗ health failed"
	@curl -sf http://127.0.0.1:$${PROXY_PORT:-3100}/ready | python3 -m json.tool 2>/dev/null || echo "✗ ready check failed"

clean: ## remove dist/
	rm -rf "$(DIST_DIR)"
