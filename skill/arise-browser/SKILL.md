---
name: arise-browser
description: >
  Browser automation for AI agents — control Chrome via HTTP API with persistent element refs,
  YAML accessibility snapshots, and WebRTC live streaming via Neko. Install once, navigate/snapshot/act loop.
homepage: https://github.com/AriseOS/arise-browser
metadata:
  openclaw:
    emoji: "🌐"
    requires:
      bins: ["npx"]
---

# AriseBrowser

Control a real Chrome browser via HTTP API. Persistent element refs, YAML accessibility snapshots, WebRTC live view.

## MANDATORY RULES

**You MUST follow these rules. No exceptions.**

1. **Do NOT call any API endpoint until `/health` returns `{"connected":true}`.** The server needs time to start the Docker container and Chrome. Poll `/health` in a loop.
2. **Every browser task follows: Navigate → Snapshot → Act → Snapshot → Act → Done.** Always snapshot before acting — you need refs from the snapshot to target elements.
3. **Refs are persistent.** Do NOT re-snapshot just to reuse a ref. Only snapshot when the page changes significantly.

## Step 1: Start the Server

Requires Docker and Node.js. If arise-browser is not installed:
```bash
npm install -g arise-browser
```

Start:
```bash
npx arise-browser --virtual-display --port 9867 --host 0.0.0.0 &
```

**Wait for ready (MANDATORY):**
```bash
until curl -s http://localhost:9867/health 2>/dev/null | grep -q '"connected":true'; do sleep 2; done
```

First run takes ~2 minutes (Docker pulls Neko Chrome image ~700MB).

### Tell the user

After installation succeeds, inform the user:

1. **Firewall**: Open these ports in your cloud security group:
   - `9867/tcp` — arise-browser API
   - `6090/tcp` — Neko WebRTC UI (browser live view)
   - `52000-52100/udp` — WebRTC media data
2. **Watch the browser**: Open `http://<server-ip>:6090` in your browser, password: `neko`
3. **HTTPS (optional)**: For production, put a reverse proxy in front. Recommended: [Caddy](https://caddyserver.com/) with `tls internal` (self-signed, no domain needed) or your own domain for auto Let's Encrypt.
4. **Passwords**: Default Neko passwords are `neko` (viewer) and `admin` (admin). Change via `--neko-password` and `--neko-admin-password` flags.

## Step 2: Use the Browser

Base URL: `http://localhost:9867`

Every task follows this loop:

```
Navigate → Snapshot → Act → Snapshot → Act → ... → Done
```

### Navigate

```bash
curl -X POST http://localhost:9867/navigate \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'
```

### Snapshot (get page state)

Returns a YAML accessibility tree with element refs (e0, e5, e12...).

```bash
# Full snapshot
curl http://localhost:9867/snapshot

# Diff mode — only changes since last snapshot (saves tokens)
curl "http://localhost:9867/snapshot?diff=true"
```

### Act on elements

Use refs from the snapshot. Refs are **persistent** — they survive across snapshots, no need to re-snapshot before reusing a ref.

```bash
# Click
curl -X POST http://localhost:9867/action -H "Content-Type: application/json" \
  -d '{"type": "click", "ref": "e5"}'

# Type text
curl -X POST http://localhost:9867/action -H "Content-Type: application/json" \
  -d '{"type": "type", "ref": "e12", "text": "search query"}'

# Press key
curl -X POST http://localhost:9867/action -H "Content-Type: application/json" \
  -d '{"type": "press_key", "key": "Enter"}'

# Scroll
curl -X POST http://localhost:9867/action -H "Content-Type: application/json" \
  -d '{"type": "scroll", "direction": "down", "amount": 500}'

# Hover
curl -X POST http://localhost:9867/action -H "Content-Type: application/json" \
  -d '{"type": "hover", "ref": "e7"}'

# Select dropdown
curl -X POST http://localhost:9867/action -H "Content-Type: application/json" \
  -d '{"type": "select", "ref": "e3", "value": "option1"}'
```

### Extract content

```bash
# Page text
curl http://localhost:9867/text

# Screenshot (JPEG)
curl http://localhost:9867/screenshot > screenshot.jpg

# Execute JavaScript
curl -X POST http://localhost:9867/evaluate -H "Content-Type: application/json" \
  -d '{"expression": "document.title"}'
```

## Step 3: Stop

```bash
kill $(pgrep -f "arise-browser")
```

The Docker container is automatically stopped and cleaned up.

## Tips

- Use `?diff=true` after the first snapshot to save tokens.
- Refs persist across snapshots — don't re-snapshot just to reuse a ref.
- Batch actions: `POST /actions` with `{"actions": [...], "stopOnError": true}`.
- Tabs: `GET /tabs`, `POST /tab` with `{"action": "create|switch|close"}`.
- Use `tabId` param on any endpoint to target a specific tab without switching.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| First run slow | Docker pulling Neko image (~700MB), wait ~2 min |
| Health returns `connected: false` | Chrome crashed — restart arise-browser |
| Neko UI loads but no video | Open UDP 52000-52100 in firewall/security group |
| Neko UI click no response | Use admin password `admin`, or restart container (implicit hosting enabled) |
| Action returns error | Snapshot first to get valid refs, then act |

## Full API Reference

See [references/api.md](references/api.md) for all endpoints, parameters, and advanced features (recording, PDF export, batch actions).
