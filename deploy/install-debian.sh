#!/usr/bin/env bash
# Install the studio on a Debian/Ubuntu machine (or a Proxmox LXC with nesting=1): Docker with Compose, Node, uv and Harbor, the UI build, and one service.
# Run as root from a checkout of this repository: sudo deploy/install-debian.sh
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates git docker.io docker-compose nodejs npm >/dev/null
systemctl enable --now docker
command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh
"$HOME/.local/bin/uv" tool install harbor >/dev/null 2>&1 || "$HOME/.local/bin/uv" tool upgrade harbor
[ "$here" = /opt/amness-eval-studio ] || { rm -rf /opt/amness-eval-studio; cp -a "$here" /opt/amness-eval-studio; }
cd /opt/amness-eval-studio && npm ci --no-fund --no-audit && npm run build
# The token for the controls in the browser (start, pause, stop, run again): made once, kept across updates.
[ -f /etc/amness-studio.env ] || { umask 077; echo "STUDIO_TOKEN=$(head -c 24 /dev/urandom | base64 | tr -d '/+=')" > /etc/amness-studio.env; }
install -m 644 deploy/amness-studio.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now amness-studio
systemctl restart amness-studio
echo "Studio: http://$(hostname -I | awk '{print $1}'):8090/"
echo "Token for the controls: $(sed -n 's/^STUDIO_TOKEN=//p' /etc/amness-studio.env)   (also in /etc/amness-studio.env)"
