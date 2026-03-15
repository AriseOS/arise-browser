# deploy/neko/

Configuration files for running arise-browser with Neko streaming on Linux servers.

## Architecture

arise-browser is the single entry process managing all child processes:
Xvfb (virtual display) -> PulseAudio (virtual audio) -> Openbox (window manager) -> Chrome (CDP) -> Neko (WebRTC streaming)

No supervisord — arise-browser's VirtualDisplayManager handles process lifecycle.

## Files

| File | Source | Purpose |
|------|--------|---------|
| `xorg.conf` | neko/runtime/xorg.conf | X11 virtual display with multiple resolution modes |
| `pulseaudio.pa` | neko/runtime/default.pa | Virtual audio sinks for Neko |
| `openbox.xml` | neko/apps/google-chrome/openbox.xml | Window manager: no decorations, maximized Chrome |
| `neko.yaml` | Custom | Neko server defaults (overridden by CLI args via env vars) |
| `policies.json` | Modified from neko | Chrome policies: CDP enabled, popups allowed |
| `arise-browser.service` | Custom | systemd unit file |
| `setup.sh` | Custom | One-shot dependency installer (Debian/Ubuntu + CentOS/RHEL) |

## Port Allocation

| Service | Port | Exposure |
|---------|------|----------|
| Neko HTTP/WS | 6090 | Public (user WebRTC) |
| WebRTC UDP | 52000-52100 | Public (data channel) |
| arise-browser | 9867 | As needed (AI agent API) |
| Chrome CDP | 9222 | localhost only |

## Key Differences from Neko Defaults

- `policies.json`: `DeveloperToolsAvailability: 0` (allow CDP), `DefaultPopupsSetting: 1` (allow popups)
- No forced browser extensions (uBlock Origin, Dark Reader removed)
- `neko.yaml`: `implicit_hosting: true` (auto-assign host to first user)
