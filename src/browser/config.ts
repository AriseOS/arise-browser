/**
 * Browser configuration — timeouts, stealth, viewport defaults.
 */

import type { BrowserContextOptions } from "playwright";

export const BrowserConfig = {
  // Timeouts (ms)
  actionTimeout: 3_000,
  shortTimeout: 5_000,
  navigationTimeout: 10_000,
  networkIdleTimeout: 5_000,
  screenshotTimeout: 15_000,
  stabilityTimeout: 1_500,
  domLoadedTimeout: 5_000,

  // Action limits
  maxScrollAmount: 5_000,
  logLimit: 1_000,

  // Viewport
  viewportWidth: 1920,
  viewportHeight: 1080,

  // Retry
  maxRetries: 3,
  retryDelay: 500,
} as const;

/**
 * Returns null to let Chrome use its real User-Agent.
 * Overriding UA causes mismatch with sec-ch-ua (which Chrome generates
 * from its actual version), and WAFs like Akamai detect the inconsistency.
 */
export function getUserAgent(): string | null {
  return null;
}

export function getStealthContextOptions(): Pick<BrowserContextOptions, "locale"> {
  // Return empty — let the browser use the system's real locale.
  // Hardcoding "en-US" while running in Asia/Shanghai timezone causes
  // locale-timezone mismatch that fingerprinting services flag.
  return {};
}

/**
 * @deprecated Do not apply these values as context-level extra HTTP headers.
 * Navigation-only headers like Sec-Fetch-* and Upgrade-Insecure-Requests break
 * XHR/fetch CORS preflights on apps like Resy. Prefer getStealthContextOptions().
 */
export function getStealthHeaders(): Record<string, string> {
  return {
    "Accept-Language": "en-US,en;q=0.9",
  };
}
