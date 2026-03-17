# deploy/neko/

Docker-based Neko integration for running arise-browser with a visible browser on Linux servers.

## Architecture

arise-browser manages a single Docker container (`arise-neko`) that bundles Xvfb + PulseAudio + Openbox + Chrome + Neko WebRTC server. arise-browser connects to Chrome inside the container via CDP.

```
arise-browser (Node.js, host)
  ├── docker run arise-neko
  │     └── supervisord: Xorg, PulseAudio, Openbox, Chrome (CDP :9222), Neko (:8080)
  ├── Playwright connectOverCDP(localhost:9222)
  └── Fastify HTTP Server (:16473)
```

## Files

| File | Purpose |
|------|---------|
| `Dockerfile` | Custom image based on `ghcr.io/m1k1o/neko/google-chrome:latest`, adds CDP support |
| `supervisord.conf` | Chrome launch config with `--remote-debugging-port=9222` |
| `policies.json` | Chrome managed policies (allow CDP, popups, disable autofill) |
| `arise-browser.service` | systemd unit (requires docker.service) |
| `setup.sh` | One-shot installer: Docker + Node.js + image build |

## Port Allocation

| Service | Host Port | Container Port | Exposure |
|---------|-----------|----------------|----------|
| Neko HTTP/WS | 6090 | 8080 | Public (WebRTC UI) |
| Chrome CDP | 9222 | 9222 | localhost only |
| WebRTC UDP | 52000-52100 | 52000-52100 | Public |
| arise-browser | 16473 | — | As needed (API) |

## Persistent Profile

Chrome profile is stored in a Docker named volume (`arise-neko-profile`) mounted at `/home/neko/.config/google-chrome`.
