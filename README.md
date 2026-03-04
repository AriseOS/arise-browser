# AmiPilot

AI browser automation engine — persistent refs, multi-strategy actions, behavior recording.

## Features

- **3-layer persistent ref system** — WeakMap + aria-ref + signature-based element tracking
- **Multi-strategy action execution** — 15 action types with intelligent fallback (click, type, scroll, hover, select, etc.)
- **3 connection modes** — Standalone (launch Chromium), CDP (connect to existing), Managed (persistent profile)
- **Behavior recording** — CDP-based operation capture with Learn protocol export
- **Pinchtab-compatible REST API** — Drop-in replacement with extended capabilities
- **OpenClaw Skill + Plugin** — Ready for agent ecosystem integration

## Quick Start

```bash
# Install
npm install

# Build
npm run build

# Run server (headless, port 9867)
npx amipilot

# Run with visible browser
npx amipilot --no-headless

# Custom port + auth
AMIPILOT_TOKEN=secret npx amipilot --port 8080
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/tabs` | GET | List all tabs |
| `/navigate` | POST | Navigate to URL |
| `/snapshot` | GET | Accessibility snapshot |
| `/action` | POST | Execute single action |
| `/actions` | POST | Batch actions |
| `/text` | GET | Extract page text |
| `/screenshot` | GET | JPEG screenshot |
| `/pdf` | GET | PDF export |
| `/evaluate` | POST | Execute JavaScript |
| `/cookies` | GET/POST | Read/write cookies |
| `/upload` | POST | File upload |
| `/download` | GET | File download |
| `/recording/start` | POST | Start behavior recording |
| `/recording/stop` | POST | Stop recording |
| `/recording/export` | POST | Export as Learn protocol |

## Library Usage

```typescript
import { BrowserSession, createServer } from "amipilot";

// As a library
const session = BrowserSession.create({ mode: "standalone", headless: true });
await session.ensureBrowser();
await session.visit("https://example.com");
const snapshot = await session.getSnapshot();

// As an HTTP server
const server = await createServer(
  { mode: "standalone", headless: true },
  { port: 9867, token: "secret" }
);
await server.listen({ port: 9867 });
```

## License

MIT
