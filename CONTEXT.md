# AriseBrowser

AI browser automation engine extracted from arise-desktop's browser control layer.

## Architecture

- **Core library** (`src/browser/`): BrowserSession, ActionExecutor, PageSnapshot, BehaviorRecorder
- **HTTP server** (`src/server/`): Fastify-based REST API, Pinchtab-compatible endpoints
- **Virtual display** (`src/virtual-display/`): VirtualDisplayManager for Linux server deployment (Xvfb + Neko)
- **CLI** (`bin/arise-browser.ts`): `npx arise-browser` entry point
- **Deploy configs** (`deploy/neko/`): Xorg, PulseAudio, Openbox, Neko, Chrome policies, systemd, setup script
- **OpenClaw** (`skill/`, `plugin/`): Skill definition + plugin manifest

## Connection Modes

| Mode | Description | Config |
|------|-------------|--------|
| `standalone` | Launch new Chromium | `headless`, `viewport` |
| `cdp` | Connect to existing browser | `cdpUrl` |
| `managed` | Persistent browser profile | `profileDir`, `headless` |
| `virtual-display` | Linux server with Neko streaming | `--virtual-display` (forces cdp mode) |

### Virtual Display Mode

`--virtual-display` starts Xvfb + PulseAudio + Openbox + Chrome + Neko as child processes, then connects via CDP. Users watch/control the browser through Neko's WebRTC UI (port 6090). See `deploy/neko/CONTEXT.md` for details.

## Key Differentiators (vs Pinchtab)

- **3-layer persistent refs**: WeakMap → aria-ref → signature (unified_analyzer.js)
- **Multi-strategy click**: Ctrl+Click for new tab → Force click fallback
- **Behavior recording**: CDP-based, Learn protocol export
- **Full select**: Implemented (Pinchtab has empty stub)
- **Viewport-validated coordinates**: (Pinchtab hardcodes 0,0)

## Element Data

PageSnapshot caches the `elements` map (ref → {name, role}) from unified_analyzer.js on every `capture()` call. Access via `PageSnapshot.getLastElements()` or `BrowserSession.getLastElements()`. This allows consumers (e.g., arise-desktop) to look up element metadata for clicked/typed refs without regex-parsing snapshot text.

## Key Files

| File | Purpose |
|------|---------|
| `src/browser/browser-session.ts` | Core session management, 3 connection modes, `getLastElements()` |
| `src/browser/action-executor.ts` | 15 action types including hover/focus |
| `src/browser/page-snapshot.ts` | YAML accessibility tree via unified_analyzer.js, elements cache |
| `src/browser/behavior-recorder.ts` | CDP recording with dataload detection |
| `src/browser/scripts/unified_analyzer.js` | Page-injected 3-layer ref system (47KB) |
| `src/browser/scripts/behavior_tracker.js` | Page-injected behavior tracker (14KB) |
| `src/server/server.ts` | Fastify server factory |
| `src/server/routes/` | One file per endpoint |
| `src/logger.ts` | Injectable logger interface + pino default |
| `src/lock.ts` | In-memory tab lock for multi-agent coordination |
| `src/types/index.ts` | All public type definitions (SessionRef, ActionResult, TabInfo, etc.) |
| `src/virtual-display/manager.ts` | VirtualDisplayManager — orchestrates Xvfb/PulseAudio/Openbox/Chrome/Neko |
| `src/virtual-display/process-runner.ts` | Child process runner with auto-restart and readiness checks |

## API Endpoints

Health, tabs, navigate, snapshot, action, actions, text, screenshot, pdf, evaluate, tab, tab/lock, tab/unlock, cookies, recording/*

## Pinchtab Compatibility

- Accepts `kind` field (mapped to `type`)
- Accepts `BRIDGE_*` env vars as aliases for `ARISE_BROWSER_*`
- Same default port (9867)
- JSON snapshot format compatible

## Dependencies

- `playwright` — Browser automation
- `fastify` — HTTP server
- `pino` / `pino-pretty` — Logging
