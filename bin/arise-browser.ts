#!/usr/bin/env node

/**
 * AriseBrowser CLI — Entry point.
 *
 * Routes to CLI subcommands (start, open, snap, click, etc.) if the first
 * argument is a known command. Otherwise starts the HTTP server directly
 * (legacy / daemon mode).
 *
 * Usage:
 *   npx arise-browser start [options]    # Start server as daemon
 *   npx arise-browser open <url>         # Navigate
 *   npx arise-browser snap               # Page snapshot
 *   npx arise-browser [server-options]   # Direct server mode (legacy)
 */

const KNOWN_COMMANDS = [
  "start", "stop", "open", "snap", "click", "type",
  "select", "press", "scroll", "screenshot", "tabs", "health",
];

const firstArg = process.argv[2];

if (firstArg && KNOWN_COMMANDS.includes(firstArg)) {
  // CLI subcommand mode
  import("./cli.js").then((m) => m.run()).catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
} else {
  // Server mode (original behavior)
  startServer();
}

async function startServer() {
  const { createServer } = await import("../src/server/server.js");
  const { VirtualDisplayManager } = await import("../src/virtual-display/manager.js");
  const { readFileSync } = await import("node:fs");

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

Usage:
  arise-browser <command> [args]       CLI mode (recommended)
  arise-browser [server-options]       Direct server mode (legacy)

Commands:
  start, stop, open, snap, click, type, select, press, scroll,
  screenshot, tabs, health

  Run 'arise-browser <command>' without args for command-specific help.

Server options (direct mode):
  --port, -p <port>    Server port (default: 16473)
  --host <host>        Bind address (default: 127.0.0.1)
  --token <token>      Bearer auth token
  --headless           Run headless (default)
  --no-headless        Run with visible browser
  --profile <dir>      Browser profile dir (managed mode)
  --cdp <url>          CDP endpoint URL (cdp mode)
  --help               Show this help

Virtual display:
  --virtual-display         Enable Docker virtual display container
  --neko-port <port>        Virtual display HTTP/WS port (default: 6090)
  --neko-password <pwd>     User password (default: "neko")
  --neko-admin-password <pwd> Admin password (default: "admin")
  --container-name <name>   Docker container name (default: "arise-neko")
  --image-name <name>       Docker image name (default: "arise-neko")

Environment variables:
  ARISE_BROWSER_PORT / BRIDGE_PORT     Default: 16473
  ARISE_BROWSER_BIND / BRIDGE_BIND     Default: 127.0.0.1
  ARISE_BROWSER_TOKEN / BRIDGE_TOKEN   Auth token
  ARISE_BROWSER_HEADLESS               "true" or "false"
  ARISE_BROWSER_PROFILE                Profile dir (managed mode)
  ARISE_BROWSER_VIRTUAL_DISPLAY        "true" to enable virtual display
  ARISE_BROWSER_NEKO_PORT              Virtual display port (default: 6090)
  ARISE_BROWSER_NEKO_PASSWORD          User password
  ARISE_BROWSER_NEKO_ADMIN_PASSWORD    Admin password
  ARISE_BROWSER_CONTAINER_NAME         Container name (default: "arise-neko")
  ARISE_BROWSER_IMAGE_NAME             Image name (default: "arise-neko")
`);
    process.exit(0);
  }

  const port = parseInt(
    getArg(["--port", "-p"])
      || process.env.ARISE_BROWSER_PORT
      || process.env.BRIDGE_PORT
      || "16473",
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

  // Virtual display mode
  const virtualDisplayEnabled =
    hasFlag(["--virtual-display"])
    || process.env.ARISE_BROWSER_VIRTUAL_DISPLAY === "true";

  const nekoPort = parseInt(
    getArg(["--neko-port"])
      || process.env.ARISE_BROWSER_NEKO_PORT
      || "6090",
    10,
  );

  const nekoPassword =
    getArg(["--neko-password"])
      || process.env.ARISE_BROWSER_NEKO_PASSWORD
      || "neko";

  const nekoAdminPassword =
    getArg(["--neko-admin-password"])
      || process.env.ARISE_BROWSER_NEKO_ADMIN_PASSWORD
      || "admin";

  const containerName =
    getArg(["--container-name"])
      || process.env.ARISE_BROWSER_CONTAINER_NAME
      || "arise-neko";

  const imageName =
    getArg(["--image-name"])
      || process.env.ARISE_BROWSER_IMAGE_NAME
      || "arise-neko";

  // Determine mode
  type BrowserMode = "standalone" | "cdp" | "managed";
  let mode: BrowserMode = "standalone";
  let effectiveCdpUrl = cdpUrl;

  if (virtualDisplayEnabled) {
    mode = "cdp";
    effectiveCdpUrl = "http://localhost:9222";
  } else if (cdpUrl) {
    mode = "cdp";
  } else if (profileDir) {
    mode = "managed";
  }

  const browserConfig = {
    mode,
    cdpUrl: effectiveCdpUrl,
    headless,
    profileDir,
    stealthHeaders: true,
    ...(virtualDisplayEnabled && {
      virtualDisplay: {
        enabled: true,
        nekoPort,
        nekoPassword,
        nekoAdminPassword,
        containerName,
        imageName,
      },
    }),
  };

  try {
    console.log(`AriseBrowser v${PKG_VERSION}`);
    console.log(`Mode: ${mode} | Headless: ${headless} | Port: ${port}`);

    let displayManager: InstanceType<typeof VirtualDisplayManager> | null = null;

    if (virtualDisplayEnabled) {
      console.log(`Virtual display: enabled (port :${nekoPort})`);
      displayManager = new VirtualDisplayManager({
        nekoPort,
        nekoPassword,
        nekoAdminPassword,
        containerName,
        imageName,
      });
      await displayManager.start();
    }

    const server = await createServer(browserConfig as any, { port, host, token });

    await server.listen({ port, host });

    console.log(`Server listening on http://${host}:${port}`);
    if (token) {
      console.log(`Auth: Bearer token required`);
    } else {
      console.log(`Auth: disabled (set ARISE_BROWSER_TOKEN to enable)`);
    }
    if (displayManager) {
      console.log(`Live view on http://0.0.0.0:${nekoPort}`);
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
      }, 15_000);
      forceTimer.unref();

      try {
        await server.close();
      } catch (e) {
        console.error("Error during server shutdown:", e);
      }

      if (displayManager) {
        try {
          await displayManager.stop();
        } catch (e) {
          console.error("Error during display shutdown:", e);
        }
      }

      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (err) {
    console.error("Fatal:", err);
    process.exit(1);
  }
}
