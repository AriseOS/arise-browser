#!/usr/bin/env node

/**
 * AriseBrowser CLI — Start the HTTP server.
 *
 * Usage:
 *   npx arise-browser [options]
 *
 * Options:
 *   --port, -p       Server port (default: 9867)
 *   --host           Bind address (default: 127.0.0.1)
 *   --token          Auth token
 *   --headless       Run headless (default: true)
 *   --no-headless    Run with visible browser
 *   --profile        Browser profile directory (enables managed mode)
 *   --cdp            CDP endpoint URL (enables cdp mode)
 *   --help           Show help
 *
 * Environment variables (Pinchtab-compatible):
 *   ARISE_BROWSER_PORT / BRIDGE_PORT
 *   ARISE_BROWSER_BIND / BRIDGE_BIND
 *   ARISE_BROWSER_TOKEN / BRIDGE_TOKEN
 *   ARISE_BROWSER_HEADLESS
 *   ARISE_BROWSER_PROFILE
 */

import { createServer } from "../src/server/server.js";
import type { AriseBrowserConfig } from "../src/types/index.js";
import { readFileSync } from "node:fs";

function getPackageVersion(): string {
  const candidates = [
    new URL("../package.json", import.meta.url),
    new URL("../../package.json", import.meta.url),
  ];

  for (const candidate of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf-8")) as { version?: string };
      if (pkg.version) {
        return pkg.version;
      }
    } catch {
      // try next path
    }
  }

  throw new Error(`Could not locate package.json for CLI version. Tried: ${candidates.join(", ")}`);
}

const PKG_VERSION = getPackageVersion();

const args = process.argv.slice(2);

function getArg(names: string[]): string | undefined {
  for (const name of names) {
    const idx = args.indexOf(name);
    if (idx !== -1 && idx + 1 < args.length) {
      return args[idx + 1];
    }
  }
  return undefined;
}

function hasFlag(names: string[]): boolean {
  return names.some((n) => args.includes(n));
}

if (hasFlag(["--help", "-h"])) {
  console.log(`
AriseBrowser — AI browser automation engine

Usage: arise-browser [options]

Options:
  --port, -p <port>    Server port (default: 9867)
  --host <host>        Bind address (default: 127.0.0.1)
  --token <token>      Bearer auth token
  --headless           Run headless (default)
  --no-headless        Run with visible browser
  --profile <dir>      Browser profile dir (managed mode)
  --cdp <url>          CDP endpoint URL (cdp mode)
  --help               Show this help

Environment variables:
  ARISE_BROWSER_PORT / BRIDGE_PORT     Default: 9867
  ARISE_BROWSER_BIND / BRIDGE_BIND     Default: 127.0.0.1
  ARISE_BROWSER_TOKEN / BRIDGE_TOKEN   Auth token
  ARISE_BROWSER_HEADLESS               "true" or "false"
  ARISE_BROWSER_PROFILE                Profile dir (managed mode)
`);
  process.exit(0);
}

const port = parseInt(
  getArg(["--port", "-p"])
    || process.env.ARISE_BROWSER_PORT
    || process.env.BRIDGE_PORT
    || "9867",
  10,
);
if (Number.isNaN(port) || port < 0 || port > 65535) {
  console.error("Error: invalid port number");
  process.exit(1);
}

const host =
  getArg(["--host"])
    || process.env.ARISE_BROWSER_BIND
    || process.env.BRIDGE_BIND
    || "127.0.0.1";

const token =
  getArg(["--token"])
    || process.env.ARISE_BROWSER_TOKEN
    || process.env.BRIDGE_TOKEN;

const cdpUrl = getArg(["--cdp"]);
const profileDir =
  getArg(["--profile"])
    || process.env.ARISE_BROWSER_PROFILE;

let headless = true;
if (hasFlag(["--no-headless"])) {
  headless = false;
} else if (process.env.ARISE_BROWSER_HEADLESS === "false") {
  headless = false;
}

// Determine mode
let mode: AriseBrowserConfig["mode"] = "standalone";
if (cdpUrl) {
  mode = "cdp";
} else if (profileDir) {
  mode = "managed";
}

const browserConfig: AriseBrowserConfig = {
  mode,
  cdpUrl,
  headless,
  profileDir,
  stealthHeaders: true,
};

async function main() {
  console.log(`AriseBrowser v${PKG_VERSION}`);
  console.log(`Mode: ${mode} | Headless: ${headless} | Port: ${port}`);

  const server = await createServer(browserConfig, { port, host, token });

  await server.listen({ port, host });

  console.log(`Server listening on http://${host}:${port}`);
  if (token) {
    console.log(`Auth: Bearer token required`);
  } else {
    console.log(`Auth: disabled (set ARISE_BROWSER_TOKEN to enable)`);
  }

  // Graceful shutdown with forced exit timeout
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      console.log("Forced exit.");
      process.exit(1);
    }
    shuttingDown = true;
    console.log("\nShutting down...");

    const forceTimer = setTimeout(() => {
      console.error("Shutdown timed out — forcing exit");
      process.exit(1);
    }, 10_000);
    forceTimer.unref();

    try {
      await server.close();
    } catch (e) {
      console.error("Error during shutdown:", e);
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
