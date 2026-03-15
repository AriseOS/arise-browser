/**
 * Child process runner with auto-restart, readiness detection,
 * log integration, and graceful shutdown.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createLogger, type Logger } from "../logger.js";

export interface ReadinessCheck {
  /** Wait for a file/socket to appear */
  type: "file" | "http";
  /** File path or HTTP URL */
  target: string;
  /** Max wait time in ms (default 10000) */
  timeoutMs?: number;
  /** Poll interval in ms (default 200) */
  intervalMs?: number;
}

export interface ProcessRunnerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  readiness?: ReadinessCheck;
  maxRestarts?: number;
  backoffMs?: number;
  shutdownTimeoutMs?: number;
}

export class ProcessRunner {
  private _process: ChildProcess | null = null;
  private _running = false;
  private _restartCount = 0;
  private _intentionalStop = false;
  private _restartScheduled = false;
  private readonly _log: Logger;
  private readonly _config: ProcessRunnerConfig;

  constructor(config: ProcessRunnerConfig) {
    this._config = config;
    this._log = createLogger(`proc:${config.name}`);
  }

  get running(): boolean {
    return this._running;
  }

  get pid(): number | undefined {
    return this._process?.pid;
  }

  async start(): Promise<void> {
    if (this._running) return;

    this._intentionalStop = false;
    this._restartCount = 0;
    this._restartScheduled = false;
    await this._spawn();
  }

  async stop(): Promise<void> {
    this._intentionalStop = true;
    this._running = false;

    if (!this._process) return;

    const proc = this._process;
    this._process = null;

    await this._killProcess(proc);
  }

  private async _spawn(): Promise<void> {
    const { command, args = [], env, name } = this._config;

    const mergedEnv = { ...process.env, ...env };

    this._log.info(`Starting ${name}: ${command} ${args.join(" ")}`);

    const proc = spawn(command, args, {
      env: mergedEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    this._process = proc;
    this._running = true;

    proc.stdout?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        this._log.debug(line);
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        this._log.warn(line);
      }
    });

    proc.on("exit", (code, signal) => {
      this._running = false;

      if (this._intentionalStop) {
        this._log.info(`${name} stopped`);
        return;
      }

      this._log.warn(`${name} exited (code=${code}, signal=${signal})`);
      this._maybeRestart();
    });

    proc.on("error", (err) => {
      this._running = false;
      this._log.error({ err }, `${name} spawn error`);
      if (!this._intentionalStop) {
        this._maybeRestart();
      }
    });

    if (this._config.readiness) {
      await this._waitReady(this._config.readiness);
    }
  }

  private _maybeRestart(): void {
    // Guard against double restart from both 'error' and 'exit' events
    if (this._restartScheduled) return;
    this._restartScheduled = true;

    const maxRestarts = this._config.maxRestarts ?? 5;
    const backoffMs = this._config.backoffMs ?? 2000;

    if (this._restartCount >= maxRestarts) {
      this._log.error(
        `${this._config.name} exceeded max restarts (${maxRestarts})`,
      );
      return;
    }

    this._restartCount++;
    const delay = backoffMs * this._restartCount;
    this._log.info(
      `Restarting ${this._config.name} in ${delay}ms (attempt ${this._restartCount})`,
    );

    setTimeout(() => {
      this._restartScheduled = false;
      if (!this._intentionalStop) {
        this._spawn().catch((err) => {
          this._log.error({ err }, `Failed to restart ${this._config.name}`);
        });
      }
    }, delay);
  }

  private async _waitReady(check: ReadinessCheck): Promise<void> {
    const timeoutMs = check.timeoutMs ?? 10_000;
    const intervalMs = check.intervalMs ?? 200;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      // Abort if process died while waiting for readiness
      if (!this._running || !this._process || this._process.exitCode !== null) {
        throw new Error(
          `${this._config.name} exited before becoming ready`,
        );
      }

      if (check.type === "file" && existsSync(check.target)) {
        this._log.info(`${this._config.name} ready (${check.target} exists)`);
        return;
      }

      if (check.type === "http") {
        try {
          const res = await fetch(check.target, {
            signal: AbortSignal.timeout(2000),
          });
          if (res.ok) {
            this._log.info(
              `${this._config.name} ready (${check.target} responded)`,
            );
            return;
          }
        } catch {
          // not ready yet
        }
      }

      await new Promise((r) => setTimeout(r, intervalMs));
    }

    throw new Error(
      `${this._config.name} readiness timeout after ${timeoutMs}ms (${check.type}: ${check.target})`,
    );
  }

  private async _killProcess(proc: ChildProcess): Promise<void> {
    // Process already dead (exitCode set means it has exited)
    if (proc.exitCode !== null || proc.killed) {
      this._log.info(`${this._config.name} already exited`);
      return;
    }

    const timeoutMs = this._config.shutdownTimeoutMs ?? 3000;

    return new Promise<void>((resolve) => {
      const onExit = () => {
        clearTimeout(timer);
        resolve();
      };

      proc.once("exit", onExit);

      try {
        proc.kill("SIGTERM");
        this._log.info(`Sent SIGTERM to ${this._config.name} (pid=${proc.pid})`);
      } catch {
        // Process may have exited between our check and kill()
        proc.removeListener("exit", onExit);
        resolve();
        return;
      }

      const timer = setTimeout(() => {
        this._log.warn(
          `${this._config.name} did not exit in ${timeoutMs}ms, sending SIGKILL`,
        );
        proc.removeListener("exit", onExit);
        try {
          proc.kill("SIGKILL");
        } catch {
          // already dead
        }
        resolve();
      }, timeoutMs);
    });
  }
}
