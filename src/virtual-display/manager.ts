/**
 * VirtualDisplayManager — manages Xvfb, PulseAudio, Openbox, Chrome, and Neko
 * as child processes for Linux cloud server deployment.
 *
 * arise-browser is the single entry process; no supervisord needed.
 */

import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../logger.js";
import { ProcessRunner } from "./process-runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Find the package root by walking up from __dirname to find package.json.
 * Works both in src/ (dev) and dist/ (compiled).
 */
function findPackageRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  // Fallback: assume 2 levels up from src/virtual-display or dist/src/virtual-display
  return resolve(__dirname, "../..");
}

export interface VirtualDisplayConfig {
  /** X11 display number (default ":99") */
  display: string;
  /** Screen resolution+depth (default "1920x1080x24") */
  screen: string;
  /** Neko HTTP/WS port (default 6090) */
  nekoPort: number;
  /** Neko user password (default "neko") */
  nekoPassword: string;
  /** Neko admin password (default "admin") */
  nekoAdminPassword: string;
  /** Chrome remote debugging port (default 9222) */
  chromeDebugPort: number;
  /** Path to Chrome binary (auto-detected if omitted) */
  chromePath: string;
}

const DEFAULT_CONFIG: VirtualDisplayConfig = {
  display: ":99",
  screen: "1920x1080x24",
  nekoPort: 6090,
  nekoPassword: "neko",
  nekoAdminPassword: "admin",
  chromeDebugPort: 9222,
  chromePath: "",
};

const CHROME_CANDIDATES = [
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
];

function findChrome(): string {
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Chrome not found. Tried: ${CHROME_CANDIDATES.join(", ")}. Install Chrome or set chromePath.`,
  );
}

/** Resolve path to deploy/neko/ config files */
function deployPath(filename: string): string {
  return resolve(findPackageRoot(), "deploy/neko", filename);
}

const log = createLogger("virtual-display");

export class VirtualDisplayManager {
  private _xvfb: ProcessRunner | null = null;
  private _pulseaudio: ProcessRunner | null = null;
  private _openbox: ProcessRunner | null = null;
  private _chrome: ProcessRunner | null = null;
  private _neko: ProcessRunner | null = null;
  private _started = false;
  private readonly _config: VirtualDisplayConfig;

  constructor(config?: Partial<VirtualDisplayConfig>) {
    this._config = { ...DEFAULT_CONFIG, ...config };
    if (!this._config.chromePath) {
      this._config.chromePath = findChrome();
    }
  }

  get config(): VirtualDisplayConfig {
    return { ...this._config };
  }

  isRunning(): boolean {
    return this._started;
  }

  async start(): Promise<void> {
    if (this._started) return;

    const { display, screen, nekoPort, nekoPassword, nekoAdminPassword, chromeDebugPort, chromePath } = this._config;
    // Extract display number: ":99" → "99", ":99.0" → "99"
    const displayNum = display.replace(/^:/, "").split(".")[0];
    const displayEnv = { DISPLAY: display };

    log.info(
      `Starting virtual display environment (display=${display}, chrome=${chromePath}, neko=:${nekoPort})`,
    );

    try {
      // 1. Xvfb — does NOT support -config (that's Xorg, not Xvfb)
      // Xvfb has a built-in dummy driver, no xorg.conf needed
      const xvfbArgs = [display, "-screen", "0", screen, "-nolisten", "tcp"];

      this._xvfb = new ProcessRunner({
        name: "xvfb",
        command: "/usr/bin/Xvfb",
        args: xvfbArgs,
        readiness: {
          type: "file",
          target: `/tmp/.X11-unix/X${displayNum}`,
          timeoutMs: 10_000,
        },
      });
      await this._xvfb.start();

      // 2. PulseAudio
      const pulseConf = deployPath("pulseaudio.pa");
      this._pulseaudio = new ProcessRunner({
        name: "pulseaudio",
        command: "/usr/bin/pulseaudio",
        args: [
          "--disallow-exit",
          "--disallow-module-loading",
          "-n",
          "-F",
          pulseConf,
          "--exit-idle-time=-1",
        ],
        readiness: {
          type: "file",
          target: "/tmp/pulseaudio.socket",
          timeoutMs: 10_000,
        },
      });
      await this._pulseaudio.start();

      // 3. Openbox
      const openboxConf = deployPath("openbox.xml");
      this._openbox = new ProcessRunner({
        name: "openbox",
        command: "/usr/bin/openbox",
        args: existsSync(openboxConf)
          ? ["--config-file", openboxConf]
          : [],
        env: displayEnv,
      });
      await this._openbox.start();

      // Small delay for window manager to initialize
      await new Promise((r) => setTimeout(r, 500));

      // 4. Chrome
      this._chrome = new ProcessRunner({
        name: "chrome",
        command: chromePath,
        args: [
          `--remote-debugging-port=${chromeDebugPort}`,
          `--display=${display}`,
          "--window-position=0,0",
          "--no-first-run",
          "--start-maximized",
          "--bwsi",
          "--force-dark-mode",
          "--disable-file-system",
          "--disable-gpu",
          "--disable-software-rasterizer",
          "--disable-dev-shm-usage",
          "--no-sandbox",
          "--disable-setuid-sandbox",
        ],
        env: {
          ...displayEnv,
          PULSE_SERVER: "unix:/tmp/pulseaudio.socket",
        },
        readiness: {
          type: "http",
          target: `http://localhost:${chromeDebugPort}/json/version`,
          timeoutMs: 15_000,
        },
      });
      await this._chrome.start();

      // 5. Neko Server
      this._neko = new ProcessRunner({
        name: "neko",
        command: "/usr/local/bin/neko",
        args: ["serve", "--bind", `0.0.0.0:${nekoPort}`],
        env: {
          ...displayEnv,
          PULSE_SERVER: "unix:/tmp/pulseaudio.socket",
          // Convert Xvfb format "1920x1080x24" → Neko format "1920x1080@30"
          NEKO_DESKTOP_SCREEN: screen.replace(/x\d+$/, "@30"),
          NEKO_MEMBER_PROVIDER: "multiuser",
          NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD: nekoAdminPassword,
          NEKO_MEMBER_MULTIUSER_USER_PASSWORD: nekoPassword,
          NEKO_SESSION_IMPLICIT_HOSTING: "true",
          NEKO_SESSION_MERCIFUL_RECONNECT: "true",
        },
        readiness: {
          type: "http",
          target: `http://localhost:${nekoPort}/health`,
          timeoutMs: 15_000,
          intervalMs: 500,
        },
      });
      await this._neko.start();

      this._started = true;
      log.info("Virtual display environment started successfully");
    } catch (err) {
      // Clean up any processes that started before the failure
      log.error({ err }, "Failed to start virtual display environment, cleaning up");
      this._started = true; // Allow stop() to run
      await this.stop();
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (!this._started) return;

    log.info("Stopping virtual display environment...");

    // Stop in reverse order
    const processes = [
      this._neko,
      this._chrome,
      this._openbox,
      this._pulseaudio,
      this._xvfb,
    ];

    for (const proc of processes) {
      if (proc) {
        try {
          await proc.stop();
        } catch (err) {
          log.error({ err }, "Error stopping process");
        }
      }
    }

    this._neko = null;
    this._chrome = null;
    this._openbox = null;
    this._pulseaudio = null;
    this._xvfb = null;
    this._started = false;

    log.info("Virtual display environment stopped");
  }
}
