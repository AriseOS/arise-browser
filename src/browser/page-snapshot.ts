/**
 * PageSnapshot — Captures YAML-like page snapshots using unified_analyzer.js.
 *
 * Key concepts:
 * - Evaluates unified_analyzer.js in page context
 * - Returns YAML-like accessibility tree with [ref=eN] element references
 * - Diff support for incremental updates
 * - Retry for navigation-destroyed contexts
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";
import { BrowserConfig } from "./config.js";
import { createLogger } from "../logger.js";
import type { SnapshotResult } from "../types/index.js";

const logger = createLogger("page-snapshot");

// ===== JS cache (module-level singleton) =====

let _snapshotJsCache: string | null = null;

function getSnapshotJs(): string {
  if (_snapshotJsCache !== null) return _snapshotJsCache;

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);

  const candidates = [
    // Development: src/browser/ -> src/browser/scripts/
    resolve(__dirname, "scripts/unified_analyzer.js"),
    // Compiled: dist/src/browser/ -> project root/src/browser/scripts/
    resolve(__dirname, "../../../src/browser/scripts/unified_analyzer.js"),
  ];

  for (const candidate of candidates) {
    try {
      _snapshotJsCache = readFileSync(candidate, "utf-8");
      logger.info({ path: candidate }, "Loaded unified_analyzer.js");
      return _snapshotJsCache;
    } catch {
      // try next
    }
  }

  throw new Error(
    `Could not find unified_analyzer.js. Tried: ${candidates.join(", ")}`,
  );
}

// ===== PageSnapshot class =====

export class PageSnapshot {
  private page: Page;
  private snapshotData: string | null = null;
  private _lastUrl: string | null = null;
  lastInfo: { isDiff: boolean; priorities: number[] } = {
    isDiff: false,
    priorities: [1, 2, 3],
  };

  constructor(page: Page) {
    this.page = page;
  }

  async capture(options?: {
    forceRefresh?: boolean;
    diffOnly?: boolean;
    viewportLimit?: boolean;
  }): Promise<string> {
    const diffOnly = options?.diffOnly ?? false;
    const viewportLimit = options?.viewportLimit ?? false;

    try {
      const currentUrl = this.page.url();

      await this.page.waitForLoadState("domcontentloaded", {
        timeout: BrowserConfig.domLoadedTimeout,
      });

      logger.debug("Capturing page snapshot...");
      const snapshotResult = await this._getSnapshotDirect(viewportLimit);

      let snapshotText: string;
      if (
        snapshotResult &&
        typeof snapshotResult === "object" &&
        "snapshotText" in snapshotResult
      ) {
        const result = snapshotResult as SnapshotResult;
        snapshotText = result.snapshotText;

        const metadata = result.metadata;
        if (metadata?.refDebug) {
          const rd = metadata.refDebug;
          logger.debug(
            {
              weakmapHit: rd.weakmapHit,
              ariaRefHit: rd.ariaRefHit,
              signatureHit: rd.signatureHit,
              newRef: rd.newRef,
              evicted: rd.evicted,
              refCounter: metadata.refCounterValue,
              totalMapped: metadata.totalMappedRefs,
            },
            "Ref assignment stats",
          );
        }
      } else {
        snapshotText = snapshotResult as string;
      }

      const formatted = PageSnapshot._formatSnapshot(snapshotText || "<empty>");

      let output = formatted;
      if (diffOnly && this.snapshotData) {
        output = PageSnapshot._computeDiff(this.snapshotData, formatted);
      }

      this._lastUrl = currentUrl;
      this.snapshotData = formatted;

      const prioritiesIncluded = PageSnapshot._detectPriorities(
        diffOnly ? this.snapshotData || formatted : formatted,
      );
      this.lastInfo = {
        isDiff: diffOnly && this.snapshotData !== null,
        priorities: prioritiesIncluded,
      };

      logger.debug(
        { diffOnly, priorities: this.lastInfo.priorities },
        "Snapshot captured",
      );
      return output;
    } catch (exc) {
      logger.error({ err: exc }, "Snapshot capture failed");
      return `Error: Could not capture page snapshot ${exc}`;
    }
  }

  async getFullResult(options?: {
    viewportLimit?: boolean;
  }): Promise<Record<string, unknown>> {
    try {
      await this.page.waitForLoadState("domcontentloaded", {
        timeout: BrowserConfig.domLoadedTimeout,
      });

      const result = await this._getSnapshotDirect(options?.viewportLimit ?? false);
      if (result && typeof result === "object" && "snapshotText" in result) {
        return result as unknown as Record<string, unknown>;
      }
      return { snapshotText: result, elements: {} };
    } catch (exc) {
      logger.error({ err: exc }, "Full snapshot capture failed");
      return { snapshotText: `Error: ${exc}`, elements: {} };
    }
  }

  private async _getSnapshotDirect(
    viewportLimit: boolean,
  ): Promise<string | SnapshotResult | null> {
    const jsCode = getSnapshotJs();
    let retries = 3;

    while (retries > 0) {
      try {
        return await this.page.evaluate(jsCode, viewportLimit);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        const navErr = "Execution context was destroyed";

        if (
          msg.includes(navErr) ||
          msg.includes("Most likely because of a navigation")
        ) {
          retries--;
          logger.debug(
            { retriesLeft: retries },
            "Snapshot evaluate failed due to navigation; retrying",
          );

          try {
            await this.page.waitForLoadState("domcontentloaded", {
              timeout: BrowserConfig.domLoadedTimeout,
            });
          } catch {
            // Even if waiting fails, attempt retry
          }
          continue;
        }

        logger.warn({ err: e }, "Failed to execute snapshot JavaScript");
        return null;
      }
    }

    logger.warn("Failed to execute snapshot JavaScript after retries");
    return null;
  }

  private static _formatSnapshot(text: string): string {
    return ["- Page Snapshot", "```yaml", text, "```"].join("\n");
  }

  private static _computeDiff(old: string, newStr: string): string {
    if (!old || !newStr) {
      return "- Page Snapshot (error: missing data for diff)";
    }

    const oldLines = old.split("\n");
    const newLines = newStr.split("\n");

    const diffLines: string[] = [];
    const maxLen = Math.max(oldLines.length, newLines.length);

    for (let i = 0; i < maxLen; i++) {
      const oldLine = i < oldLines.length ? oldLines[i] : undefined;
      const newLine = i < newLines.length ? newLines[i] : undefined;

      if (oldLine === newLine) {
        continue;
      }
      if (oldLine !== undefined && newLine === undefined) {
        diffLines.push(`- ${oldLine}`);
      } else if (oldLine === undefined && newLine !== undefined) {
        diffLines.push(`+ ${newLine}`);
      } else if (oldLine !== newLine) {
        diffLines.push(`- ${oldLine}`);
        diffLines.push(`+ ${newLine}`);
      }
    }

    if (diffLines.length === 0) {
      return "- Page Snapshot (no structural changes)";
    }

    return ["- Page Snapshot (diff)", "```diff", ...diffLines, "```"].join("\n");
  }

  private static _detectPriorities(snapshotYaml: string): number[] {
    const priorities = new Set<number>();

    for (const line of snapshotYaml.split("\n")) {
      if (!line.includes("[ref=")) continue;
      const lowerLine = line.toLowerCase();

      if (
        ["input", "button", "select", "textarea", "checkbox", "radio", "link"].some(
          (r) => lowerLine.includes(r),
        )
      ) {
        priorities.add(1);
      } else if (lowerLine.includes("label")) {
        priorities.add(2);
      } else {
        priorities.add(3);
      }
    }

    if (priorities.size === 0) {
      priorities.add(3);
    }

    return [...priorities].sort();
  }
}
