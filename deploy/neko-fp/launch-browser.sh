#!/bin/bash
# Launch fingerprint-chromium inside the arise-neko-fp container.
#
# Inputs (container environment, set by arise-browser):
#   ARISE_FP_SEED      required, fingerprint seed (positive integer)
#   ARISE_FP_TIMEZONE  IANA timezone, default UTC — should match the egress IP
#   ARISE_FP_LANG      primary language, default en-US
#
# Design: keep everything the site can cross-check consistent with the real
# machine. Platform follows the real OS (linux) so UA, fonts and the TCP/IP
# stack agree; core count is the real one. Only seed-derived values (canvas,
# audio, ClientRects, WebGL image, deviceMemory) are spoofed.
set -euo pipefail

if [[ ! "${ARISE_FP_SEED:-}" =~ ^[1-9][0-9]{0,9}$ ]]; then
  echo "arise-fp-browser: ARISE_FP_SEED must be a positive integer" >&2
  exit 1
fi

TZ_NAME="${ARISE_FP_TIMEZONE:-UTC}"
LANG_PRIMARY="${ARISE_FP_LANG:-en-US}"
LANG_BASE="${LANG_PRIMARY%%-*}"
ACCEPT_LANG="$LANG_PRIMARY"
[[ "$LANG_BASE" != "$LANG_PRIMARY" ]] && ACCEPT_LANG="$LANG_PRIMARY,$LANG_BASE"

FP_VERSION="$(cat /opt/fp-chromium/ARISE_FP_VERSION)"
# Real Chrome on Linux reports the kernel version as three numbers (6.12.117)
KERNEL_VERSION="$(uname -r | cut -d+ -f1 | cut -d- -f1)"
PROFILE_DIR=/home/neko/.config/arise-chrome

rm -f "$PROFILE_DIR/SingletonLock" "$PROFILE_DIR/SingletonSocket" "$PROFILE_DIR/SingletonCookie"

# Wait for the window manager (openbox in the browser image, xfwm4 on the XFCE
# desktop); a window created before it is up ignores --start-maximized, and the
# window size is visible to sites (outerWidth/innerWidth vs screen).
# Do not pass --window-position: with it, neither window manager maximizes the
# window (measured 945px wide on a 1920px screen).
for _ in $(seq 1 40); do
  if pgrep -x xfwm4 >/dev/null || pgrep -x openbox >/dev/null; then break; fi
  sleep 0.5
done
sleep 1

exec /opt/fp-chromium/chrome \
  --fingerprint="$ARISE_FP_SEED" \
  --fingerprint-platform=linux \
  --fingerprint-platform-version="$KERNEL_VERSION" \
  --fingerprint-hardware-concurrency="$(nproc)" \
  --fingerprint-brand=Chrome \
  --fingerprint-brand-version="$FP_VERSION" \
  --timezone="$TZ_NAME" \
  --lang="$LANG_PRIMARY" \
  --accept-lang="$ACCEPT_LANG" \
  --disable-quic \
  --force-webrtc-ip-handling-policy=disable_non_proxied_udp \
  --enable-unsafe-swiftshader \
  --display="$DISPLAY" \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --start-maximized \
  --force-dark-mode \
  --disable-file-system \
  --disable-gpu \
  --disable-dev-shm-usage \
  --no-sandbox \
  --remote-debugging-port=9222
