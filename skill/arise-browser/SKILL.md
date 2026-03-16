---
name: arise-browser
description: >
  Control a Chromium browser via HTTP API for web automation — browsing, form filling, clicking,
  text extraction, screenshots, and workflow recording. Uses persistent element refs that survive
  across snapshots, multi-strategy click fallbacks, and YAML accessibility tree snapshots optimized
  for low token usage. Supports headless mode (any platform) and headed virtual display mode with
  WebRTC live streaming (Linux servers). Use when the task involves any browser-based interaction.
homepage: https://github.com/AriseOS/arise-browser
metadata:
  openclaw:
    emoji: "🚀"
    requires:
      bins: ["npx"]
---

# AriseBrowser

Browser automation for AI agents via HTTP API. Persistent refs, multi-strategy clicks, behavior recording.

## Step 1: Install

```bash
# Install globally (makes `arise-browser` command available)
npm install -g arise-browser
```

Or use `npx arise-browser` to run without global install — npm downloads it automatically.

### Virtual Display Mode (optional, Linux servers only)

If you need **headed mode** on a headless Linux server (real Chrome with Xvfb + WebRTC streaming so users can watch), install system dependencies first:

```bash
# Check if we're on Linux and headed mode is needed
uname -s  # Must be "Linux"

# Install Xvfb, Chrome, Neko, PulseAudio, Openbox, GStreamer, fonts
sudo bash <(curl -fsSL https://raw.githubusercontent.com/AriseOS/arise-browser/main/deploy/neko/setup.sh)
```

This is only needed once per server. Skip this for headless mode.

## Step 2: Start the Server

```bash
# Headless mode (default, works everywhere)
npx arise-browser --port 9867 &

# Headed virtual display mode (Linux only, after setup.sh)
npx arise-browser --virtual-display --port 9867 --host 0.0.0.0 \
  --neko-port 6090 --neko-password "neko" --neko-admin-password "admin" &
```

Wait for the server to be ready:

```bash
until curl -s http://localhost:9867/health > /dev/null 2>&1; do sleep 1; done
```

Verify:

```bash
curl http://localhost:9867/health
# → {"status":"ok","connected":true,"version":"0.1.0"}
```

In virtual display mode, users can open `http://<server>:6090` in their browser to watch and interact with Chrome via WebRTC (password: "neko").

## Step 3: Use the API

Base URL: `http://localhost:9867`

Every browser task follows this loop:

```
Navigate → Snapshot → Act → Snapshot → Act → ... → Done
```

Refs (e0, e5, e12...) are **persistent** across snapshots. No need to re-snapshot before every action.

### Navigate

```bash
curl -X POST http://localhost:9867/navigate \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'
```

### Snapshot (Get Page State)

```bash
# YAML (default, lowest token cost)
curl http://localhost:9867/snapshot

# Diff mode — only changes since last snapshot
curl "http://localhost:9867/snapshot?diff=true"

# JSON format
curl "http://localhost:9867/snapshot?format=json"
```

### Actions

```bash
# Click
curl -X POST http://localhost:9867/action -H "Content-Type: application/json" \
  -d '{"type": "click", "ref": "e5"}'

# Type
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

### Batch Actions

```bash
curl -X POST http://localhost:9867/actions -H "Content-Type: application/json" \
  -d '{"actions": [
    {"type": "click", "ref": "e5"},
    {"type": "type", "ref": "e12", "text": "hello"},
    {"type": "press_key", "key": "Enter"}
  ], "stopOnError": true}'
```

### Tabs

```bash
# List
curl http://localhost:9867/tabs

# Create
curl -X POST http://localhost:9867/tab -H "Content-Type: application/json" \
  -d '{"action": "create", "url": "https://example.com"}'

# Switch
curl -X POST http://localhost:9867/tab -H "Content-Type: application/json" \
  -d '{"action": "switch", "tabId": "tab-001"}'

# Close
curl -X POST http://localhost:9867/tab -H "Content-Type: application/json" \
  -d '{"action": "close", "tabId": "tab-001"}'
```

### Content Extraction

```bash
# Page text
curl http://localhost:9867/text

# Screenshot (JPEG)
curl http://localhost:9867/screenshot > screenshot.jpg

# PDF
curl http://localhost:9867/pdf > page.pdf

# Execute JavaScript
curl -X POST http://localhost:9867/evaluate -H "Content-Type: application/json" \
  -d '{"expression": "document.title"}'
```

### Recording (Capture Workflow)

```bash
# Start
curl -X POST http://localhost:9867/recording/start
# → {"recordingId": "session_..."}

# ... perform actions ...

# Stop
curl -X POST http://localhost:9867/recording/stop -H "Content-Type: application/json" \
  -d '{"recordingId": "session_..."}'

# Export as structured trace
curl -X POST http://localhost:9867/recording/export -H "Content-Type: application/json" \
  -d '{"recordingId": "session_...", "task": "Book a meeting room"}'
```

## Step 4: Stop the Server

```bash
# Find and stop
kill $(pgrep -f "arise-browser")
```

Or send SIGTERM to the process. All child processes (Xvfb, Chrome, Neko...) are cleaned up automatically.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `npx arise-browser` hangs | Playwright downloading Chromium — wait, first run takes ~1 min |
| Health returns `connected: false` | Chrome crashed or hasn't started — restart arise-browser |
| Virtual display: "Chrome not found" | Run `setup.sh` first, or install Chrome/Chromium |
| Virtual display: Neko timeout | Check that ports 6090 and 52000-52100/udp are open |
| Action returns error | Snapshot first to get valid refs, then act on them |

## Tips

- Use `?diff=true` after the first snapshot to save tokens.
- Refs persist across snapshots — don't re-snapshot just to reuse a ref.
- Use `tabId` on any endpoint to target a specific tab without switching.
- Batch actions when you have a sequence that doesn't need intermediate snapshots.
- Actions accept both `type` and `kind` field names (`kind: "click"` also works).

## Full API Reference

See [references/api.md](references/api.md) for complete endpoint documentation with all parameters.
