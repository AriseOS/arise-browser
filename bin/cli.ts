#!/usr/bin/env node

/**
 * AriseBrowser CLI — Agent-friendly subcommands for browser control.
 *
 * Each subcommand calls the local HTTP server and outputs plain text.
 */

import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const STATE_DIR = join(homedir(), ".arise-browser");
const PID_FILE = join(STATE_DIR, "server.pid");
const PORT_FILE = join(STATE_DIR, "server.port");

const DEFAULT_PORT = 16473;

function resolvePort(): number {
  const envPort = process.env.ARISE_BROWSER_PORT || process.env.BRIDGE_PORT;
  if (envPort) return parseInt(envPort, 10);

  try {
    const stored = readFileSync(PORT_FILE, "utf-8").trim();
    if (stored) return parseInt(stored, 10);
  } catch {
    // file doesn't exist
  }

  return DEFAULT_PORT;
}

function baseUrl(): string {
  return `http://127.0.0.1:${resolvePort()}`;
}

async function fetchJson(path: string, init?: RequestInit): Promise<any> {
  const url = `${baseUrl()}${path}`;
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let msg: string;
    try {
      const json = JSON.parse(text);
      msg = json.error || json.message || text;
    } catch {
      msg = text;
    }
    throw new Error(`${res.status}: ${msg}`);
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("text/plain")) {
    return { __text: await res.text() };
  }
  if (ct.includes("image/")) {
    return { __buffer: Buffer.from(await res.arrayBuffer()) };
  }
  return res.json();
}

function die(msg: string): never {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

// ── Subcommands ──────────────────────────────────────────────

async function cmdHealth(): Promise<void> {
  try {
    const data = await fetchJson("/health");
    if (data.status === "ok" && data.connected) {
      console.log("ok");
    } else {
      console.log(`status=${data.status} connected=${data.connected}`);
    }
  } catch {
    console.log("not running");
    process.exit(1);
  }
}

async function cmdStart(args: string[]): Promise<void> {
  // Check if already running
  try {
    const data = await fetchJson("/health");
    if (data.status === "ok") {
      console.log(`Already running on port ${resolvePort()}`);
      return;
    }
  } catch {
    // not running, continue
  }

  const port = resolvePort();

  // Build server args — pass through all flags + force port
  const serverArgs: string[] = ["--port", String(port)];
  for (const arg of args) {
    // Skip subcommand name "start"
    if (arg === "start") continue;
    serverArgs.push(arg);
  }

  // Find the server entry point
  const binPath = new URL("./arise-browser.js", import.meta.url).pathname;

  mkdirSync(STATE_DIR, { recursive: true });

  // Spawn as detached daemon
  const child = spawn(process.execPath, [binPath, ...serverArgs], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, ARISE_BROWSER_CLI_SERVER: "1" },
  });

  child.unref();

  if (!child.pid) {
    die("Failed to start server process");
  }

  writeFileSync(PID_FILE, String(child.pid));
  writeFileSync(PORT_FILE, String(port));

  // Poll health until ready (max 120s)
  const deadline = Date.now() + 120_000;
  let ready = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const data = await fetchJson("/health");
      if (data.status === "ok" && data.connected) {
        ready = true;
        break;
      }
    } catch {
      // not ready yet
    }
  }

  if (!ready) {
    die("Server started but did not become ready within 120s");
  }

  console.log(`Server ready on port ${port}`);
}

async function cmdStop(): Promise<void> {
  // Kill server process
  let killed = false;
  try {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    if (pid > 0) {
      try {
        process.kill(pid, "SIGTERM");
        killed = true;
      } catch (e: any) {
        if (e.code !== "ESRCH") throw e;
        // already dead
      }
    }
  } catch {
    // no PID file
  }

  // Try to stop Docker container
  try {
    const containerName = process.env.ARISE_BROWSER_CONTAINER_NAME || "arise-neko";
    const docker = spawn("docker", ["rm", "-f", containerName], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    await new Promise<void>((resolve) => docker.on("close", () => resolve()));
  } catch {
    // docker not available or no container
  }

  // Clean up state files
  for (const f of [PID_FILE, PORT_FILE]) {
    try { unlinkSync(f); } catch { /* ignore */ }
  }

  console.log("Stopped");
}

async function cmdOpen(args: string[]): Promise<void> {
  const url = args[0];
  if (!url) die("Usage: arise-browser open <url>");

  const data = await fetchJson("/navigate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  console.log(`Navigated to ${data.url || url}`);
}

async function cmdSnap(): Promise<void> {
  const data = await fetchJson("/snapshot?format=yaml");
  if (data.__text) {
    console.log(data.__text);
  } else if (data.snapshot) {
    console.log(data.snapshot);
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

async function cmdClick(args: string[]): Promise<void> {
  const ref = args[0];
  if (!ref) die("Usage: arise-browser click <ref>");

  await fetchJson("/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "click", ref }),
  });
  console.log(`Clicked ${ref}`);
}

async function cmdType(args: string[]): Promise<void> {
  const ref = args[0];
  const text = args.slice(1).join(" ");
  if (!ref || !text) die("Usage: arise-browser type <ref> <text>");

  await fetchJson("/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "type", ref, text }),
  });
  console.log(`Typed '${text}' into ${ref}`);
}

async function cmdSelect(args: string[]): Promise<void> {
  const ref = args[0];
  const value = args.slice(1).join(" ");
  if (!ref || !value) die("Usage: arise-browser select <ref> <value>");

  await fetchJson("/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "select", ref, value }),
  });
  console.log(`Selected '${value}' on ${ref}`);
}

async function cmdPress(args: string[]): Promise<void> {
  const key = args[0];
  if (!key) die("Usage: arise-browser press <key>");

  await fetchJson("/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "press_key", key }),
  });
  console.log(`Pressed ${key}`);
}

async function cmdScroll(args: string[]): Promise<void> {
  const direction = args[0];
  if (!direction) die("Usage: arise-browser scroll <up|down|left|right> [amount]");

  const amount = args[1] ? parseInt(args[1], 10) : undefined;
  const body: Record<string, unknown> = { type: "scroll", direction };
  if (amount !== undefined && !Number.isNaN(amount)) {
    body.amount = amount;
  }

  await fetchJson("/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  console.log(`Scrolled ${direction}${amount ? ` ${amount}px` : ""}`);
}

async function cmdScreenshot(args: string[]): Promise<void> {
  const file = args[0] || "screenshot.jpg";

  const res = await fetch(`${baseUrl()}/screenshot?raw=true`);
  if (!res.ok) {
    die(`Screenshot failed: ${res.status}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  writeFileSync(file, buffer);
  console.log(file);
}

async function cmdTabs(): Promise<void> {
  const data = await fetchJson("/tabs");
  const tabs = data.tabs || [];
  for (const tab of tabs) {
    const active = tab.is_current ? " *" : "";
    const id = tab.tab_id || tab.tabId || tab.id || "";
    console.log(`${id}  ${tab.title || ""}  ${tab.url || ""}${active}`);
  }
}

// ── Dispatch ─────────────────────────────────────────────────

const COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  start: cmdStart,
  stop: () => cmdStop(),
  open: cmdOpen,
  snap: () => cmdSnap(),
  click: cmdClick,
  type: cmdType,
  select: cmdSelect,
  press: cmdPress,
  scroll: cmdScroll,
  screenshot: cmdScreenshot,
  tabs: () => cmdTabs(),
  health: () => cmdHealth(),
};

export const KNOWN_COMMANDS = Object.keys(COMMANDS);

export async function run(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || !COMMANDS[cmd]) {
    console.log(`Usage: arise-browser <command> [args]

Commands:
  start                     Start the browser server (daemon)
  stop                      Stop the server and clean up
  open <url>                Navigate to URL
  snap                      Take page snapshot (YAML)
  click <ref>               Click element by ref
  type <ref> <text>         Type text into element
  select <ref> <value>      Select dropdown value
  press <key>               Press keyboard key
  scroll <dir> [amount]     Scroll page (up/down/left/right)
  screenshot [file]         Save screenshot to file
  tabs                      List open tabs
  health                    Check server status

Options for 'start':
  --virtual-display         Enable Docker virtual display
  --port, -p <port>         Server port (default: ${DEFAULT_PORT})
  --host <host>             Bind address (default: 127.0.0.1)
  --headless / --no-headless
  --cdp <url>               CDP endpoint URL
  --profile <dir>           Browser profile directory
`);
    process.exit(cmd ? 1 : 0);
  }

  const handler = COMMANDS[cmd];
  const cmdArgs = argv.slice(1);

  try {
    await handler(cmdArgs);
  } catch (e: any) {
    die(e.message || String(e));
  }
}
