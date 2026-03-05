# AriseBrowser

Browser engine for AI agents. Less tokens. Learns from users. Actually clicks the right thing.

## Why AriseBrowser

### 1. Use Fewer Tokens

Every token your agent spends reading a page is money. AriseBrowser gives your agent a **compact accessibility snapshot** instead of raw HTML:

- **YAML format** — ~50% fewer tokens than equivalent JSON snapshots
- **Interactive filter** — Only show actionable elements (buttons, links, inputs). Skip the noise.
- **Diff mode** — After the first snapshot, only send what changed. On a 10-step workflow, this can cut total snapshot tokens by 70%+.

Your agent sees what it needs to act, nothing more.

### 2. Record Once, Automate Forever

AriseBrowser can **watch a user work** and turn it into a reusable skill:

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
      { url: "...", action: "select", target: "Room", value: "Room 301" },
      ...
    ] }
         ↓
Feed to your agent's memory / skill system
         ↓
Next time: agent does it autonomously, adapts when UI changes
```

This is how agents go from "follow my script" to "I watched you do it, I know how."

No other browser automation tool does this out of the box.

### 3. Actions That Actually Work

Clicking a button sounds simple — until it's inside a custom dropdown, behind an overlay, or opens a new tab. Other tools dispatch a mouse event at coordinates (0,0) and call it a day.

AriseBrowser uses **multi-strategy execution**:

| Action | How it works |
|--------|-------------|
| **Click** | Ctrl+Click (new tab detection) → regular click → force click. Validates something actually changed after each attempt. |
| **Select** | 12 fallback strategies — native `<select>`, role=option, data-value, aria-label, text match, keyboard fallback. Works on custom dropdowns too. |
| **Type** | Smart input detection with debounce. Flushes before navigation so nothing gets lost. |

15 action types total: click, type, select, scroll, hover, focus, enter, press_key, navigate, back, forward, wait, extract, mouse_control, mouse_drag.

### 4. Element Refs That Don't Break

Other tools generate element IDs per snapshot — navigate away and they're gone. AriseBrowser uses a **3-layer persistent ref system**:

1. **WeakMap** — Fast in-memory lookup
2. **aria-ref** — Injected into DOM, survives re-renders
3. **Signature** — Tag + class + text fingerprint for recovery after navigation

Your agent can reference `e42` from 5 actions ago. It still resolves.

## Quick Start

```bash
npm install
npm run build

# Headless server on port 9867
npx arise-browser

# Visible browser
npx arise-browser --no-headless

# With auth token
ARISE_BROWSER_TOKEN=secret npx arise-browser --port 8080
```

## Connection Modes

| Mode | Use Case | Flag |
|------|----------|------|
| **Standalone** | Launch fresh Chromium | (default) |
| **CDP** | Connect to running Chrome | `--cdp ws://localhost:9222` |
| **Managed** | Persistent profile (keeps cookies/logins) | `--profile ~/.browser-profile` |

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

## Multi-Agent

- **Tab Groups** — Organize tabs by task, color-coded
- **Tab Locks** — TTL-based exclusive access, prevents two agents from stomping on the same page
- **Session Registry** — Multiple sessions share one browser

## Environment Variables

| Variable | Alias | Default |
|----------|-------|---------|
| `ARISE_BROWSER_PORT` | `BRIDGE_PORT` | 9867 |
| `ARISE_BROWSER_BIND` | `BRIDGE_BIND` | 127.0.0.1 |
| `ARISE_BROWSER_TOKEN` | `BRIDGE_TOKEN` | (none) |
| `ARISE_BROWSER_HEADLESS` | — | true |
| `ARISE_BROWSER_PROFILE` | — | (none) |

`BRIDGE_*` aliases for Pinchtab drop-in compatibility.

## License

Apache 2.0
