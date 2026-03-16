/**
 * VirtualDisplayManager — manages a Docker container running Neko
 * (Xvfb + PulseAudio + Openbox + Chrome + Neko WebRTC) for cloud server deployment.
 *
 * arise-browser controls the container via `docker` CLI and connects to Chrome via CDP.
 */

import { execFile } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createLogger } from "../logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const log = createLogger("virtual-display");

/**
 * Find the package root by walking up from __dirname to find package.json.
 */
function findPackageRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  return resolve(__dirname, "../..");
}

export interface VirtualDisplayConfig {
  /** Neko HTTP/WS port on host (default 6090) */
  nekoPort: number;
  /** Neko user password (default "neko") */
  nekoPassword: string;
  /** Neko admin password (default "admin") */
  nekoAdminPassword: string;
  /** Chrome CDP port on host (default 9222) */
  chromeDebugPort: number;
  /** Screen resolution (default "1920x1080@30") */
  screen: string;
  /** Docker container name (default "arise-neko") */
  containerName: string;
  /** Docker image name (default "arise-neko") */
  imageName: string;
}

const DEFAULT_CONFIG: VirtualDisplayConfig = {
  nekoPort: 6090,
  nekoPassword: "neko",
  nekoAdminPassword: "admin",
  chromeDebugPort: 9222,
  screen: "1920x1080@30",
  containerName: "arise-neko",
  imageName: "arise-neko",
};

/** Run a command and return stdout. Rejects on non-zero exit. */
function exec(
  cmd: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.trim() || stdout?.trim() || err.message;
        reject(new Error(`${cmd} ${args[0]}: ${msg}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

/** Poll a URL until it returns 2xx or timeout. */
async function waitForHttp(
  url: string,
  timeoutMs: number,
  intervalMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for ${url} (${timeoutMs}ms)`);
}

export class VirtualDisplayManager {
  private _started = false;
  private readonly _config: VirtualDisplayConfig;

  constructor(config?: Partial<VirtualDisplayConfig>) {
    this._config = { ...DEFAULT_CONFIG, ...config };
  }

  get config(): VirtualDisplayConfig {
    return { ...this._config };
  }

  isRunning(): boolean {
    return this._started;
  }

  async start(): Promise<void> {
    if (this._started) return;

    const {
      nekoPort,
      nekoPassword,
      nekoAdminPassword,
      chromeDebugPort,
      screen,
      containerName,
      imageName,
    } = this._config;

    log.info(
      `Starting Docker container "${containerName}" (neko=:${nekoPort}, cdp=:${chromeDebugPort})`,
    );

    // Ensure no stale container exists
    try {
      await exec("docker", ["rm", "-f", containerName]);
    } catch {
      // container didn't exist, fine
    }

    // Build image if not present
    const deployDir = resolve(findPackageRoot(), "deploy/neko");
    try {
      await exec("docker", ["image", "inspect", imageName]);
      log.info(`Docker image "${imageName}" found`);
    } catch {
      log.info(`Building Docker image "${imageName}" from ${deployDir}...`);
      await exec("docker", ["build", "-t", imageName, deployDir], 120_000);
      log.info(`Docker image "${imageName}" built`);
    }

    // docker run
    const runArgs = [
      "run",
      "-d",
      "--name",
      containerName,
      "--shm-size=2gb",
      // Port mappings
      "-p",
      `${nekoPort}:8080`,
      "-p",
      `127.0.0.1:${chromeDebugPort}:9223`,
      "-p",
      "52000-52100:52000-52100/udp",
      // Persistent Chrome profile via named volume
      "-v",
      `${containerName}-profile:/home/neko/.config/arise-chrome`,
      // Neko environment
      "-e",
      `NEKO_DESKTOP_SCREEN=${screen}`,
      "-e",
      `NEKO_MEMBER_MULTIUSER_USER_PASSWORD=${nekoPassword}`,
      "-e",
      `NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=${nekoAdminPassword}`,
      "-e",
      "NEKO_WEBRTC_EPR=52000-52100",
      "-e",
      "NEKO_WEBRTC_ICELITE=1",
      "-e",
      "NEKO_SESSION_IMPLICIT_HOSTING=true",
      imageName,
    ];

    try {
      const containerId = await exec("docker", runArgs, 30_000);
      log.info(`Container started: ${containerId.slice(0, 12)}`);

      // Wait for Neko health
      log.info("Waiting for Neko health...");
      await waitForHttp(`http://localhost:${nekoPort}/health`, 30_000);
      log.info("Neko is healthy");

      // Wait for Chrome CDP
      log.info("Waiting for Chrome CDP...");
      await waitForHttp(
        `http://localhost:${chromeDebugPort}/json/version`,
        30_000,
      );
      log.info("Chrome CDP is ready");

      this._started = true;
      log.info("Virtual display environment started successfully");
    } catch (err) {
      log.error({ err }, "Failed to start virtual display, cleaning up");
      try {
        await exec("docker", ["rm", "-f", containerName]);
      } catch {
        // best effort
      }
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (!this._started) return;

    const { containerName } = this._config;
    log.info(`Stopping container "${containerName}"...`);

    try {
      await exec("docker", ["stop", "-t", "10", containerName], 20_000);
    } catch (err) {
      log.error({ err }, "Error stopping container");
    }

    try {
      await exec("docker", ["rm", "-f", containerName]);
    } catch (err) {
      log.error({ err }, "Error removing container");
    }

    this._started = false;
    log.info("Virtual display environment stopped");
  }
}
