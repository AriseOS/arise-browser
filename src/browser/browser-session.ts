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

type PageRegisteredListener = (tabId: string, page: Page) => void | Promise<void>;

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
  private _snapshotCache = new WeakMap<Page, PageSnapshot>();
  private _executorCache = new WeakMap<Page, ActionExecutor>();
  private _pageIds = new WeakMap<Page, string>();
  private _pageListeners = new WeakSet<Page>();
  private _pageRegisteredListeners = new Set<PageRegisteredListener>();
  private _contextListenersAttached = false;

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

  onPageRegistered(listener: PageRegisteredListener): () => void {
    this._pageRegisteredListeners.add(listener);
    return () => {
      this._pageRegisteredListeners.delete(listener);
    };
  }

  private _getSnapshotForPage(page: Page): PageSnapshot {
    let snapshot = this._snapshotCache.get(page);
    if (!snapshot) {
      snapshot = new PageSnapshot(page);
      this._snapshotCache.set(page, snapshot);
    }
    return snapshot;
  }

  private _getExecutorForPage(page: Page): ActionExecutor {
    let executor = this._executorCache.get(page);
    if (!executor) {
      executor = new ActionExecutor(page, this);
      this._executorCache.set(page, executor);
    }
    return executor;
  }

  private _attachCurrentPage(tabId: string, page: Page): void {
    this._currentTabId = tabId;
    this._page = page;
    this.snapshot = this._getSnapshotForPage(page);
    this.executor = this._getExecutorForPage(page);
  }

  private async _emitPageRegistered(tabId: string, page: Page): Promise<void> {
    for (const listener of this._pageRegisteredListeners) {
      try {
        await listener(tabId, page);
      } catch (e) {
        logger.warn({ tabId, err: e }, "Page registered listener failed");
      }
    }
  }

  private async _registerPage(
    page: Page,
    options?: { tabId?: string; makeCurrent?: boolean; group?: TabGroup },
  ): Promise<{ tabId: string; isNew: boolean }> {
    const existingTabId = this._pageIds.get(page);
    if (existingTabId) {
      if (options?.group) {
        options.group.tabs.set(existingTabId, page);
      }
      if (options?.makeCurrent) {
        this._attachCurrentPage(existingTabId, page);
      }
      return { tabId: existingTabId, isNew: false };
    }

    const tabId = options?.tabId ?? nextTabId();
    this._pages.set(tabId, page);
    this._pageIds.set(page, tabId);

    if (options?.group) {
      options.group.tabs.set(tabId, page);
    }

    this._setupPageListeners(tabId, page);

    if (options?.makeCurrent || !this._page) {
      this._attachCurrentPage(tabId, page);
    }

    await this._emitPageRegistered(tabId, page);
    return { tabId, isNew: true };
  }

  private async _resolvePage(
    tabId?: string,
    options?: { createIfMissing?: boolean },
  ): Promise<{ tabId: string | null; page: Page | null }> {
    await this.ensureBrowser();

    if (tabId) {
      const page = this._pages.get(tabId);
      if (!page || page.isClosed()) {
        throw new Error(`Tab not found: ${tabId}`);
      }
      return { tabId, page };
    }

    if (this._page && !this._page.isClosed()) {
      return { tabId: this._currentTabId, page: this._page };
    }

    if (options?.createIfMissing) {
      const page = await this.getPage();
      return { tabId: this._currentTabId, page };
    }

    return { tabId: null, page: null };
  }

  private _normalizeNavigationTimeout(timeout?: number): number {
    const parsed = Number(timeout);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return BrowserConfig.navigationTimeout;
    }
    return Math.floor(parsed);
  }

  private _remainingTimeout(deadline: number): number {
    return Math.max(1, deadline - Date.now());
  }

  private async _navigatePage(page: Page, url: string, timeout?: number): Promise<void> {
    const deadline = Date.now() + this._normalizeNavigationTimeout(timeout);

    await page.goto(url, {
      timeout: this._remainingTimeout(deadline),
      waitUntil: "domcontentloaded",
    });

    const idleTimeout = Math.min(
      BrowserConfig.networkIdleTimeout,
      this._remainingTimeout(deadline),
    );

    if (idleTimeout <= 0) {
      return;
    }

    try {
      await page.waitForLoadState("networkidle", {
        timeout: idleTimeout,
      });
    } catch {
      // networkidle timeout is acceptable — DOM content already loaded
    }
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
        this._setupContextListeners();
        logger.info(
          { contexts: contexts.length, pages: this._context.pages().length },
          "CDP connection established",
        );

        // Register existing pages
        for (const page of this._context.pages()) {
          const url = page.url();
          if (url && url !== "about:blank" && !page.isClosed()) {
            await this._registerPage(page, { makeCurrent: !this._page });
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
        this._setupContextListeners();
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
        this._setupContextListeners();
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
          this._attachCurrentPage(nextId, nextPage);
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

  private _setupContextListeners(): void {
    if (!this._context || this._contextListenersAttached) {
      return;
    }

    this._context.on("page", (page) => {
      this._handleNewPage(page).catch((e) =>
        logger.warn({ err: e }, "Error handling context page"),
      );
    });
    this._contextListenersAttached = true;
  }

  private _setupPageListeners(tabId: string, page: Page): void {
    if (this._pageListeners.has(page)) {
      return;
    }
    this._pageListeners.add(page);

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
    const { tabId, isNew } = await this._registerPage(page);
    if (isNew) {
      logger.info({ tabId, url: page.url() }, "New page auto-registered");
    }
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
      await this._registerPage(page, { makeCurrent: true });
    }
    return this._page!;
  }

  // ===== Navigation =====

  async getPageForTab(tabId?: string, options?: { createIfMissing?: boolean }): Promise<Page | null> {
    const resolved = await this._resolvePage(tabId, options);
    return resolved.page;
  }

  async getPageInfo(tabId?: string): Promise<{ tabId: string | null; url: string; title: string }> {
    const resolved = await this._resolvePage(tabId);
    const page = resolved.page;
    if (!page || page.isClosed()) {
      return {
        tabId: resolved.tabId,
        url: "",
        title: "",
      };
    }

    let title = "";
    try {
      title = await page.title();
    } catch {
      // ignore transient title failures
    }

    return {
      tabId: resolved.tabId,
      url: page.url(),
      title,
    };
  }

  async visit(url: string, options?: { tabId?: string; timeout?: number }): Promise<string> {
    const resolved = await this._resolvePage(options?.tabId, {
      createIfMissing: !options?.tabId,
    });
    const page = resolved.page;

    if (!page) {
      throw new Error("No active page");
    }

    await this._navigatePage(page, url, options?.timeout);

    return `Navigated to ${page.url()}`;
  }

  // ===== Snapshot =====

  async getSnapshot(options?: {
    tabId?: string;
    forceRefresh?: boolean;
    diffOnly?: boolean;
    viewportLimit?: boolean;
  }): Promise<string> {
    const resolved = await this._resolvePage(options?.tabId);
    if (!resolved.page) return "<empty>";
    return this._getSnapshotForPage(resolved.page).capture(options);
  }

  async getSnapshotWithElements(options?: {
    tabId?: string;
    viewportLimit?: boolean;
  }): Promise<Record<string, unknown>> {
    const resolved = await this._resolvePage(options?.tabId);
    if (!resolved.page) {
      return { snapshotText: "<empty>", elements: {} };
    }
    return this._getSnapshotForPage(resolved.page).getFullResult(options);
  }

  getLastElements(tabId?: string): Record<string, unknown> {
    if (tabId) {
      const page = this._pages.get(tabId);
      if (!page || page.isClosed()) {
        return {};
      }
      return this._getSnapshotForPage(page).getLastElements();
    }

    return this.snapshot?.getLastElements() ?? {};
  }

  // ===== Action Execution =====

  async execAction(action: Record<string, unknown>, tabId?: string): Promise<ActionResult> {
    const resolved = await this._resolvePage(tabId);
    if (!resolved.page) {
      return { success: false, message: "No executor available", details: {} };
    }

    const executor = resolved.page === this._page && this.executor
      ? this.executor
      : this._getExecutorForPage(resolved.page);
    return executor.execute(action);
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

    this._attachCurrentPage(tabId, page);

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

  async createNewTab(url?: string, options?: { timeout?: number }): Promise<[string, Page]> {
    await this.ensureBrowser();
    if (!this._context) {
      throw new Error("No browser context available");
    }

    const page = await this._context.newPage();
    const { tabId } = await this._registerPage(page);

    if (url) {
      try {
        await this._navigatePage(page, url, options?.timeout);
      } catch (e) {
        logger.warn({ url, err: e }, "Navigation failed for new tab");
        await this.closeTab(tabId);
        throw e;
      }
    }

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

  async createTabInGroup(taskId: string, url?: string, options?: { timeout?: number }): Promise<[string, Page]> {
    await this.ensureBrowser();
    if (!this._context) {
      throw new Error("No browser context available");
    }

    let group = this._tabGroups.get(taskId);
    if (!group) {
      group = await this.createTabGroup(taskId);
    }

    const page = await this._context.newPage();
    const { tabId } = await this._registerPage(page, { group });

    if (url) {
      try {
        await this._navigatePage(page, url, options?.timeout);
      } catch (e) {
        logger.warn({ url, err: e }, "Navigation failed for new tab in group");
        await this.closeTab(tabId);
        throw e;
      }
    }

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

  async takeScreenshot(options?: { tabId?: string; type?: "jpeg" | "png"; quality?: number }): Promise<Buffer | null> {
    const page = await this.getPageForTab(options?.tabId);
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

  async exportPdf(tabId?: string): Promise<Buffer | null> {
    if (this._config.headless === false) {
      throw new Error("PDF export requires headless mode");
    }
    const page = await this.getPageForTab(tabId);
    if (!page || page.isClosed()) return null;

    try {
      return await page.pdf();
    } catch (e) {
      logger.warn({ err: e }, "PDF export failed");
      return null;
    }
  }

  // ===== Text extraction =====

  async getPageText(tabId?: string): Promise<string> {
    const page = await this.getPageForTab(tabId);
    if (!page || page.isClosed()) return "";

    try {
      return await page.evaluate(() => document.body.innerText || document.body.textContent || "");
    } catch (e) {
      logger.warn({ err: e }, "Text extraction failed");
      return "";
    }
  }

  // ===== Evaluate =====

  async evaluate(expression: string, tabId?: string): Promise<unknown> {
    const page = await this.getPageForTab(tabId);
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

    this._contextListenersAttached = false;
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
