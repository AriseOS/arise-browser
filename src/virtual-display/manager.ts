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
  /**
   * Fingerprint seed. When set, the container runs fingerprint-chromium
   * (deploy/neko-fp) instead of Google Chrome; the same seed always yields
   * the same fingerprint, a different seed a different device.
   */
  fingerprintSeed?: number;
  /** IANA timezone reported by the fingerprint browser (default "UTC") */
  fingerprintTimezone?: string;
  /** Primary language of the fingerprint browser (default "en-US") */
  fingerprintLang?: string;
}

/** Image and container name used by default in fingerprint mode */
export const FINGERPRINT_NAME = "arise-neko-fp";

const MAX_FINGERPRINT_SEED = 2_147_483_647;

/**
 * Parse a fingerprint seed from CLI/env input.
 * Returns undefined for empty input; throws on anything that is not an
 * integer in 1..2147483647.
 */
export function parseFingerprintSeed(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = raw.trim();
  if (!/^[1-9][0-9]*$/.test(value) || Number(value) > MAX_FINGERPRINT_SEED) {
    throw new Error(
      `invalid fingerprint seed "${raw}": expected an integer between 1 and ${MAX_FINGERPRINT_SEED}`,
    );
  }
  return Number(value);
}

function validateFingerprintOptions(config: VirtualDisplayConfig): void {
  const { fingerprintSeed, fingerprintTimezone, fingerprintLang } = config;
  if (fingerprintSeed === undefined) {
    if (fingerprintTimezone !== undefined || fingerprintLang !== undefined) {
      throw new Error("fingerprint timezone/lang require a fingerprint seed");
    }
    return;
  }
  if (
    !Number.isInteger(fingerprintSeed)
    || fingerprintSeed < 1
    || fingerprintSeed > MAX_FINGERPRINT_SEED
  ) {
    throw new Error(`invalid fingerprint seed: ${fingerprintSeed}`);
  }
  if (fingerprintTimezone !== undefined && !/^[A-Za-z0-9_+\-/]+$/.test(fingerprintTimezone)) {
    throw new Error(`invalid fingerprint timezone: ${fingerprintTimezone}`);
  }
  if (fingerprintLang !== undefined && !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(fingerprintLang)) {
    throw new Error(`invalid fingerprint language: ${fingerprintLang}`);
  }
}

/** Docker build context (relative to the package root) for this config */
export function imageBuildDir(config: VirtualDisplayConfig): string {
  return config.fingerprintSeed === undefined ? "deploy/neko" : "deploy/neko-fp";
}

/** Arguments for `docker run` that start the virtual display container */
export function buildDockerRunArgs(config: VirtualDisplayConfig): string[] {
  validateFingerprintOptions(config);
  const {
    nekoPort,
    nekoPassword,
    nekoAdminPassword,
    chromeDebugPort,
    screen,
    containerName,
    imageName,
    fingerprintSeed,
    fingerprintTimezone,
    fingerprintLang,
  } = config;

  const fingerprintEnv = fingerprintSeed === undefined
    ? []
    : [
      "-e",
      `ARISE_FP_SEED=${fingerprintSeed}`,
      ...(fingerprintTimezone ? ["-e", `ARISE_FP_TIMEZONE=${fingerprintTimezone}`] : []),
      ...(fingerprintLang ? ["-e", `ARISE_FP_LANG=${fingerprintLang}`] : []),
    ];

  return [
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
    ...fingerprintEnv,
    imageName,
  ];
}

/** Image builds pull the Neko base image (and fingerprint-chromium); allow time */
const IMAGE_BUILD_TIMEOUT_MS = 15 * 60_000;

const DEFAULT_CONFIG: VirtualDisplayConfig = {
  nekoPort: 6090,
  nekoPassword: "neko",
  nekoAdminPassword: "admin",
  chromeDebugPort: 9222,
  screen: "1920x1080@30",
  containerName: "arise-neko",
  imageName: "arise-neko",
};

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

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
    const fingerprint = config?.fingerprintSeed !== undefined;
    this._config = {
      ...DEFAULT_CONFIG,
      // Fingerprint mode gets its own image and container (and therefore its
      // own profile volume): fingerprint-chromium is older than the Google
      // Chrome in the base image and cannot open a profile Chrome wrote.
      ...(fingerprint && { containerName: FINGERPRINT_NAME, imageName: FINGERPRINT_NAME }),
      ...stripUndefined(config ?? {}),
    };
    validateFingerprintOptions(this._config);
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
      chromeDebugPort,
      containerName,
      imageName,
    } = this._config;

    log.info(
      `Starting Docker container "${containerName}" (neko=:${nekoPort}, cdp=:${chromeDebugPort}, fingerprint=${this._config.fingerprintSeed === undefined ? "off" : "on"})`,
    );

    // Ensure no stale container exists
    try {
      await exec("docker", ["rm", "-f", containerName]);
    } catch {
      // container didn't exist, fine
    }

    // Build image if not present
    const deployDir = resolve(findPackageRoot(), imageBuildDir(this._config));
    try {
      await exec("docker", ["image", "inspect", imageName]);
      log.info(`Docker image "${imageName}" found`);
    } catch {
      log.info(`Building Docker image "${imageName}" from ${deployDir}...`);
      await exec("docker", ["build", "-t", imageName, deployDir], IMAGE_BUILD_TIMEOUT_MS);
      log.info(`Docker image "${imageName}" built`);
    }

    const runArgs = buildDockerRunArgs(this._config);

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
