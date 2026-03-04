---
name: amipilot
description: >
  Control a headless or headed Chromium browser via AmiPilot's HTTP API. Use for web automation,
  scraping, form filling, navigation, and multi-tab workflows. AmiPilot exposes a YAML accessibility
  tree with persistent refs (WeakMap + aria-ref + signature), multi-strategy click fallbacks, and
  behavior recording with Learn protocol export — built for AI agents that need reliable browser control.
  Use when the task involves: browsing websites, filling forms, clicking buttons, extracting
  page text, taking screenshots, recording workflows, or any browser-based automation.
homepage: https://github.com/AmiProject/amipilot
metadata:
  openclaw:
    emoji: "🚀"
    requires:
      bins: ["npx"]
      env: |
        AMIPILOT_TOKEN (optional, secret) - Bearer auth token
        AMIPILOT_PORT (optional) - HTTP port, default 9867
        AMIPILOT_HEADLESS (optional) - true/false, default true
        AMIPILOT_PROFILE (optional) - Chromium profile directory
        AMIPILOT_BIND (optional) - Bind address, default 127.0.0.1
---

# AmiPilot

Industrial-grade browser automation for AI agents. Persistent refs, multi-strategy clicks, behavior recording.

**Security Note:** AmiPilot runs entirely locally. It does not contact external services or send telemetry. It controls a real Chromium instance — if pointed at a profile with saved logins, agents can access authenticated sites. Always use a dedicated empty profile and set AMIPILOT_TOKEN when exposing the API. See [TRUST.md](TRUST.md) for the full security model.

## Quick Start (Agent Workflow)

```bash
# 1. Start AmiPilot (local on :9867)
npx amipilot &

# 2. In your agent, follow this loop:
#    a) Navigate to a URL
#    b) Snapshot the page (get refs like e0, e5, e12)
#    c) Act on a ref (click e5, type e12 "search text")
#    d) Snapshot again to see the result
#    e) Repeat until done
```

**Refs are persistent** — AmiPilot's 3-layer ref system (WeakMap → aria-ref → signature) means refs survive across snapshots. You don't need to re-snapshot before every action.

### Recommended Secure Setup

```bash
AMIPILOT_BIND=127.0.0.1 \
AMIPILOT_TOKEN="your-strong-secret" \
AMIPILOT_PROFILE=~/.amipilot/automation-profile \
npx amipilot &
```

**Never expose to 0.0.0.0 without a token. Never point at your daily browser profile.**

## Setup

```bash
# Headless (default)
npx amipilot &

# Headed — visible browser for debugging
npx amipilot --no-headless &

# With auth token
AMIPILOT_TOKEN="your-secret-token" npx amipilot &

# Custom port
npx amipilot --port 8080 &

# Connect to existing browser via CDP
npx amipilot --cdp http://localhost:9222 &

# Persistent profile
npx amipilot --profile ~/.amipilot/my-profile &
```

Default: **port 9867**, no auth required (local). Set `AMIPILOT_TOKEN` for remote access.

## Core Workflow

### 1. Navigate

```bash
curl -X POST http://localhost:9867/navigate \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'
```

### 2. Snapshot

```bash
# YAML format (default, best for AI agents)
curl http://localhost:9867/snapshot

# JSON format (structured)
curl "http://localhost:9867/snapshot?format=json"

# Diff mode (only changes since last snapshot)
curl "http://localhost:9867/snapshot?diff=true"
```

### 3. Act

```bash
# Click by ref
curl -X POST http://localhost:9867/action \
  -H "Content-Type: application/json" \
  -d '{"kind": "click", "ref": "e5"}'

# Type into field
curl -X POST http://localhost:9867/action \
  -H "Content-Type: application/json" \
  -d '{"kind": "type", "ref": "e12", "text": "hello world"}'

# Press key
curl -X POST http://localhost:9867/action \
  -H "Content-Type: application/json" \
  -d '{"kind": "press", "key": "Enter"}'

# Scroll down
curl -X POST http://localhost:9867/action \
  -H "Content-Type: application/json" \
  -d '{"kind": "scroll", "scrollY": 300}'

# Hover
curl -X POST http://localhost:9867/action \
  -H "Content-Type: application/json" \
  -d '{"kind": "hover", "ref": "e7"}'

# Select option
curl -X POST http://localhost:9867/action \
  -H "Content-Type: application/json" \
  -d '{"kind": "select", "ref": "e3", "value": "option1"}'
```

### 4. Record & Export

```bash
# Start recording
curl -X POST http://localhost:9867/recording/start
# => {"recordingId": "session_20260303T180000"}

# ... perform actions ...

# Stop recording
curl -X POST http://localhost:9867/recording/stop \
  -d '{"recordingId": "session_20260303T180000"}'

# Export as Learn protocol
curl -X POST http://localhost:9867/recording/export \
  -d '{"recordingId": "session_20260303T180000", "task": "Search for AI products"}'
```

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/tabs` | GET | List all tabs |
| `/navigate` | POST | Navigate to URL |
| `/snapshot` | GET | Accessibility tree snapshot |
| `/action` | POST | Execute single action |
| `/actions` | POST | Execute batch actions |
| `/text` | GET | Extract page text |
| `/screenshot` | GET | JPEG screenshot |
| `/pdf` | GET | PDF export |
| `/evaluate` | POST | Execute JavaScript |
| `/tab` | POST | Create/close/switch tabs |
| `/tab/lock` | POST | Lock tab (multi-agent) |
| `/tab/unlock` | POST | Unlock tab |
| `/cookies` | GET/POST | Read/write cookies |
| `/recording/start` | POST | Start recording |
| `/recording/stop` | POST | Stop recording |
| `/recording/status` | GET | Recording status |
| `/recording/export` | POST | Export Learn format |

## Why AmiPilot over Pinchtab?

| Feature | AmiPilot | Pinchtab |
|---------|----------|----------|
| Persistent Refs | 3-layer (WeakMap + aria-ref + signature) | Single pass |
| Click Strategy | Ctrl+Click → Force Click fallback | Single attempt |
| Select support | Full implementation | Empty stub |
| Behavior Recording | Built-in + Learn protocol export | Not available |
| Coordinate handling | Viewport-validated | Hardcoded (0,0) |
| Runtime | Node.js + Playwright | Go + CDP |

## Token Cost Guide

- Snapshot (YAML): ~500-2000 tokens depending on page complexity
- Snapshot (JSON): ~300-1500 tokens
- Action response: ~50-100 tokens
- Recording export: ~100-500 tokens per workflow

## Pinchtab Compatibility

AmiPilot accepts Pinchtab's `kind` field in `/action`:
- `kind: "click"` → click
- `kind: "type"` / `kind: "fill"` → type
- `kind: "press"` → press_key
- `kind: "scroll"` (with `scrollY`) → scroll
- `kind: "hover"` → hover
- `kind: "select"` → select
- `kind: "focus"` → focus

Environment variables `BRIDGE_*` are also accepted as aliases for `AMIPILOT_*`.
