#!/usr/bin/env bash
#
# AriseBrowser + Neko dependency installer
# Supports: Debian/Ubuntu (apt) and CentOS/RHEL/Fedora (dnf/yum)
#
# Usage: sudo bash setup.sh
#

set -euo pipefail

NEKO_VERSION="${NEKO_VERSION:-v3.3.0}"
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

# Detect package manager
if command -v apt-get &>/dev/null; then
  PKG_MGR="apt"
elif command -v dnf &>/dev/null; then
  PKG_MGR="dnf"
elif command -v yum &>/dev/null; then
  PKG_MGR="yum"
else
  err "Unsupported package manager. Need apt, dnf, or yum."
  exit 1
fi

log "Detected package manager: ${PKG_MGR}"

# ─── System packages ───────────────────────────────────────────────

install_apt() {
  apt-get update -qq

  # Xvfb + X11
  apt-get install -y -qq \
    xvfb \
    xserver-xorg-video-dummy \
    x11-xserver-utils \
    xdotool

  # PulseAudio
  apt-get install -y -qq pulseaudio

  # Openbox window manager
  apt-get install -y -qq openbox

  # GStreamer (full suite for Neko)
  apt-get install -y -qq \
    libgstreamer1.0-0 \
    gstreamer1.0-plugins-base \
    gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad \
    gstreamer1.0-plugins-ugly \
    gstreamer1.0-pulseaudio \
    gstreamer1.0-x

  # CJK + emoji fonts
  apt-get install -y -qq \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    fonts-liberation

  # Misc
  apt-get install -y -qq \
    curl \
    wget \
    ca-certificates \
    gnupg
}

install_rpm() {
  local mgr="$1"

  # Enable EPEL
  if ! rpm -q epel-release &>/dev/null; then
    $mgr install -y epel-release
  fi

  # Enable RPM Fusion (for GStreamer ugly plugins)
  if ! rpm -q rpmfusion-free-release &>/dev/null; then
    $mgr install -y \
      "https://mirrors.rpmfusion.org/free/el/rpmfusion-free-release-$(rpm -E %rhel).noarch.rpm" || true
  fi

  # Xvfb + X11
  $mgr install -y \
    xorg-x11-server-Xvfb \
    xorg-x11-drv-dummy \
    xorg-x11-utils \
    xdotool

  # PulseAudio
  $mgr install -y pulseaudio pulseaudio-utils

  # Openbox
  $mgr install -y openbox

  # GStreamer
  $mgr install -y \
    gstreamer1 \
    gstreamer1-plugins-base \
    gstreamer1-plugins-good \
    gstreamer1-plugins-bad-free \
    gstreamer1-plugins-ugly \
    gstreamer1-plugins-good-extras

  # CJK + emoji fonts
  $mgr install -y \
    google-noto-sans-cjk-fonts \
    google-noto-emoji-color-fonts \
    liberation-fonts

  # Misc
  $mgr install -y \
    curl \
    wget \
    ca-certificates
}

case "$PKG_MGR" in
  apt) install_apt ;;
  dnf) install_rpm dnf ;;
  yum) install_rpm yum ;;
esac

log "System packages installed"

# ─── Google Chrome ─────────────────────────────────────────────────

if ! command -v google-chrome &>/dev/null && ! command -v google-chrome-stable &>/dev/null; then
  if [[ "$NEKO_ARCH" == "arm64" ]]; then
    # Google Chrome has no ARM64 Linux builds — install Chromium instead
    log "Installing Chromium (ARM64, Google Chrome not available)..."
    if [[ "$PKG_MGR" == "apt" ]]; then
      apt-get install -y -qq chromium-browser || apt-get install -y -qq chromium
    else
      $PKG_MGR install -y chromium
    fi
    log "Chromium installed"
  else
    log "Installing Google Chrome..."
    if [[ "$PKG_MGR" == "apt" ]]; then
      wget -q -O /tmp/google-chrome.deb \
        "https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb"
      apt-get install -y -qq /tmp/google-chrome.deb
      rm -f /tmp/google-chrome.deb
    else
      cat > /etc/yum.repos.d/google-chrome.repo <<'REPO'
[google-chrome]
name=google-chrome
baseurl=https://dl.google.com/linux/chrome/rpm/stable/x86_64
enabled=1
gpgcheck=1
gpgkey=https://dl.google.com/linux/linux_signing_key.pub
REPO
      $PKG_MGR install -y google-chrome-stable
    fi
    log "Google Chrome installed"
  fi
else
  log "Google Chrome/Chromium already installed"
fi

# ─── Chrome policies ──────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POLICIES_SRC="${SCRIPT_DIR}/policies.json"
POLICIES_DST="/etc/opt/chrome/policies/managed/arise-browser.json"

if [[ -f "$POLICIES_SRC" ]]; then
  mkdir -p "$(dirname "$POLICIES_DST")"
  cp "$POLICIES_SRC" "$POLICIES_DST"
  log "Chrome policies installed to ${POLICIES_DST}"
else
  warn "policies.json not found at ${POLICIES_SRC}, skipping"
fi

# ─── Node.js ──────────────────────────────────────────────────────

if ! command -v node &>/dev/null; then
  log "Installing Node.js ${NODE_MAJOR}..."

  if [[ "$PKG_MGR" == "apt" ]]; then
    curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash -
    apt-get install -y -qq nodejs
  else
    curl -fsSL https://rpm.nodesource.com/setup_${NODE_MAJOR}.x | bash -
    $PKG_MGR install -y nodejs
  fi

  log "Node.js installed: $(node --version)"
else
  log "Node.js already installed: $(node --version)"
fi

# ─── Neko server binary ──────────────────────────────────────────

NEKO_BIN="/usr/local/bin/neko"
NEKO_WWW="/usr/local/share/neko/www"

# Detect arch early so it's available for all sections
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)  NEKO_ARCH="amd64" ;;
  aarch64) NEKO_ARCH="arm64" ;;
  *)       err "Unsupported architecture: $ARCH"; exit 1 ;;
esac

if [[ ! -f "$NEKO_BIN" ]]; then
  log "Installing Neko server ${NEKO_VERSION}..."

  NEKO_URL="https://github.com/m1k1o/neko/releases/download/${NEKO_VERSION}/server-${NEKO_ARCH}"
  wget -q -O "$NEKO_BIN" "$NEKO_URL"
  chmod +x "$NEKO_BIN"

  log "Neko server installed to ${NEKO_BIN}"
else
  log "Neko server already installed at ${NEKO_BIN}"
fi

# ─── Neko client static files ────────────────────────────────────

if [[ ! -d "$NEKO_WWW" ]]; then
  log "Installing Neko client files..."

  NEKO_CLIENT_URL="https://github.com/m1k1o/neko/releases/download/${NEKO_VERSION}/client.tar.gz"
  mkdir -p "$NEKO_WWW"
  wget -q -O /tmp/neko-client.tar.gz "$NEKO_CLIENT_URL"
  tar -xzf /tmp/neko-client.tar.gz -C "$NEKO_WWW"
  rm -f /tmp/neko-client.tar.gz

  log "Neko client files installed to ${NEKO_WWW}"
else
  log "Neko client files already at ${NEKO_WWW}"
fi

# ─── Neko X11 drivers ────────────────────────────────────────────

XORG_MODULES="/usr/lib/xorg/modules"
if [[ -d "$XORG_MODULES" ]]; then
  NEKO_DRIVERS_URL="https://github.com/m1k1o/neko/releases/download/${NEKO_VERSION}/xf86-input-neko-${NEKO_ARCH}.tar.gz"

  if [[ ! -f "${XORG_MODULES}/input/neko_drv.so" ]]; then
    log "Installing Neko X11 input driver..."
    wget -q -O /tmp/neko-drivers.tar.gz "$NEKO_DRIVERS_URL" || true
    if [[ -f /tmp/neko-drivers.tar.gz ]]; then
      tar -xzf /tmp/neko-drivers.tar.gz -C "$XORG_MODULES" || true
      rm -f /tmp/neko-drivers.tar.gz
      log "Neko X11 drivers installed"
    else
      warn "Could not download Neko X11 drivers (non-critical)"
    fi
  else
    log "Neko X11 drivers already installed"
  fi
fi

# ─── Playwright browser deps ─────────────────────────────────────

if command -v npx &>/dev/null; then
  log "Installing Playwright Chromium dependencies..."
  npx playwright install-deps chromium 2>/dev/null || warn "playwright install-deps skipped"
fi

# ─── System user ──────────────────────────────────────────────────

if ! id -u neko &>/dev/null; then
  log "Creating 'neko' system user..."
  useradd -r -m -s /bin/bash neko
  usermod -aG audio,video neko
  log "User 'neko' created"
else
  log "User 'neko' already exists"
fi

# ─── Summary ──────────────────────────────────────────────────────

echo ""
log "Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Deploy arise-browser to /opt/arise-browser/"
echo "  2. Install systemd service:"
echo "     cp deploy/neko/arise-browser.service /etc/systemd/system/"
echo "     systemctl daemon-reload"
echo "     systemctl enable --now arise-browser"
echo ""
echo "  Or run manually:"
echo "     node dist/bin/arise-browser.js --virtual-display --port 9867 --host 0.0.0.0"
echo ""
echo "Ports:"
echo "  - 9867  arise-browser API"
echo "  - 6090  Neko WebRTC UI"
echo "  - 52000-52100  WebRTC UDP"
