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

export function getUserAgent(): string {
  const platform = process.platform;
  if (platform === "darwin") {
    return "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  } else if (platform === "win32") {
    return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  }
  return "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
}

export function getStealthContextOptions(): Pick<BrowserContextOptions, "locale"> {
  return {
    locale: "en-US",
  };
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
