/**
 * BrowserSession — Multi-mode browser automation engine.
 *
 * Connection modes:
 * - 'standalone': Launch new Chromium instance
 * - 'cdp': Connect to existing browser via CDP
 * - 'managed': Persistent browser profile (launchPersistentContext)
 *
 * Key concepts:
 * - Tab management (Map<tabId, Page>), Tab Groups
 * - Singleton per session-id, factory method create()
 * - Popup event listening, crash handling
 * - getSnapshot(), execAction(), visit()
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { BrowserConfig, getStealthContextOptions, getUserAgent } from "./config.js";
import { PageSnapshot } from "./page-snapshot.js";
import { ActionExecutor } from "./action-executor.js";
import { createLogger } from "../logger.js";
import type { AriseBrowserConfig, ActionResult, TabInfo, SessionRef } from "../types/index.js";

const logger = createLogger("browser-session");

function isLikelySingleExpression(source: string): boolean {
  const trimmed = source.trim().replace(/;$/, "");
  return !trimmed.includes("\n")
    && !trimmed.includes(";")
    && !/\b(return|const|let|var|if|for|while|switch|try|class|function)\b/.test(trimmed);
}

function getEvaluationFallback(expression: string, error: unknown): { source: string; mode: "sync" | "async" } | null {
  const message = error instanceof Error ? error.message : String(error);
  const source = expression.trim();

  if (!source) {
    return null;
  }

  if (message.includes("await is only valid")) {
    if (isLikelySingleExpression(source)) {
      return {
        source: `(async () => (${source.replace(/;$/, "")}))()`,
        mode: "async",
      };
    }

    return {
      source: `(async () => {\n${source}\n})()`,
      mode: "async",
    };
  }

  if (message.includes("Illegal return statement")) {
    return {
      source: `(() => {\n${source}\n})()`,
      mode: "sync",
    };
  }

  return null;
}

// ===== Tab Group =====

const TAB_GROUP_COLORS = ["blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];

interface TabGroup {
  taskId: string;
  title: string;
  color: string;
  tabs: Map<string, Page>;
  currentTabId?: string;
}

// ===== Tab ID Generator =====

let _tabCounter = 0;

function nextTabId(): string {
  _tabCounter++;
  return `tab-${String(_tabCounter).padStart(3, "0")}`;
}

// ===== BrowserSession =====

export class BrowserSession implements SessionRef {
  // Singleton registry
  private static _instances = new Map<string, BrowserSession>();

  // Connection
  private _browser: Browser | null = null;
  private _context: BrowserContext | null = null;

  // Pages
  private _pages = new Map<string, Page>();
  private _page: Page | null = null;
  private _currentTabId: string | null = null;

  // Tab Groups
  private _tabGroups = new Map<string, TabGroup>();
  private _colorIndex = 0;

  // Components
  snapshot: PageSnapshot | null = null;
  executor: ActionExecutor | null = null;

  // Connection mutex
  private _connectPromise: Promise<void> | null = null;

  // Config
  private _sessionId: string;
  private _config: AriseBrowserConfig;

  private constructor(sessionId: string, config: AriseBrowserConfig) {
    this._sessionId = sessionId;
    this._config = config;
  }

  // ===== Public getters =====

  get sessionId(): string {
    return this._sessionId;
  }

  get isConnected(): boolean {
    if (this._config.mode === "managed") {
      return this._context !== null;
    }
    return this._browser?.isConnected() ?? false;
  }

  get currentPage(): Page | null {
    return this._page;
  }

  get currentTabId(): string | null {
    return this._currentTabId;
  }

  /** Public getter for pages map (used by BehaviorRecorder). */
  get pages(): ReadonlyMap<string, Page> {
    return this._pages;
  }

  // ===== Factory / Singleton =====

  static create(config: AriseBrowserConfig, sessionId = "default"): BrowserSession {
    const existing = BrowserSession._instances.get(sessionId);
    if (existing) {
      logger.warn({ sessionId }, "Session already exists — returning existing instance (new config ignored)");
      return existing;
    }
    const instance = new BrowserSession(sessionId, config);
    BrowserSession._instances.set(sessionId, instance);
    return instance;
  }

  static getInstance(sessionId: string): BrowserSession | null {
    return BrowserSession._instances.get(sessionId) ?? null;
  }

  // ===== Connection =====

  async ensureBrowser(): Promise<void> {
    if (this._config.mode === "managed") {
      if (this._context) return;
    } else {
      if (this._browser?.isConnected()) return;
    }

    // Mutex: deduplicate concurrent connection attempts
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = this._doConnect();
    try {
      await this._connectPromise;
    } finally {
      this._connectPromise = null;
    }
  }

  private async _doConnect(): Promise<void> {
    switch (this._config.mode) {
      case "cdp": {
        if (!this._config.cdpUrl) {
          throw new Error("cdpUrl required for 'cdp' mode");
        }
        logger.info({ cdpUrl: this._config.cdpUrl, sessionId: this._sessionId }, "Connecting via CDP");
        this._browser = await chromium.connectOverCDP(this._config.cdpUrl);
        const contexts = this._browser.contexts();
        if (contexts.length === 0) {
          throw new Error("No browser contexts found via CDP");
        }
        this._context = contexts[0];
        logger.info(
          { contexts: contexts.length, pages: this._context.pages().length },
          "CDP connection established",
        );

        // Register existing pages
        for (const page of this._context.pages()) {
          const url = page.url();
          if (url && url !== "about:blank" && !page.isClosed()) {
            const tabId = nextTabId();
            this._pages.set(tabId, page);
            if (!this._page) {
              this._page = page;
              this._currentTabId = tabId;
              this.snapshot = new PageSnapshot(page);
              this.executor = new ActionExecutor(page, this);
            }
            this._setupPageListeners(tabId, page);
          }
        }
        break;
      }

      case "standalone": {
        logger.info({ headless: this._config.headless ?? true, sessionId: this._sessionId }, "Launching standalone browser");
        const ua = this._config.userAgent || getUserAgent();
        const viewport = this._config.viewport || { width: BrowserConfig.viewportWidth, height: BrowserConfig.viewportHeight };

        this._browser = await chromium.launch({
          headless: this._config.headless ?? true,
        });

        const contextOpts: Record<string, unknown> = {
          userAgent: ua,
          viewport,
        };

        if (this._config.stealthHeaders !== false) {
          Object.assign(contextOpts, getStealthContextOptions());
        }

        this._context = await this._browser.newContext(contextOpts);
        logger.info("Standalone browser launched");
        break;
      }

      case "managed": {
        if (!this._config.profileDir) {
          throw new Error("profileDir required for 'managed' mode");
        }
        logger.info({ profileDir: this._config.profileDir, sessionId: this._sessionId }, "Launching managed browser");
        const managedUa = this._config.userAgent || getUserAgent();
        const managedViewport = this._config.viewport || { width: BrowserConfig.viewportWidth, height: BrowserConfig.viewportHeight };

        const contextOpts2: Record<string, unknown> = {
          headless: this._config.headless ?? true,
          userAgent: managedUa,
          viewport: managedViewport,
        };

        if (this._config.stealthHeaders !== false) {
          Object.assign(contextOpts2, getStealthContextOptions());
        }

        this._context = await chromium.launchPersistentContext(
          this._config.profileDir,
          contextOpts2,
        );
        // PersistentContext doesn't have a separate Browser object
        // but context.browser() may return the underlying browser
        this._browser = this._context.browser();
        logger.info("Managed browser launched");
        break;
      }
    }
  }

  // ===== Page Lifecycle =====

  /** Unified tab cleanup — removes from _pages, tab groups, and picks next tab if needed. */
  private _cleanupTab(tabId: string): void {
    this._pages.delete(tabId);

    // Remove from any tab group
    for (const group of this._tabGroups.values()) {
      group.tabs.delete(tabId);
    }

    // If this was the current tab, pick the next non-closed one
    if (this._currentTabId === tabId) {
      let found = false;
      for (const [nextId, nextPage] of this._pages) {
        if (!nextPage.isClosed()) {
          this._currentTabId = nextId;
          this._page = nextPage;
          this.snapshot = new PageSnapshot(nextPage);
          this.executor = new ActionExecutor(nextPage, this);
          found = true;
          break;
        }
      }
      if (!found) {
        this._currentTabId = null;
        this._page = null;
        this.snapshot = null;
        this.executor = null;
      }
    }
  }

  private _setupPageListeners(tabId: string, page: Page): void {
    page.on("popup", (popup) => this._handleNewPage(popup).catch((e) =>
      logger.warn({ err: e }, "Error handling popup"),
    ));

    page.on("close", () => {
      this._cleanupTab(tabId);
    });

    page.on("crash", () => {
      logger.error({ tabId }, "Page crashed — removing from registry");
      this._cleanupTab(tabId);
    });
  }

  private async _handleNewPage(page: Page): Promise<void> {
    const tabId = nextTabId();
    this._pages.set(tabId, page);
    this._setupPageListeners(tabId, page);
    logger.info({ tabId, url: page.url() }, "New page auto-registered");
  }

  // ===== Page Access =====

  async getPage(): Promise<Page> {
    await this.ensureBrowser();
    if (!this._page) {
      // Create a new page in standalone/managed mode
      if (!this._context) {
        throw new Error("No browser context available");
      }
      const page = await this._context.newPage();
      const tabId = nextTabId();
      this._pages.set(tabId, page);
      this._page = page;
      this._currentTabId = tabId;
      this.snapshot = new PageSnapshot(page);
      this.executor = new ActionExecutor(page, this);
      this._setupPageListeners(tabId, page);
    }
    return this._page!;
  }

  // ===== Navigation =====

  async visit(url: string): Promise<string> {
    await this.ensureBrowser();
    const page = await this.getPage();

    await page.goto(url, { timeout: BrowserConfig.navigationTimeout });
    await page.waitForLoadState("domcontentloaded");

    try {
      await page.waitForLoadState("networkidle", {
        timeout: BrowserConfig.networkIdleTimeout,
      });
    } catch {
      logger.debug("Network idle timeout — continuing");
    }

    return `Navigated to ${page.url()}`;
  }

  // ===== Snapshot =====

  async getSnapshot(options?: {
    forceRefresh?: boolean;
    diffOnly?: boolean;
    viewportLimit?: boolean;
  }): Promise<string> {
    if (!this.snapshot) return "<empty>";
    return this.snapshot.capture(options);
  }

  async getSnapshotWithElements(options?: {
    viewportLimit?: boolean;
  }): Promise<Record<string, unknown>> {
    if (!this.snapshot) {
      return { snapshotText: "<empty>", elements: {} };
    }
    return this.snapshot.getFullResult(options);
  }

  getLastElements(): Record<string, unknown> {
    return this.snapshot?.getLastElements() ?? {};
  }

  // ===== Action Execution =====

  async execAction(action: Record<string, unknown>): Promise<ActionResult> {
    if (!this.executor) {
      return { success: false, message: "No executor available", details: {} };
    }
    return this.executor.execute(action);
  }

  // ===== Tab Management =====

  async getTabInfo(): Promise<TabInfo[]> {
    const tabs: TabInfo[] = [];
    for (const [tabId, page] of this._pages) {
      try {
        tabs.push({
          tab_id: tabId,
          url: page.isClosed() ? "(closed)" : page.url(),
          title: page.isClosed() ? "(closed)" : await page.title(),
          is_current: tabId === this._currentTabId,
        });
      } catch {
        tabs.push({
          tab_id: tabId,
          url: "(error)",
          title: "(error)",
          is_current: tabId === this._currentTabId,
        });
      }
    }
    return tabs;
  }

  async switchToTab(tabId: string): Promise<boolean> {
    const page = this._pages.get(tabId);
    if (!page || page.isClosed()) {
      return false;
    }

    this._currentTabId = tabId;
    this._page = page;
    this.snapshot = new PageSnapshot(page);
    this.executor = new ActionExecutor(page, this);

    logger.debug({ tabId }, "Switched to tab");
    return true;
  }

  async closeTab(tabId: string): Promise<boolean> {
    const page = this._pages.get(tabId);
    if (!page) return false;

    try {
      if (!page.isClosed()) {
        await page.close();
        // close event triggers _cleanupTab automatically
      } else {
        // Already closed — clean up manually
        this._cleanupTab(tabId);
      }
    } catch (e) {
      logger.warn({ tabId, err: e }, "Error closing page");
      this._cleanupTab(tabId);
    }

    return true;
  }

  async createNewTab(url?: string): Promise<[string, Page]> {
    await this.ensureBrowser();
    if (!this._context) {
      throw new Error("No browser context available");
    }

    const page = await this._context.newPage();
    const tabId = nextTabId();

    if (url) {
      try {
        await page.goto(url, { timeout: BrowserConfig.navigationTimeout });
        await page.waitForLoadState("domcontentloaded");
      } catch (e) {
        logger.warn({ url, err: e }, "Navigation failed for new tab");
      }
    }

    this._pages.set(tabId, page);
    this._setupPageListeners(tabId, page);

    return [tabId, page];
  }

  // ===== Tab Group Management =====

  async createTabGroup(taskId: string, title?: string): Promise<TabGroup> {
    const existing = this._tabGroups.get(taskId);
    if (existing) return existing;

    const groupTitle = title ?? `task-${taskId.slice(0, 8)}`;
    const color = TAB_GROUP_COLORS[this._colorIndex % TAB_GROUP_COLORS.length];
    this._colorIndex++;

    const group: TabGroup = {
      taskId,
      title: groupTitle,
      color,
      tabs: new Map(),
    };

    this._tabGroups.set(taskId, group);
    logger.info({ taskId, title: groupTitle, color }, "Created Tab Group");
    return group;
  }

  async createTabInGroup(taskId: string, url?: string): Promise<[string, Page]> {
    await this.ensureBrowser();
    if (!this._context) {
      throw new Error("No browser context available");
    }

    let group = this._tabGroups.get(taskId);
    if (!group) {
      group = await this.createTabGroup(taskId);
    }

    const page = await this._context.newPage();
    const tabId = nextTabId();

    if (url) {
      try {
        await page.goto(url, { timeout: BrowserConfig.navigationTimeout });
        await page.waitForLoadState("domcontentloaded");
      } catch (e) {
        logger.warn({ url, err: e }, "Navigation failed for new tab in group");
      }
    }

    group.tabs.set(tabId, page);
    this._pages.set(tabId, page);
    this._setupPageListeners(tabId, page);

    logger.info({ tabId, taskId, groupTitle: group.title }, "Created tab in group");
    return [tabId, page];
  }

  async closeTabGroup(taskId: string): Promise<boolean> {
    const group = this._tabGroups.get(taskId);
    if (!group) return false;

    const tabIds = [...group.tabs.keys()];
    for (const tabId of tabIds) {
      await this.closeTab(tabId);
    }

    this._tabGroups.delete(taskId);
    logger.info({ taskId, title: group.title }, "Tab Group closed");
    return true;
  }

  getTabGroupsInfo(): Record<string, unknown>[] {
    const info: Record<string, unknown>[] = [];
    for (const [taskId, group] of this._tabGroups) {
      const tabs: Record<string, unknown>[] = [];
      for (const [tabId, page] of group.tabs) {
        try {
          tabs.push({
            tab_id: tabId,
            url: page.isClosed() ? "(closed)" : page.url(),
            is_current: tabId === group.currentTabId,
          });
        } catch {
          tabs.push({ tab_id: tabId, url: "(error)", is_current: false });
        }
      }
      info.push({
        task_id: taskId,
        title: group.title,
        color: group.color,
        tab_count: group.tabs.size,
        tabs,
      });
    }
    return info;
  }

  // ===== Screenshot =====

  async takeScreenshot(options?: { type?: "jpeg" | "png"; quality?: number }): Promise<Buffer | null> {
    const page = this._page;
    if (!page || page.isClosed()) return null;

    try {
      const imgType = options?.type ?? "jpeg";
      const screenshotOpts: Record<string, unknown> = {
        type: imgType,
        timeout: BrowserConfig.screenshotTimeout,
      };
      // quality is only valid for jpeg
      if (imgType === "jpeg") {
        screenshotOpts.quality = options?.quality ?? 75;
      }
      const buffer = await page.screenshot(screenshotOpts);
      return buffer;
    } catch (e) {
      logger.warn({ err: e }, "Screenshot failed");
      return null;
    }
  }

  // ===== PDF =====

  async exportPdf(): Promise<Buffer | null> {
    if (this._config.headless === false) {
      throw new Error("PDF export requires headless mode");
    }
    const page = this._page;
    if (!page || page.isClosed()) return null;

    try {
      return await page.pdf();
    } catch (e) {
      logger.warn({ err: e }, "PDF export failed");
      return null;
    }
  }

  // ===== Text extraction =====

  async getPageText(): Promise<string> {
    const page = this._page;
    if (!page || page.isClosed()) return "";

    try {
      return await page.evaluate(() => document.body.innerText || document.body.textContent || "");
    } catch (e) {
      logger.warn({ err: e }, "Text extraction failed");
      return "";
    }
  }

  // ===== Evaluate =====

  async evaluate(expression: string): Promise<unknown> {
    const page = this._page;
    if (!page || page.isClosed()) {
      throw new Error("No active page");
    }

    try {
      return await page.evaluate(expression);
    } catch (error) {
      const fallback = getEvaluationFallback(expression, error);
      if (!fallback) {
        throw error;
      }

      logger.debug({ mode: fallback.mode }, "Retrying evaluation with wrapped function body");
      return page.evaluate(fallback.source);
    }
  }

  // ===== Cookies =====

  async getCookies(urls?: string[]): Promise<Record<string, unknown>[]> {
    if (!this._context) return [];
    const cookies = await this._context.cookies(urls);
    return cookies as unknown as Record<string, unknown>[];
  }

  async setCookies(cookies: Array<{ name: string; value: string; url?: string; domain?: string; path?: string }>): Promise<void> {
    if (!this._context) throw new Error("No browser context");
    await this._context.addCookies(cookies);
  }

  // ===== Cleanup =====

  async close(): Promise<void> {
    // Snapshot pages and clear map first so close event handlers are harmless no-ops
    const pagesToClose = [...this._pages.values()];
    this._pages.clear();
    this._tabGroups.clear();

    for (const page of pagesToClose) {
      try {
        if (!page.isClosed()) {
          await page.close();
        }
      } catch {
        // best effort
      }
    }
    this._page = null;
    this._currentTabId = null;
    this.snapshot = null;
    this.executor = null;

    // Close browser/context
    if (this._config.mode === "cdp") {
      // For CDP, just drop the reference (don't close the external browser)
      this._browser = null;
      this._context = null;
    } else {
      if (this._context) {
        try {
          await this._context.close();
        } catch {
          // best effort
        }
        this._context = null;
      }
      if (this._browser) {
        try {
          await this._browser.close();
        } catch {
          // best effort
        }
        this._browser = null;
      }
    }

    BrowserSession._instances.delete(this._sessionId);
  }

  static async closeAllSessions(): Promise<void> {
    const sessions = [...BrowserSession._instances.values()];
    BrowserSession._instances.clear();
    for (const session of sessions) {
      try {
        await session.close();
      } catch (e) {
        logger.error({ sessionId: session._sessionId, err: e }, "Error closing session");
      }
    }
  }
}
