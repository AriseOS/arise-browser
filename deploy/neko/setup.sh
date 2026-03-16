#!/usr/bin/env bash
#
# AriseBrowser + Neko Docker setup
# Installs: Docker, Node.js, builds arise-neko image
#
# Usage: sudo bash setup.sh
#

set -euo pipefail

NODE_MAJOR="${NODE_MAJOR:-20}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[+]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[x]${NC} $*" >&2; }

if [[ $EUID -ne 0 ]]; then
  err "This script must be run as root (use sudo)"
  exit 1
fi

# ─── Docker ───────────────────────────────────────────────────────

if ! command -v docker &>/dev/null; then
  log "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
  log "Docker installed: $(docker --version)"
else
  log "Docker already installed: $(docker --version)"
fi

# ─── Node.js ──────────────────────────────────────────────────────

if ! command -v node &>/dev/null; then
  log "Installing Node.js ${NODE_MAJOR}..."

  if command -v apt-get &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash -
    apt-get install -y -qq nodejs
  elif command -v dnf &>/dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_${NODE_MAJOR}.x | bash -
    dnf install -y nodejs
  elif command -v yum &>/dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_${NODE_MAJOR}.x | bash -
    yum install -y nodejs
  else
    err "No supported package manager (apt/dnf/yum) found for Node.js install"
    exit 1
  fi

  log "Node.js installed: $(node --version)"
else
  log "Node.js already installed: $(node --version)"
fi

# ─── Build arise-neko Docker image ───────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log "Building arise-neko Docker image..."
docker build -t arise-neko "$SCRIPT_DIR"
log "arise-neko image built"

# ─── Summary ──────────────────────────────────────────────────────

echo ""
log "Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Install arise-browser:"
echo "     npm install -g arise-browser"
echo ""
echo "  2. Run:"
echo "     npx arise-browser --virtual-display --port 9867 --host 0.0.0.0"
echo ""
echo "  Or use systemd:"
echo "     cp deploy/neko/arise-browser.service /etc/systemd/system/"
echo "     systemctl daemon-reload"
echo "     systemctl enable --now arise-browser"
echo ""
echo "Ports:"
echo "  - 9867          arise-browser API"
echo "  - 6090          Neko WebRTC UI"
echo "  - 9222          Chrome CDP (localhost only)"
echo "  - 52000-52100   WebRTC UDP"
