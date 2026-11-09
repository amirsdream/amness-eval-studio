#!/usr/bin/env bash
# Install the studio on a Debian/Ubuntu machine (or a Proxmox LXC with nesting=1): Docker with Compose, Node, uv and Harbor, and the two services.
# Run as root from a checkout of this repository: sudo deploy/install-debian.sh
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates git docker.io docker-compose nodejs >/dev/null
systemctl enable --now docker
command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh
"$HOME/.local/bin/uv" tool install harbor >/dev/null 2>&1 || "$HOME/.local/bin/uv" tool upgrade harbor
[ "$here" = /opt/amness-eval-studio ] || { rm -rf /opt/amness-eval-studio; cp -a "$here" /opt/amness-eval-studio; }
install -m 644 "$here/deploy/amness-studio-run.service" "$here/deploy/amness-studio-ui.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now amness-studio-ui
echo "UI: http://$(hostname -I | awk '{print $1}'):8090/"
echo "Start a campaign: systemctl enable --now amness-studio-run   (campaign name: systemctl edit amness-studio-run)"
