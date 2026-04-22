#!/bin/bash
set -e

echo "Agent CLI Proxy Server Setup"
echo "============================"

if [ "$EUID" -ne 0 ]; then
  echo "Please run as root (use sudo)"
  exit 1
fi

if ! command -v bun \u0026\u003e /dev/null; then
  echo "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

if ! id -u agent-proxy \u0026\u003e /dev/null; then
  echo "Creating agent-proxy user..."
  useradd -r -s /bin/false -m -d /opt/agent-cli-proxy agent-proxy
fi

echo "Copying files..."
rsync -av --exclude='node_modules' --exclude='data' --exclude='.git' \
  "$(dirname "$0")/" /opt/agent-cli-proxy/

echo "Installing dependencies..."
cd /opt/agent-cli-proxy
bun install

mkdir -p /opt/agent-cli-proxy/data
chown -R agent-proxy:agent-proxy /opt/agent-cli-proxy

echo "Setting up environment..."
if [ ! -f /opt/agent-cli-proxy/.env ]; then
  cp /opt/agent-cli-proxy/.env.example /opt/agent-cli-proxy/.env
  echo "Created .env file. Please edit it with your configuration."
fi

echo "Installing systemd service..."
cp /opt/agent-cli-proxy/agent-cli-proxy.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable agent-cli-proxy

echo ""
echo "Setup complete!"
echo ""
echo "Next steps:"
echo "1. Edit /opt/agent-cli-proxy/.env with your configuration"
echo "2. Start the service: sudo systemctl start agent-cli-proxy"
echo "3. Check status: sudo systemctl status agent-cli-proxy"
echo "4. View logs: sudo journalctl -u agent-cli-proxy -f"
