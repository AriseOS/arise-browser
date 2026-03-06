/**
 * BehaviorRecorder — Records user behavior using ref-based element identification.
 *
 * Key concepts:
 * - CDP session per tab for JS -> Node binding
 * - Injects behavior_tracker.js via Page.addScriptToEvaluateOnNewDocument
 * - Handles Runtime.bindingCalled for click/type/scroll/navigate events
 * - Network response monitoring for dataload detection
 * - Navigation deduplication (2s window)
 * - Auto-hooks new tab creation
 */

import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page, Response as PwResponse, CDPSession } from "playwright";
import { createLogger } from "../logger.js";
import type { RecordedOperation, RecordingResult, SnapshotRecord } from "../types/index.js";

const MAX_OPERATIONS = 10_000;

const logger = createLogger("behavior-recorder");

// ===== Tracker script cache =====

let _trackerJsCache: string | null = null;

function getTrackerScript(): string {
  if (_trackerJsCache !== null) return _trackerJsCache;

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);

  const candidates = [
    // Development: src/browser/ -> src/browser/scripts/
    resolve(__dirname, "scripts/behavior_tracker.js"),
    // Compiled: dist/src/browser/ -> project root/src/browser/scripts/
    resolve(__dirname, "../../../src/browser/scripts/behavior_tracker.js"),
  ];

  for (const candidate of candidates) {
    try {
      _trackerJsCache = readFileSync(candidate, "utf-8");
      logger.info({ path: candidate }, "Loaded behavior_tracker.js");
      return _trackerJsCache;
    } catch {
      // try next
    }
  }

  // Minimal fallback
  logger.warn("Using minimal fallback tracker script");
  _trackerJsCache = `
(function() {
  if (window._behaviorTrackerInitialized) return;
  window._behaviorTrackerInitialized = true;
  console.log("Behavior Tracker (fallback) initialized");
  function report(type, data) {
    if (window.reportUserBehavior) {
      const payload = { type, timestamp: new Date().toISOString(), url: location.href, ...data };
      window.reportUserBehavior(JSON.stringify(payload));
    }
  }
  document.addEventListener('click', e => {
    const ref = e.target.getAttribute('aria-ref');
    if (ref) report('click', { ref, text: e.target.textContent?.slice(0, 100) });
  }, true);
})();
`;
  return _trackerJsCache;
}

/** Interface for accessing BrowserSession pages (avoids circular dependency). */
export interface BrowserSessionRef {
  readonly pages: ReadonlyMap<string, Page>;
  readonly snapshot: { getFullResult(): Promise<Record<string, unknown>> } | null;
  readonly currentTabId: string | null;
  onPageRegistered?(listener: (tabId: string, page: Page) => void | Promise<void>): () => void;
}

// ===== BehaviorRecorder class =====

export class BehaviorRecorder {
  readonly sessionId: string;
  private _isRecording = false;
  private _enableSnapshotCapture: boolean;

  operations: RecordedOperation[] = [];
  snapshots: Record<string, SnapshotRecord> = {};

  private _monitoredTabs = new Set<string>();
  private _tabPages = new Map<string, Page>();
  private _cdpSessions = new Map<string, CDPSession>();

  private _lastNavUrl: string | null = null;
  private _lastNavTime: number | null = null;
  private _navDedupMs = 2000;

  private _browserSession: BrowserSessionRef | null = null;

  private _operationCallback: ((op: RecordedOperation) => void) | null = null;

  private _recentDataloadUrls = new Set<string>();
  private _dataloadCleanupTimer: ReturnType<typeof setInterval> | null = null;
  private _lastScrollTime: number | null = null;
  private _dataloadWindowMs = 3000;

  private _responseListeners = new Map<string, (resp: PwResponse) => void>();
  private _unsubscribePageRegistered: (() => void) | null = null;

  constructor(enableSnapshotCapture = true) {
    this.sessionId = `recording_${randomUUID()}`;
    this._enableSnapshotCapture = enableSnapshotCapture;
  }

  setOperationCallback(callback: (op: RecordedOperation) => void): void {
    this._operationCallback = callback;
  }

  isRecording(): boolean {
    return this._isRecording;
  }

  getOperations(): RecordedOperation[] {
    return [...this.operations];
  }

  getOperationsCount(): number {
    return this.operations.length;
  }

  // ===== Start / Stop =====

  async startRecording(browserSession: BrowserSessionRef): Promise<void> {
    if (this._isRecording) {
      logger.warn("Recording already in progress");
      return;
    }

    this._browserSession = browserSession;
    this._isRecording = true;
    this.operations = [];
    this.snapshots = {};
    this._monitoredTabs.clear();
    this._tabPages.clear();
    this._unsubscribePageRegistered?.();
    this._unsubscribePageRegistered = null;

    logger.info({ sessionId: this.sessionId }, "Starting behavior recording");

    if (browserSession.onPageRegistered) {
      this._unsubscribePageRegistered = browserSession.onPageRegistered((tabId, page) =>
        this._setupForTab(tabId, page),
      );
    }

    await this._setupAllTabs();

    this._dataloadCleanupTimer = setInterval(() => {
      this._recentDataloadUrls.clear();
    }, 10_000);
  }

  async stopRecording(): Promise<RecordingResult> {
    if (!this._isRecording) {
      logger.warn("No recording in progress");
      return { session_id: this.sessionId, operations: [], operations_count: 0, snapshots: {} };
    }

    this._isRecording = false;
    logger.info({ operationCount: this.operations.length }, "Stopping recording");

    const result: RecordingResult = {
      session_id: this.sessionId,
      operations: [...this.operations],
      operations_count: this.operations.length,
      snapshots: { ...this.snapshots },
    };

    for (const [tabId, cdpSession] of this._cdpSessions) {
      try {
        await cdpSession.detach();
      } catch (e) {
        logger.debug({ tabId, err: e }, "Error detaching CDP session");
      }
    }

    for (const [tabId, page] of this._tabPages) {
      try {
        const listener = this._responseListeners.get(tabId);
        if (listener) {
          page.off("response", listener);
        }
      } catch {
        // page may be closed
      }
    }
    this._responseListeners.clear();

    this._monitoredTabs.clear();
    this._tabPages.clear();
    this._cdpSessions.clear();
    this._browserSession = null;
    this._recentDataloadUrls.clear();
    this._unsubscribePageRegistered?.();
    this._unsubscribePageRegistered = null;

    if (this._dataloadCleanupTimer) {
      clearInterval(this._dataloadCleanupTimer);
      this._dataloadCleanupTimer = null;
    }

    return result;
  }

  // ===== Tab Setup =====

  private async _setupAllTabs(): Promise<void> {
    if (!this._browserSession) return;

    for (const [tabId, page] of this._browserSession.pages) {
      if (!this._monitoredTabs.has(tabId)) {
        await this._setupForTab(tabId, page);
      }
    }
  }

  private async _setupForTab(tabId: string, page: Page): Promise<void> {
    if (this._monitoredTabs.has(tabId)) return;

    for (const existingPage of this._tabPages.values()) {
      if (existingPage === page) return;
    }

    if (page.isClosed()) {
      logger.debug({ tabId }, "Tab is closed, skipping");
      return;
    }

    let cdpSession: CDPSession | null = null;
    try {
      logger.debug({ tabId }, "Setting up recording for tab");

      cdpSession = await page.context().newCDPSession(page);

      await cdpSession.send("Runtime.enable");
      await cdpSession.send("Page.enable");

      await cdpSession.send("Runtime.addBinding", { name: "reportUserBehavior" });

      cdpSession.on("Runtime.bindingCalled", (event: any) => {
        this._handleBindingEvent(event, tabId);
      });

      cdpSession.on("Page.frameNavigated", (event: any) => {
        this._handleNavigation(event, tabId);
      });

      const script = getTrackerScript();
      await cdpSession.send("Page.addScriptToEvaluateOnNewDocument", {
        source: script,
        runImmediately: true,
      });

      try {
        await page.evaluate(script);
      } catch (e) {
        logger.debug({ err: e }, "Could not inject script immediately");
      }

      const responseListener = (response: PwResponse) => {
        this._handleResponse(response, tabId);
      };
      page.on("response", responseListener);
      this._responseListeners.set(tabId, responseListener);

      this._monitoredTabs.add(tabId);
      this._tabPages.set(tabId, page);
      this._cdpSessions.set(tabId, cdpSession);

      this._recordInitialNavigation(tabId, page);

      logger.info({ tabId }, "Recording setup complete for tab");
    } catch (e) {
      // Clean up CDP session on partial failure to prevent leak
      if (cdpSession) {
        try { await cdpSession.detach(); } catch { /* best effort */ }
      }
      logger.error({ tabId, err: e }, "Failed to setup recording for tab");
    }
  }

  private _recordInitialNavigation(tabId: string, page: Page): void {
    try {
      const url = page.url();
      if (!url || url === "about:blank" || url.startsWith("chrome://")) return;

      this._handleNavigation({ frame: { url } }, tabId);
    } catch {
      // ignore
    }
  }

  // ===== Event Handling =====

  private _handleBindingEvent(event: any, tabId: string): void {
    if (event.name !== "reportUserBehavior") return;
    const payload = event.payload as string;
    this._processOperation(payload, tabId).catch((e) => {
      logger.debug({ err: e }, "Error processing binding event");
    });
  }

  private async _processOperation(payload: string, tabId: string): Promise<void> {
    try {
      const data = JSON.parse(payload) as RecordedOperation;

      if (!data.type) {
        logger.warn("Invalid operation: missing type");
        return;
      }

      if (data.type === "navigate") {
        const navUrl = data.url || "";
        const now = Date.now();

        if (this._lastNavUrl && this._lastNavTime) {
          const timeDiff = now - this._lastNavTime;
          if (navUrl === this._lastNavUrl && timeDiff < this._navDedupMs) {
            logger.debug({ url: navUrl }, "Duplicate navigate filtered");
            return;
          }
        }

        this._lastNavUrl = navUrl;
        this._lastNavTime = now;
      }

      if (data.type === "scroll") {
        this._lastScrollTime = Date.now();
      }

      data.tab_id = tabId;

      if (this.operations.length >= MAX_OPERATIONS) {
        logger.warn({ max: MAX_OPERATIONS }, "Operations cap reached — dropping oldest");
        this.operations.splice(0, 1000); // drop oldest 1000
      }
      this.operations.push(data);

      this._logOperation(data);

      if (this._operationCallback) {
        try {
          this._operationCallback(data);
        } catch (e) {
          logger.warn({ err: e }, "Operation callback failed");
        }
      }

      if (this._enableSnapshotCapture && data.type === "navigate") {
        const url = data.url || "";
        if (url && url !== "about:blank" && !url.startsWith("chrome://")) {
          this._captureSnapshot(url, tabId).catch(() => {});
        }
      }
    } catch (e) {
      logger.warn({ err: e }, "Failed to parse operation data");
    }
  }

  private _handleNavigation(event: any, tabId: string): void {
    const frame = event.frame || {};
    const url = frame.url as string | undefined;
    const parentId = frame.parentId;

    if (parentId !== undefined) return;

    if (!url || url === "about:blank" || url.startsWith("chrome://")) return;

    logger.debug({ tabId, url }, "CDP navigation detected");

    const navPayload = JSON.stringify({
      type: "navigate",
      timestamp: new Date().toISOString(),
      url,
    });
    this._processOperation(navPayload, tabId).catch(() => {});
  }

  // ===== Dataload Detection =====

  private _handleResponse(response: PwResponse, tabId: string): void {
    if (!this._isRecording) return;
    this._processResponse(response, tabId).catch(() => {});
  }

  private async _processResponse(response: PwResponse, tabId: string): Promise<void> {
    try {
      if (!this._lastScrollTime) return;
      if (Date.now() - this._lastScrollTime > this._dataloadWindowMs) return;

      const request = response.request();
      const resourceType = request.resourceType();
      if (resourceType !== "xhr" && resourceType !== "fetch") return;

      const status = response.status();
      if (status < 200 || status >= 300) return;

      const contentType = (await response.allHeaders())["content-type"] || "";
      if (!contentType.includes("application/json")) return;

      const requestUrl = request.url();
      const urlBase = requestUrl.split("?")[0];

      if (this._recentDataloadUrls.has(urlBase)) return;
      this._recentDataloadUrls.add(urlBase);

      const data: RecordedOperation = {
        type: "dataload",
        timestamp: new Date().toISOString(),
        url: response.frame()?.url() || "",
        request_url: requestUrl,
        method: request.method(),
        status,
        tab_id: tabId,
      };

      if (this.operations.length >= MAX_OPERATIONS) {
        this.operations.splice(0, 1000);
      }
      this.operations.push(data);
      this._logOperation(data);

      if (this._operationCallback) {
        try {
          this._operationCallback(data);
        } catch (e) {
          logger.warn({ err: e }, "Operation callback failed");
        }
      }
    } catch (e) {
      logger.debug({ err: e }, "Error processing response");
    }
  }

  // ===== Snapshot Capture =====

  private async _captureSnapshot(url: string, tabId: string): Promise<void> {
    if (!this._browserSession || !this._enableSnapshotCapture) return;

    const urlHash = createHash("md5").update(url).digest("hex").slice(0, 12);

    if (this.snapshots[urlHash]) return;

    try {
      await new Promise((r) => setTimeout(r, 1000));

      let page = this._tabPages.get(tabId);
      if ((!page || page.isClosed()) && this._browserSession) {
        page = this._browserSession.pages.get(tabId) as Page | undefined;
      }
      if (!page || page.isClosed()) return;

      if (
        this._browserSession.snapshot &&
        this._browserSession.currentTabId === tabId
      ) {
        try {
          const snapshotResult = await this._browserSession.snapshot.getFullResult();
          if (snapshotResult) {
            this.snapshots[urlHash] = {
              url,
              snapshot_text: snapshotResult.snapshotText as string,
              captured_at: new Date().toISOString(),
            };
            logger.info({ url: url.slice(0, 60) }, "Snapshot captured");
            return;
          }
        } catch (e) {
          logger.debug({ url, err: e }, "Full snapshot capture failed; falling back to simple snapshot");
        }
      }

      const domContent = await page.evaluate(() => ({
        title: document.title,
        url: window.location.href,
      }));

      this.snapshots[urlHash] = {
        url,
        simple: domContent,
        captured_at: new Date().toISOString(),
      };
      logger.info({ url: url.slice(0, 60) }, "Simple snapshot captured");
    } catch (e) {
      logger.warn({ url, err: e }, "Failed to capture snapshot");
    }
  }

  // ===== Logging =====

  private _logOperation(data: RecordedOperation): void {
    const opType = (data.type || "unknown").toUpperCase();
    const ref = data.ref || "";
    const text = data.text ? data.text.slice(0, 30) : "";

    const parts: string[] = [`${opType}`];
    if (ref) parts.push(`ref=${ref}`);
    if (text) parts.push(`text="${text}"`);
    if (data.value) parts.push(`value="${String(data.value).slice(0, 30)}"`);
    if (data.url && opType === "NAVIGATE") parts.push(`url=${data.url.slice(0, 50)}`);
    if (data.request_url && opType === "DATALOAD") parts.push(`request=${data.request_url.slice(0, 60)}`);

    logger.debug({ operation: parts.join(" ") }, "Recorded operation");
  }
}
