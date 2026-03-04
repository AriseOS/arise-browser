/**
 * Injectable logger — pino default, replaceable via setLogger().
 */

import { pino, type Logger as PinoLogger } from "pino";

export interface Logger {
  info(msg: string): void;
  info(obj: object, msg?: string): void;
  warn(msg: string): void;
  warn(obj: object, msg?: string): void;
  error(msg: string): void;
  error(obj: object, msg?: string): void;
  debug(msg: string): void;
  debug(obj: object, msg?: string): void;
  child(bindings: object): Logger;
}

let _rootLogger: Logger | null = null;

export function setLogger(logger: Logger): void {
  _rootLogger = logger;
}

function getOrCreateRoot(): Logger {
  if (_rootLogger) return _rootLogger;

  const isDebug = !!(process.env.AMIPILOT_DEBUG || process.env.LOG_LEVEL === "debug");
  const isProd = process.env.NODE_ENV === "production";

  const opts: Record<string, unknown> = {
    level: isDebug ? "debug" : (process.env.LOG_LEVEL ?? "info"),
  };

  if (!isProd) {
    opts.transport = {
      target: "pino-pretty",
      options: { colorize: true },
    };
  }

  _rootLogger = pino(opts) as unknown as Logger;

  return _rootLogger;
}

export function createLogger(module: string): Logger {
  return getOrCreateRoot().child({ module });
}
