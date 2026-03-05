# AriseBrowser

AI browser automation engine built for agents — reliable actions, persistent element refs, behavior recording.

Built on Playwright. Ships as both an HTTP server and a TypeScript library.

## Why AriseBrowser

Most browser automation tools are built for scripted testing. AriseBrowser is built for **AI agents** that need to interact with real-world websites reliably and learn from user behavior.

### Reliable Actions (Not Just "Click and Hope")

Clicking a button sounds simple — until the element is in a dropdown, behind an overlay, or opens a new tab. AriseBrowser uses **multi-strategy execution with observable state validation**:

- **Click**: 3 strategies — Ctrl+Click for new tab detection → regular click → force click fallback. After every click, validates that something actually changed (URL, active element, dialogs, expanded state).
- **Select**: Full implementation with 12 fallback strategies for both native `<select>` and custom dropdowns (role=option, data-value, aria-label, text match, keyboard fallback).
- **Type**: Input detection, debounced reporting, Enter key handling with pre-flush.

Compare: other tools dispatch a CDP mouse event at hardcoded coordinates and return "success" without checking if anything happened.

### Persistent Element References

Elements on a page change — DOM mutates, SPAs re-render, navigations happen. AriseBrowser maintains element identity across all of this with a **3-layer ref system**:

1. **WeakMap** — Fast in-memory cache, zero DOM overhead
2. **aria-ref attribute** — Injected into DOM, survives re-renders
3. **Signature matching** — Tag + class + text fingerprint for fallback recovery

Refs like `e0`, `e42` remain stable across SPA navigations. Your agent can reference an element it saw 5 actions ago and it still works.

### Behavior Recording → Learn Protocol

Record what a user does, export it as structured workflow data:

```
User demonstrates: "Book a flight on Kayak"
    ↓
AriseBrowser records: click, type, select, navigate events with refs
    ↓
Export as Learn protocol: { task, steps: [{url, action, target}], metadata }
    ↓
Feed to memory system → Agent can replay and adapt the workflow
```

This is the foundation for **learning from demonstration** — the agent watches, learns, and automates.

### Compact Snapshots, Less Tokens

Accessibility snapshots in YAML format — typically **~50% fewer tokens** than JSON equivalents. With interactive filtering, your agent only sees actionable elements (buttons, links, inputs), not the entire DOM.

Diff mode returns only what changed since the last snapshot — saves even more tokens on multi-step workflows.

## Quick Start

```bash
npm install
npm run build

# Run server (headless, port 9867)
npx arise-browser

# Visible browser
npx arise-browser --no-headless

# Custom port + auth token
ARISE_BROWSER_TOKEN=secret npx arise-browser --port 8080
```

## Connection Modes

| Mode | Use Case | Flag |
|------|----------|------|
| **Standalone** | Launch fresh Chromium | (default) |
| **CDP** | Connect to existing Chrome | `--cdp ws://localhost:9222` |
| **Managed** | Persistent profile (cookies, logins) | `--profile ~/.browser-profile` |

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/tabs` | GET | List all tabs |
| `/tab` | POST | Create/switch tabs |
| `/tab/lock` | POST | Lock tab for exclusive access |
| `/tab/unlock` | POST | Release tab lock |
| `/navigate` | POST | Navigate to URL |
| `/snapshot` | GET | Accessibility tree (YAML/JSON, with diff & filter) |
| `/action` | POST | Execute single action |
| `/actions` | POST | Batch execute multiple actions |
| `/text` | GET | Extract page text |
| `/screenshot` | GET | JPEG screenshot |
| `/pdf` | GET | PDF export (headless only) |
| `/evaluate` | POST | Execute JavaScript |
| `/cookies` | GET/POST | Read/write cookies |
| `/upload` | POST | File upload |
| `/download` | GET | Wait and download file |
| `/recording/start` | POST | Start behavior recording |
| `/recording/stop` | POST | Stop and get raw operations |
| `/recording/status` | GET | Recording status |
| `/recording/export` | POST | Export as Learn protocol |

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
  { port: 9867, token: "secret" }
);
await server.listen({ port: 9867 });
```

## Multi-Agent Support

AriseBrowser is designed for multi-agent coordination:

- **Tab Groups** — Organize tabs by task ID with color coding
- **Tab Locks** — TTL-based exclusive access (prevent two agents from clicking the same page)
- **Session Registry** — Multiple sessions share one browser instance

## Action Types

15 action types with intelligent error recovery:

| Action | Description |
|--------|-------------|
| `click` | Multi-strategy click with new-tab detection |
| `type` | Type text into input fields |
| `select` | Select dropdown option (native + custom) |
| `scroll` | Scroll page or element |
| `hover` | Hover over element |
| `focus` | Focus element |
| `enter` | Press Enter key |
| `press_key` | Press any key combination |
| `navigate` | Go to URL |
| `back` / `forward` | Browser history navigation |
| `wait` | Wait for condition |
| `extract` | Extract element text/attribute |
| `mouse_control` | Low-level mouse positioning |
| `mouse_drag` | Drag from point A to B |

## Environment Variables

| Variable | Alias | Description |
|----------|-------|-------------|
| `ARISE_BROWSER_PORT` | `BRIDGE_PORT` | Server port (default: 9867) |
| `ARISE_BROWSER_BIND` | `BRIDGE_BIND` | Bind address (default: 127.0.0.1) |
| `ARISE_BROWSER_TOKEN` | `BRIDGE_TOKEN` | Auth bearer token |
| `ARISE_BROWSER_HEADLESS` | — | `true` / `false` |
| `ARISE_BROWSER_PROFILE` | — | Profile directory path |

Pinchtab `BRIDGE_*` env vars are accepted for drop-in compatibility.

## License

MIT
