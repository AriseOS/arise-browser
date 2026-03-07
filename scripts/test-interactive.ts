#!/usr/bin/env -S node --import=tsx
/**
 * AriseBrowser Interactive Console (REPL).
 *
 * Type commands to control the browser and inspect results.
 *
 * Usage:
 *   1. Start server:  node dist/bin/arise-browser.js --no-headless --port 9867
 *   2. Run:           npx tsx scripts/test-interactive.ts [base_url]
 */

import * as readline from "node:readline";

const BASE = process.argv[2] || "http://localhost:9867";

// ── Colors ──
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";

// ── HTTP helpers ──
async function post(path: string, body: unknown = {}) {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function get(path: string) {
  return fetch(`${BASE}${path}`);
}

function showJson(data: unknown) {
  const text = JSON.stringify(data, null, 2);
  const lines = text.split("\n");
  if (lines.length > 80) {
    console.log(lines.slice(0, 70).join("\n"));
    console.log(`${DIM}  ... (${lines.length - 70} more lines)${RESET}`);
  } else {
    console.log(text);
  }
}

function showText(text: string, maxLines = 60) {
  const lines = text.split("\n");
  if (lines.length > maxLines) {
    console.log(lines.slice(0, maxLines).join("\n"));
    console.log(`${DIM}  ... (${lines.length - maxLines} more lines)${RESET}`);
  } else {
    console.log(text);
  }
}

// ── REPL ──
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: `${CYAN}arise>${RESET} `,
});

function printHelp() {
  console.log(`
${BOLD}${CYAN}AriseBrowser Interactive Console${RESET}
${DIM}Base URL: ${BASE}${RESET}

${YELLOW}Navigation${RESET}
  goto <url>                    Navigate to URL
  back                          Go back
  forward                       Go forward

${YELLOW}Snapshot (what the LLM sees)${RESET}
  snap                          YAML snapshot (default, token-efficient)
  snap json                     JSON snapshot with node details
  snap compact                  Compact plain-text snapshot
  snap text                     Text-only snapshot
  snap interactive              Interactive elements only (JSON)
  snap diff                     Diff since last snapshot
  snap viewport                 Viewport-limited snapshot

${YELLOW}Actions${RESET}
  click <ref>                   Click element by ref (e.g. click e5)
  type <ref> <text>             Type text into element (e.g. type e3 hello world)
  select <ref> <value>          Select option (e.g. select e7 blue)
  hover <ref>                   Hover over element
  focus <ref>                   Focus element
  press <key>                   Press key (e.g. press Enter, press Tab)
  scroll <amount>               Scroll (positive=down, negative=up)

${YELLOW}Information${RESET}
  text                          Extract page text
  title                         Get page title
  url                           Get current URL
  screenshot                    Take screenshot (shows size)
  eval <expression>             Evaluate JavaScript

${YELLOW}Tabs${RESET}
  tabs                          List all tabs
  newtab [url]                  Create new tab
  switch <tabId>                Switch to tab
  close <tabId>                 Close tab

${YELLOW}Tab Locks${RESET}
  lock <tabId> <owner>          Lock a tab
  unlock <tabId> <owner>        Unlock a tab

${YELLOW}Recording${RESET}
  rec start                     Start recording
  rec stop <id>                 Stop recording
  rec status [id]               Recording status
  rec export <id> [task]        Export as Learn protocol

${YELLOW}Cookies${RESET}
  cookies                       List cookies
  setcookie <name> <value> [url] Set a cookie

${YELLOW}Other${RESET}
  health                        Server health check
  pdf                           Export PDF (headless only)
  raw <method> <path> [json]    Raw HTTP request
  help                          Show this help
  quit / exit                   Exit
`);
}

async function handleCommand(line: string) {
  const trimmed = line.trim();
  if (!trimmed) return;

  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  try {
    switch (cmd) {
      // ── Navigation ──
      case "goto": {
        const url = parts.slice(1).join(" ");
        if (!url) { console.log(`${RED}Usage: goto <url>${RESET}`); break; }
        const resp = await post("/navigate", { url });
        showJson(await resp.json());
        break;
      }
      case "back": {
        const resp = await post("/action", { type: "back" });
        showJson(await resp.json());
        break;
      }
      case "forward": {
        const resp = await post("/action", { type: "forward" });
        showJson(await resp.json());
        break;
      }

      // ── Snapshot ──
      case "snap":
      case "snapshot": {
        const mode = parts[1]?.toLowerCase();
        if (mode === "json") {
          const resp = await get("/snapshot?format=json");
          const data = await resp.json() as any;
          console.log(`${DIM}url: ${data.url}  |  title: ${data.title}  |  nodes: ${data.count}${RESET}\n`);
          showJson(data.nodes);
        } else if (mode === "compact") {
          const resp = await get("/snapshot?format=compact");
          showText(await resp.text());
        } else if (mode === "text") {
          const resp = await get("/snapshot?format=text");
          showText(await resp.text());
        } else if (mode === "interactive") {
          const resp = await get("/snapshot?format=json&filter=interactive");
          const data = await resp.json() as any;
          console.log(`${DIM}Interactive elements: ${data.count}${RESET}\n`);
          showJson(data.nodes);
        } else if (mode === "diff") {
          const resp = await get("/snapshot?diff=true");
          const data = await resp.json() as any;
          showText(data.snapshot);
          console.log(`${DIM}${data.snapshot.length} chars${RESET}`);
        } else if (mode === "viewport") {
          const resp = await get("/snapshot?format=json&viewportLimit=true");
          const data = await resp.json() as any;
          console.log(`${DIM}Viewport nodes: ${data.count}${RESET}\n`);
          showJson(data.nodes);
        } else {
          // Default: YAML
          const resp = await get("/snapshot");
          const data = await resp.json() as any;
          showText(data.snapshot);
          console.log(`${DIM}${data.snapshot.length} chars (yaml)${RESET}`);
        }
        break;
      }

      // ── Actions ──
      case "click": {
        const ref = parts[1];
        if (!ref) { console.log(`${RED}Usage: click <ref>${RESET}`); break; }
        const resp = await post("/action", { type: "click", ref });
        showJson(await resp.json());
        break;
      }
      case "type": {
        const ref = parts[1];
        const text = parts.slice(2).join(" ");
        if (!ref || !text) { console.log(`${RED}Usage: type <ref> <text>${RESET}`); break; }
        const resp = await post("/action", { type: "type", ref, text });
        showJson(await resp.json());
        break;
      }
      case "select": {
        const ref = parts[1];
        const value = parts.slice(2).join(" ");
        if (!ref || !value) { console.log(`${RED}Usage: select <ref> <value>${RESET}`); break; }
        const resp = await post("/action", { type: "select", ref, value });
        showJson(await resp.json());
        break;
      }
      case "hover": {
        const ref = parts[1];
        if (!ref) { console.log(`${RED}Usage: hover <ref>${RESET}`); break; }
        const resp = await post("/action", { type: "hover", ref });
        showJson(await resp.json());
        break;
      }
      case "focus": {
        const ref = parts[1];
        if (!ref) { console.log(`${RED}Usage: focus <ref>${RESET}`); break; }
        const resp = await post("/action", { type: "focus", ref });
        showJson(await resp.json());
        break;
      }
      case "press": {
        const key = parts.slice(1).join("+");
        if (!key) { console.log(`${RED}Usage: press <key>${RESET}`); break; }
        const resp = await post("/action", { type: "press_key", keys: [key] });
        showJson(await resp.json());
        break;
      }
      case "scroll": {
        const amount = parseInt(parts[1] || "300", 10);
        const resp = await post("/action", { type: "scroll", scrollY: amount });
        showJson(await resp.json());
        break;
      }

      // ── Information ──
      case "text": {
        const resp = await get("/text");
        const data = await resp.json() as any;
        showText(data.text);
        console.log(`${DIM}${data.text.length} chars | url: ${data.url}${RESET}`);
        break;
      }
      case "title": {
        const resp = await post("/evaluate", { expression: "document.title" });
        const data = await resp.json() as any;
        console.log(data.result);
        break;
      }
      case "url": {
        const resp = await post("/evaluate", { expression: "location.href" });
        const data = await resp.json() as any;
        console.log(data.result);
        break;
      }
      case "screenshot": {
        const resp = await get("/screenshot?raw=true");
        const blob = await resp.blob();
        console.log(`${GREEN}Screenshot: ${blob.size} bytes (JPEG)${RESET}`);
        console.log(`${DIM}View at: ${BASE}/screenshot?raw=true${RESET}`);
        break;
      }
      case "eval": {
        const expr = parts.slice(1).join(" ");
        if (!expr) { console.log(`${RED}Usage: eval <expression>${RESET}`); break; }
        const resp = await post("/evaluate", { expression: expr });
        const data = await resp.json() as any;
        if (data.error) console.log(`${RED}${data.error}${RESET}`);
        else console.log(data.result);
        break;
      }

      // ── Tabs ──
      case "tabs": {
        const resp = await get("/tabs");
        const data = await resp.json() as any;
        for (const tab of data.tabs) {
          const marker = tab.is_current ? `${GREEN}*${RESET}` : " ";
          console.log(`  ${marker} ${tab.tab_id}  ${tab.url}  ${DIM}${tab.title}${RESET}`);
        }
        break;
      }
      case "newtab": {
        const url = parts[1];
        const body: any = { action: "create" };
        if (url) body.url = url;
        const resp = await post("/tab", body);
        const data = await resp.json() as any;
        console.log(`${GREEN}Created tab: ${data.tabId}${RESET}`);
        break;
      }
      case "switch": {
        const tabId = parts[1];
        if (!tabId) { console.log(`${RED}Usage: switch <tabId>${RESET}`); break; }
        const resp = await post("/tab", { action: "switch", tabId });
        showJson(await resp.json());
        break;
      }
      case "close": {
        const tabId = parts[1];
        if (!tabId) { console.log(`${RED}Usage: close <tabId>${RESET}`); break; }
        const resp = await post("/tab", { action: "close", tabId });
        showJson(await resp.json());
        break;
      }

      // ── Tab Locks ──
      case "lock": {
        const tabId = parts[1];
        const owner = parts[2];
        if (!tabId || !owner) { console.log(`${RED}Usage: lock <tabId> <owner>${RESET}`); break; }
        const resp = await post("/tab/lock", { tabId, owner, ttlMs: 60000 });
        console.log(`HTTP ${resp.status}`);
        showJson(await resp.json());
        break;
      }
      case "unlock": {
        const tabId = parts[1];
        const owner = parts[2];
        if (!tabId || !owner) { console.log(`${RED}Usage: unlock <tabId> <owner>${RESET}`); break; }
        const resp = await post("/tab/unlock", { tabId, owner });
        console.log(`HTTP ${resp.status}`);
        showJson(await resp.json());
        break;
      }

      // ── Recording ──
      case "rec": {
        const sub = parts[1]?.toLowerCase();
        if (sub === "start") {
          const resp = await post("/recording/start", {});
          const data = await resp.json() as any;
          console.log(`${GREEN}Recording started: ${data.recordingId}${RESET}`);
        } else if (sub === "stop") {
          const id = parts[2];
          if (!id) { console.log(`${RED}Usage: rec stop <recordingId>${RESET}`); break; }
          const resp = await post("/recording/stop", { recordingId: id });
          showJson(await resp.json());
        } else if (sub === "status") {
          const id = parts[2];
          const path = id ? `/recording/status?recordingId=${id}` : "/recording/status";
          const resp = await get(path);
          showJson(await resp.json());
        } else if (sub === "export") {
          const id = parts[2];
          const task = parts.slice(3).join(" ") || undefined;
          if (!id) { console.log(`${RED}Usage: rec export <recordingId> [task description]${RESET}`); break; }
          const resp = await post("/recording/export", { recordingId: id, task });
          showJson(await resp.json());
        } else {
          console.log(`${RED}Usage: rec start | rec stop <id> | rec status [id] | rec export <id> [task]${RESET}`);
        }
        break;
      }

      // ── Cookies ──
      case "cookies": {
        const resp = await get("/cookies");
        const data = await resp.json() as any;
        if (data.cookies.length === 0) {
          console.log(`${DIM}(no cookies)${RESET}`);
        } else {
          for (const c of data.cookies) {
            console.log(`  ${c.name}=${c.value}  ${DIM}${c.domain} ${c.path}${RESET}`);
          }
        }
        break;
      }
      case "setcookie": {
        const name = parts[1];
        const value = parts[2];
        const url = parts[3] || "https://example.com";
        if (!name || !value) { console.log(`${RED}Usage: setcookie <name> <value> [url]${RESET}`); break; }
        const resp = await post("/cookies", { cookies: [{ name, value, url }] });
        showJson(await resp.json());
        break;
      }

      // ── Other ──
      case "health": {
        const resp = await get("/health");
        showJson(await resp.json());
        break;
      }
      case "pdf": {
        const resp = await get("/pdf");
        if (!resp.ok) {
          const data = await resp.json() as any;
          console.log(`${RED}${data.error || `HTTP ${resp.status}`}${RESET}`);
        } else {
          const blob = await resp.blob();
          console.log(`${GREEN}PDF: ${blob.size} bytes${RESET}`);
        }
        break;
      }
      case "raw": {
        const method = (parts[1] || "GET").toUpperCase();
        const path = parts[2];
        const jsonBody = parts.slice(3).join(" ");
        if (!path) { console.log(`${RED}Usage: raw <GET|POST> <path> [json body]${RESET}`); break; }
        let resp: Response;
        if (method === "POST") {
          resp = await post(path, jsonBody ? JSON.parse(jsonBody) : {});
        } else {
          resp = await get(path);
        }
        console.log(`${DIM}HTTP ${resp.status} ${resp.headers.get("content-type")}${RESET}`);
        const ct = resp.headers.get("content-type") || "";
        if (ct.includes("json")) {
          showJson(await resp.json());
        } else if (ct.includes("text")) {
          showText(await resp.text());
        } else {
          const blob = await resp.blob();
          console.log(`${DIM}(binary: ${blob.size} bytes)${RESET}`);
        }
        break;
      }

      case "help":
      case "?":
        printHelp();
        break;

      case "quit":
      case "exit":
      case "q":
        rl.close();
        process.exit(0);

      default:
        console.log(`${RED}Unknown command: ${cmd}${RESET}  (type ${CYAN}help${RESET} for commands)`);
    }
  } catch (err: any) {
    if (err.cause?.code === "ECONNREFUSED") {
      console.log(`${RED}Connection refused — is the server running on ${BASE}?${RESET}`);
    } else {
      console.log(`${RED}Error: ${err.message}${RESET}`);
    }
  }
}

// ── Start ──
console.log(`${BOLD}${CYAN}AriseBrowser Interactive Console${RESET}`);
console.log(`${DIM}Server: ${BASE}  |  Type 'help' for commands${RESET}\n`);

rl.prompt();
rl.on("line", async (line) => {
  await handleCommand(line);
  rl.prompt();
});
rl.on("close", () => process.exit(0));
