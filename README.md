<p align="center">
  <strong>AriseBrowser</strong><br/>
  Browser engine for AI agents.<br/>
  Less tokens. Learns from users and agents. Actually clicks the right thing.<br/>
  Headed mode on servers — watch AI browse in real time via WebRTC.
</p>

<p align="center">
  <a href="https://github.com/AriseOS/arise-browser/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square" alt="License"/></a>
  <img src="https://img.shields.io/badge/Node.js-20+-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js 20+"/>
  <img src="https://img.shields.io/badge/Playwright-powered-2EAD33?style=flat-square&logo=playwright&logoColor=white" alt="Playwright"/>
</p>

---

## 1. Headed Mode on Servers — Watch AI Browse Live

Most browser automation runs headless — invisible. That's fine until you need to:
- **Debug why an agent failed** on a page you can't see
- **Show a client** what the agent is doing in real time
- **Bypass anti-bot systems** that detect headless mode
- **Let users intervene** when the agent gets stuck

AriseBrowser's **virtual display mode** runs a real headed Chrome on any Linux server — no physical monitor needed. Users connect via WebRTC in their browser and see exactly what the AI sees:

```bash
# Install dependencies (once)
sudo bash deploy/neko/setup.sh

# Start with virtual display
npx arise-browser --virtual-display --host 0.0.0.0

# AI agent uses the API as usual
curl -X POST http://server:9867/navigate -d '{"url":"https://example.com"}'

# Users open http://server:6090 in their browser → live view of Chrome
```

Behind the scenes, arise-browser spawns and manages: Xvfb (virtual display) → PulseAudio (audio) → Openbox (window manager) → Chrome (CDP) → Neko (WebRTC streaming). One process, no Docker, no supervisord.

**Why not just use headless?** Anti-bot systems increasingly fingerprint headless environments. A headed Chrome running on a real X11 display is indistinguishable from a human using a desktop — because it *is* a real desktop environment.

## 2. Use Fewer Tokens

Every token your agent spends reading a page is money. AriseBrowser gives your agent a **compact accessibility snapshot** instead of raw HTML:

- **YAML format** — ~50% fewer tokens than equivalent JSON snapshots
- **Interactive filter** — Only show actionable elements (buttons, links, inputs). Skip the noise.
- **Diff mode** — After the first snapshot, only send what changed. On a 10-step workflow, this can cut total snapshot tokens by **70%+**.

Your agent sees what it needs to act, nothing more.

## 3. Learn Once, Automate Forever

AriseBrowser has a built-in **behavior recording** system that captures workflows and exports them as structured traces (Learn protocol). Two ways to teach:

### Watch a user work

Record a human demonstrating a task — AriseBrowser captures every click, type, scroll, and navigation:

```
User demonstrates: "Book a meeting room on Outlook"
         ↓
AriseBrowser records every click, type, scroll, navigation
         ↓
Export as structured trace (Learn protocol):
  { task: "book meeting room",
    steps: [
      { url: "outlook.com/calendar", action: "click", target: "New Event" },
      { url: "...", action: "type", target: "Title", value: "Team Standup" },
      ...
    ] }
         ↓
Feed to your agent's memory / skill system
         ↓
Next time: agent does it autonomously
```

This is how agents go from "follow my script" to "I watched you do it, I know how."

### Learn from agent execution

When your agent completes a task, AriseBrowser can record its actions too. Export the trace and feed it back as a skill — the agent improves with every successful run:

```
Agent completes: "Fill out expense report on SAP"
         ↓
AriseBrowser recorded the entire session
         ↓
Export → Learn protocol trace → store as reusable skill
         ↓
Next time: agent recalls the skill, executes faster, skips exploration
```

No other browser automation tool does recording + structured export out of the box.

## 4. Actions That Actually Work

Clicking a button sounds simple — until it's inside a custom dropdown, behind an overlay, or opens a new tab. Other tools dispatch a mouse event at coordinates (0,0) and call it a day.

AriseBrowser uses **multi-strategy execution**:

| Action | How it works |
|--------|-------------|
| **Click** | Ctrl+Click (new tab detection) → regular click → force click. Validates something actually changed after each attempt. |
| **Select** | 12 fallback strategies — native `<select>`, role=option, data-value, aria-label, text match, keyboard fallback. Works on custom dropdowns too. |
| **Type** | Smart input detection with debounce. Flushes before navigation so nothing gets lost. |

15 action types total: click, type, select, scroll, hover, focus, enter, press_key, navigate, back, forward, wait, extract, mouse_control, mouse_drag.

## 5. Element Refs That Don't Break

Other tools generate element IDs per snapshot — navigate away and they're gone. AriseBrowser uses a **3-layer persistent ref system**:

1. **WeakMap** — Fast in-memory lookup
2. **aria-ref** — Injected into DOM, survives re-renders
3. **Signature** — Tag + class + text fingerprint for recovery after navigation

Your agent can reference `e42` from 5 actions ago. It still resolves.

## 6. Multi-Agent Ready

- **Tab Groups** — Organize tabs by task, color-coded
- **Tab Locks** — TTL-based exclusive access enforced on write routes, prevents two agents from stomping on the same page
- **Session Registry** — Multiple sessions share one browser

---

## Quick Start

```bash
npm install
npm run build

# Headless (default)
npx arise-browser

# Headed on server (Linux, requires deploy/neko/setup.sh)
npx arise-browser --virtual-display --host 0.0.0.0

# With auth token
ARISE_BROWSER_TOKEN=secret npx arise-browser --port 8080
```

## Connection Modes

| Mode | Use Case | Flag |
|------|----------|------|
| **Standalone** | Launch fresh Chromium | (default) |
| **CDP** | Connect to running Chrome | `--cdp ws://localhost:9222` |
| **Managed** | Persistent profile (keeps cookies/logins) | `--profile ~/.browser-profile` |
| **Virtual Display** | Headed Chrome + WebRTC on Linux server | `--virtual-display` |

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/snapshot` | GET | Accessibility tree (YAML/JSON, diff, interactive filter) |
| `/action` | POST | Execute action (click, type, select, ...) |
| `/actions` | POST | Batch execute |
| `/navigate` | POST | Go to URL |
| `/text` | GET | Page text |
| `/screenshot` | GET | JPEG screenshot |
| `/tabs` | GET | List tabs |
| `/tab` | POST | Create/switch tab |
| `/tab/lock` | POST | Lock tab (multi-agent) |
| `/tab/unlock` | POST | Release lock |
| `/recording/start` | POST | Start recording user behavior |
| `/recording/stop` | POST | Stop recording |
| `/recording/export` | POST | Export as Learn protocol |
| `/evaluate` | POST | Run JavaScript |
| `/cookies` | GET/POST | Read/write cookies |
| `/pdf` | GET | PDF export |
| `/upload` | POST | Upload file |
| `/download` | GET | Download file |
| `/health` | GET | Health check |

Notes:
- Read routes support optional `tabId` where applicable (`/snapshot`, `/text`, `/screenshot`, `/pdf`, `/evaluate`, `/download`).
- Write routes that target a tab accept optional `owner`; locked tabs return `423 Locked` unless the owner matches.
- `/navigate` accepts optional `tabId` and `timeout` (milliseconds).
- `/recording/export` works after `/recording/stop` for recently completed recordings.

## Library Usage

```typescript
import { BrowserSession, createServer } from "arise-browser";

// As a library
const session = BrowserSession.create({ mode: "standalone", headless: true });
await session.ensureBrowser();
await session.visit("https://example.com");
const snapshot = await session.getSnapshot();
const result = await session.execAction({ type: "click", ref: "e5" });

// As an HTTP server
const server = await createServer(
  { mode: "standalone", headless: true },
  { port: 9867 }
);
await server.listen({ port: 9867 });
```

## Comparison

| Feature | AriseBrowser | Pinchtab |
|---------|-------------|----------|
| Headed on servers | Xvfb + Neko WebRTC streaming | Not available |
| Snapshot format | YAML (~50% fewer tokens) + diff mode | JSON |
| Persistent refs | 3-layer (WeakMap + aria-ref + signature) | Single pass |
| Click strategy | Multi-strategy with state validation | Single attempt |
| Select support | 12 fallback strategies | Empty stub |
| Behavior recording | Built-in + Learn protocol export | Not available |
| Multi-agent | Tab locks + session registry | Not available |
| Coordinate handling | Viewport-validated | Hardcoded (0,0) |
| Runtime | Node.js + Playwright | Go + CDP |
| Pinchtab compatible | Yes (accepts `kind` field + `BRIDGE_*` env) | — |

## Works with OpenClaw

AriseBrowser ships with an [OpenClaw skill](skill/arise-browser/SKILL.md) and [plugin](plugin/openclaw.plugin.json). Your OpenClaw agent can discover, install, and use AriseBrowser automatically — no manual setup required.

```bash
# OpenClaw agents can use AriseBrowser as their browser backend
# The skill teaches the agent the full API: navigate → snapshot → act → repeat
# The plugin handles lifecycle: start, health check, stop
```

## Environment Variables

| Variable | Alias | Default |
|----------|-------|---------|
| `ARISE_BROWSER_PORT` | `BRIDGE_PORT` | 9867 |
| `ARISE_BROWSER_BIND` | `BRIDGE_BIND` | 127.0.0.1 |
| `ARISE_BROWSER_TOKEN` | `BRIDGE_TOKEN` | (none) |
| `ARISE_BROWSER_HEADLESS` | — | true |
| `ARISE_BROWSER_PROFILE` | — | (none) |
| `ARISE_BROWSER_VIRTUAL_DISPLAY` | — | false |
| `ARISE_BROWSER_NEKO_PORT` | — | 6090 |
| `ARISE_BROWSER_NEKO_PASSWORD` | — | neko |
| `ARISE_BROWSER_NEKO_ADMIN_PASSWORD` | — | admin |

`BRIDGE_*` aliases for Pinchtab drop-in compatibility.

## License

Apache 2.0
