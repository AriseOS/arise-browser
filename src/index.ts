/**
 * AmiPilot — AI browser automation engine.
 *
 * Public API surface.
 */

export { BrowserSession } from "./browser/browser-session.js";
export { ActionExecutor } from "./browser/action-executor.js";
export { PageSnapshot } from "./browser/page-snapshot.js";
export { BehaviorRecorder } from "./browser/behavior-recorder.js";
export { BrowserConfig, getUserAgent, getStealthHeaders } from "./browser/config.js";
export { setLogger, createLogger, type Logger } from "./logger.js";
export { acquireLock, releaseLock, getLock } from "./lock.js";
export { createServer } from "./server/server.js";
export * from "./types/index.js";
