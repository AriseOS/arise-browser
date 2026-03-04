/**
 * ActionExecutor — Executes high-level actions on a Playwright Page.
 *
 * Action types: click, type, select, wait, extract, scroll, enter,
 * mouse_control, mouse_drag, press_key, navigate, back, forward,
 * hover, focus
 *
 * Click: aria-ref selector, Ctrl+Click for new tab, force click fallback.
 * Mouse control: JS elementFromPoint + dispatchEvent.
 */

import type { Page } from "playwright";
import { BrowserConfig } from "./config.js";
import { createLogger } from "../logger.js";
import type { ActionDict, ActionResult, SessionRef } from "../types/index.js";

const logger = createLogger("action-executor");

function escapeRef(ref: string): string {
  return ref.replace(/['"\\]/g, "");
}

export class ActionExecutor {
  private page: Page;
  private session: SessionRef | undefined;
  private defaultTimeout: number;
  private shortTimeout: number;
  private maxScrollAmount: number;

  constructor(page: Page, session?: SessionRef) {
    this.page = page;
    this.session = session;
    this.defaultTimeout = BrowserConfig.actionTimeout;
    this.shortTimeout = BrowserConfig.shortTimeout;
    this.maxScrollAmount = BrowserConfig.maxScrollAmount;
  }

  async execute(action: ActionDict): Promise<ActionResult> {
    if (!action) {
      return { success: false, message: "No action to execute", details: {} };
    }

    const actionType = action.type as string | undefined;
    if (!actionType) {
      return { success: false, message: "Error: action has no type", details: {} };
    }

    try {
      const handlers: Record<string, (a: ActionDict) => Promise<{ message: string; details: Record<string, unknown> }>> = {
        click: (a) => this._click(a),
        type: (a) => this._type(a),
        select: (a) => this._select(a),
        wait: (a) => this._wait(a),
        extract: (a) => this._extract(a),
        scroll: (a) => this._scroll(a),
        enter: (a) => this._enter(a),
        mouse_control: (a) => this._mouseControl(a),
        mouse_drag: (a) => this._mouseDrag(a),
        press_key: (a) => this._pressKey(a),
        navigate: (a) => this._navigate(a),
        back: (a) => this._back(a),
        forward: (a) => this._forward(a),
        hover: (a) => this._hover(a),
        focus: (a) => this._focus(a),
      };

      const handler = handlers[actionType];
      if (!handler) {
        return {
          success: false,
          message: `Error: Unknown action type '${actionType}'`,
          details: { action_type: actionType },
        };
      }

      const result = await handler(action);
      const msg = result.message;
      const isError = msg.startsWith("Error:") || msg.startsWith("Action failed:");

      return { success: !isError, message: msg, details: result.details };
    } catch (exc) {
      logger.error({ actionType, err: exc }, "Action execution failed");
      return {
        success: false,
        message: `Error executing ${actionType}: ${exc}`,
        details: { action_type: actionType, error: String(exc) },
      };
    }
  }

  static shouldUpdateSnapshot(action: ActionDict): boolean {
    const changeTypes = new Set([
      "click", "type", "select", "scroll", "navigate",
      "enter", "back", "forward", "mouse_control", "mouse_drag", "press_key",
      "hover", "focus",
    ]);
    return changeTypes.has(action.type as string);
  }

  // ===== Click =====

  private async _click(action: ActionDict): Promise<{ message: string; details: Record<string, unknown> }> {
    const ref = action.ref as string | undefined;
    if (!ref) {
      return { message: "Error: click requires ref", details: { error: "missing_ref" } };
    }

    const target = `[aria-ref='${escapeRef(ref)}']`;
    const details: Record<string, unknown> = {
      ref,
      strategies_tried: [],
      successful_strategy: null,
      click_method: null,
      new_tab_created: false,
    };

    const count = await this.page.locator(target).count();
    if (count === 0) {
      details.error = "element_not_found";
      return { message: "Error: Click failed, element not found", details };
    }

    const element = this.page.locator(target).first();
    details.successful_strategy = target;

    let clickTarget = element;

    // Collect element diagnostics
    let elementDiag: Record<string, unknown> | null = null;
    try {
      elementDiag = await element.evaluate((el: Element) => {
        const text = ((el as HTMLElement).innerText || el.textContent || "").trim();
        const rect = el.getBoundingClientRect();
        const inViewport =
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom >= 0 &&
          rect.right >= 0 &&
          rect.top <= (window.innerHeight || document.documentElement.clientHeight) &&
          rect.left <= (window.innerWidth || document.documentElement.clientWidth);
        const closestLink = el.closest("a");
        const descendantLinks = el.querySelectorAll("a[href]");
        const descendantLink = descendantLinks.length === 1 ? descendantLinks[0] : null;
        const descendantText = descendantLink
          ? ((descendantLink as HTMLElement).innerText || descendantLink.textContent || "").trim()
          : "";
        return {
          tag: el.tagName,
          href: el.getAttribute("href"),
          closestHref: closestLink ? closestLink.getAttribute("href") : null,
          role: el.getAttribute("role"),
          text: text ? text.slice(0, 200) : "",
          descendantHref: descendantLink ? descendantLink.getAttribute("href") : null,
          descendantText: descendantText ? descendantText.slice(0, 200) : "",
          descendantCount: descendantLinks.length,
          onclick: !!el.getAttribute("onclick") || typeof (el as any).onclick === "function",
          inViewport,
        };
      });
      logger.debug({ elementDiag }, "Click element diagnostics");
    } catch (e) {
      logger.debug({ err: e }, "Click diagnostics failed");
    }

    // Conservative redirect: if container wraps a single link, prefer that link
    try {
      if (elementDiag) {
        const tag = elementDiag.tag as string;
        const href = elementDiag.href;
        const closestHref = elementDiag.closestHref;
        const hasOnclick = elementDiag.onclick;
        const descendantCount = elementDiag.descendantCount as number;
        const descendantHref = elementDiag.descendantHref;
        const sourceText = ((elementDiag.text as string) || "").trim();
        const descendantText = ((elementDiag.descendantText as string) || "").trim();
        const role = elementDiag.role as string | null;
        const roleIsLink = (role || "").toLowerCase() === "link";

        if (
          ["LI", "DIV", "SPAN"].includes(tag) &&
          !href &&
          !closestHref &&
          !roleIsLink &&
          !hasOnclick &&
          descendantCount === 1 &&
          descendantHref &&
          sourceText &&
          descendantText &&
          (sourceText.toLowerCase().includes(descendantText.toLowerCase()) ||
            descendantText.toLowerCase().includes(sourceText.toLowerCase()))
        ) {
          const descendantLocator = element.locator(":scope a[href]").first();
          if (
            (await descendantLocator.count()) > 0 &&
            (await descendantLocator.isVisible()) &&
            (await descendantLocator.isEnabled())
          ) {
            clickTarget = descendantLocator;
            details.redirected_click_target = "descendant_a";
            details.descendant_href = descendantHref;
            logger.debug({ descendantHref }, "Redirecting click to descendant <a>");
          }
        }
      }
    } catch (e) {
      logger.debug({ err: e }, "Descendant link check failed");
    }

    // Strategy 1: Ctrl+Click (opens links in new tabs)
    try {
      if (this.session) {
        const context = this.page.context();
        const t0 = performance.now();

        const newPagePromise = context.waitForEvent("page", {
          timeout: this.shortTimeout,
        });
        newPagePromise.catch(() => {});

        await clickTarget.click({ modifiers: ["ControlOrMeta"] });
        logger.debug("Click executed, waiting for page event...");

        const newPage = await newPagePromise;
        const elapsedMs = Math.round(performance.now() - t0);

        await newPage.waitForLoadState("domcontentloaded");

        const tabsAfter = await this.session.getTabInfo();
        const newTabInfo = tabsAfter.find(
          (t) => !t.is_current && t.url !== "(closed)" && t.url !== "(error)",
        );
        const newTabId = newTabInfo?.tab_id;

        if (newTabId) {
          await this.session.switchToTab(newTabId);
        }

        details.click_method = "ctrl_click_new_tab";
        details.new_tab_created = true;
        details.new_tab_index = newTabId;
        details.ctrl_click_elapsed_ms = elapsedMs;

        return {
          message: `Clicked element, opened in new tab ${newTabId}`,
          details,
        };
      } else {
        await clickTarget.click({ modifiers: ["ControlOrMeta"] });
        details.click_method = "ctrl_click_no_session";
        return { message: `Clicked element (ctrl click): ${target}`, details };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("Timeout") || msg.includes("timeout")) {
        details.click_method = "ctrl_click_same_tab";
        return { message: `Clicked element (same tab): ${target}`, details };
      }

      (details.strategies_tried as unknown[]).push({
        selector: target,
        method: "ctrl_click",
        error: msg,
      });
    }

    // Strategy 2: Force click fallback
    logger.debug("Falling back to force click...");
    try {
      await clickTarget.click({ force: true, timeout: this.defaultTimeout });
      details.click_method = "force_click";
      return { message: `Clicked element (force): ${target}`, details };
    } catch (e) {
      logger.debug({ err: e }, "Force click also failed");
      details.click_method = "all_failed";
      details.error = String(e);
      return {
        message: `Error: All click strategies failed for ${target}`,
        details,
      };
    }
  }

  // ===== Type =====

  private async _type(action: ActionDict): Promise<{ message: string; details: Record<string, unknown> }> {
    const ref = action.ref as string | undefined;
    const text = (action.text as string) || "";

    if (!ref) {
      return { message: "Error: type requires ref", details: { error: "missing_ref" } };
    }

    const target = `[aria-ref='${escapeRef(ref)}']`;
    const details: Record<string, unknown> = { ref, target, text, text_length: text.length };

    try {
      await this.page.fill(target, text, { timeout: this.shortTimeout });
      return { message: `Typed '${text}' into ${target}`, details };
    } catch (exc) {
      details.error = String(exc);
      return { message: `Type failed: ${exc}`, details };
    }
  }

  // ===== Select =====

  private async _select(action: ActionDict): Promise<{ message: string; details: Record<string, unknown> }> {
    const ref = action.ref as string | undefined;
    const value = (action.value as string) || "";

    if (!ref) {
      return { message: "Error: select requires ref", details: { error: "missing_ref" } };
    }

    const target = `[aria-ref='${escapeRef(ref)}']`;
    const details: Record<string, unknown> = { ref, target, value };

    try {
      await this.page.selectOption(target, value, { timeout: this.defaultTimeout });
      return { message: `Selected '${value}' in ${target}`, details };
    } catch (exc) {
      details.error = String(exc);
      return { message: `Select failed: ${exc}`, details };
    }
  }

  // ===== Wait =====

  private async _wait(action: ActionDict): Promise<{ message: string; details: Record<string, unknown> }> {
    const details: Record<string, unknown> = {
      wait_type: null,
      timeout: null,
      selector: null,
    };

    if ("timeout" in action) {
      const ms = Math.min(Math.max(0, Number(action.timeout) || 0), 30_000);
      details.wait_type = "timeout";
      details.timeout = ms;
      await new Promise((resolve) => setTimeout(resolve, ms));
      return { message: `Waited ${ms}ms`, details };
    }

    if ("selector" in action) {
      const sel = action.selector as string;
      details.wait_type = "selector";
      details.selector = sel;
      await this.page.waitForSelector(sel, { timeout: this.defaultTimeout });
      return { message: `Waited for ${sel}`, details };
    }

    return { message: "Error: wait requires timeout/selector", details };
  }

  // ===== Extract =====

  private async _extract(action: ActionDict): Promise<{ message: string; details: Record<string, unknown> }> {
    const ref = action.ref as string | undefined;
    if (!ref) {
      return { message: "Error: extract requires ref", details: { error: "missing_ref" } };
    }

    const target = `[aria-ref='${escapeRef(ref)}']`;
    const details: Record<string, unknown> = { ref, target };

    try {
      await this.page.waitForSelector(target, { timeout: this.defaultTimeout });
      const txt = await this.page.textContent(target);

      details.extracted_text = txt;
      details.text_length = txt ? txt.length : 0;

      return {
        message: `Extracted: ${txt ? txt.slice(0, 100) : "None"}`,
        details,
      };
    } catch (e) {
      details.error = String(e);
      return { message: `Error: extract failed: ${e}`, details };
    }
  }

  // ===== Scroll =====

  private async _scroll(action: ActionDict): Promise<{ message: string; details: Record<string, unknown> }> {
    const direction = (action.direction as string) || "down";
    const amount = action.amount !== undefined ? Number(action.amount) : 300;

    const details: Record<string, unknown> = {
      direction,
      requested_amount: amount,
      actual_amount: null,
      scroll_offset: null,
    };

    if (direction !== "up" && direction !== "down") {
      return { message: "Error: direction must be 'up' or 'down'", details };
    }

    let amountInt: number;
    try {
      amountInt = Math.round(amount);
      amountInt = Math.max(-this.maxScrollAmount, Math.min(this.maxScrollAmount, amountInt));
      details.actual_amount = amountInt;
    } catch {
      return { message: "Error: amount must be a valid number", details };
    }

    const scrollOffset = direction === "down" ? amountInt : -amountInt;
    details.scroll_offset = scrollOffset;

    await this.page.evaluate((offset: number) => window.scrollBy(0, offset), scrollOffset);
    await new Promise((resolve) => setTimeout(resolve, 500));

    return { message: `Scrolled ${direction} by ${Math.abs(amountInt)}px`, details };
  }

  // ===== Enter =====

  private async _enter(_action: ActionDict): Promise<{ message: string; details: Record<string, unknown> }> {
    const details: Record<string, unknown> = { action_type: "enter", target: "focused_element" };
    await this.page.keyboard.press("Enter");
    return { message: "Pressed Enter on focused element", details };
  }

  // ===== Mouse Control =====

  private async _mouseControl(action: ActionDict): Promise<{ message: string; details: Record<string, unknown> }> {
    const control = (action.control as string) || "click";
    const xCoord = Number(action.x) || 0;
    const yCoord = Number(action.y) || 0;

    const details: Record<string, unknown> = {
      action_type: "mouse_control",
      target: `coordinates : (${xCoord}, ${yCoord})`,
    };

    try {
      if (!this._validCoordinates(xCoord, yCoord)) {
        throw new Error(`Invalid coordinates, outside viewport bounds: (${xCoord}, ${yCoord})`);
      }

      if (control === "click") {
        const found = await this.page.evaluate(
          ([x, y]: [number, number]) => {
            const el = document.elementFromPoint(x, y);
            if (!el) return false;
            const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };
            el.dispatchEvent(new MouseEvent("mousedown", opts));
            el.dispatchEvent(new MouseEvent("mouseup", opts));
            el.dispatchEvent(new MouseEvent("click", opts));
            if (
              el.tagName === "INPUT" ||
              el.tagName === "TEXTAREA" ||
              (el as HTMLElement).isContentEditable
            )
              (el as HTMLElement).focus();
            return true;
          },
          [xCoord, yCoord] as [number, number],
        );
        if (!found) throw new Error(`No element found at coordinates (${xCoord}, ${yCoord})`);
        return { message: "Action 'click' performed on the target", details };
      } else if (control === "right_click") {
        const found = await this.page.evaluate(
          ([x, y]: [number, number]) => {
            const el = document.elementFromPoint(x, y);
            if (!el) return false;
            const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 };
            el.dispatchEvent(new MouseEvent("mousedown", opts));
            el.dispatchEvent(new MouseEvent("mouseup", opts));
            el.dispatchEvent(new MouseEvent("contextmenu", opts));
            return true;
          },
          [xCoord, yCoord] as [number, number],
        );
        if (!found) throw new Error(`No element found at coordinates (${xCoord}, ${yCoord})`);
        return { message: "Action 'right_click' performed on the target", details };
      } else if (control === "dblclick") {
        const found = await this.page.evaluate(
          ([x, y]: [number, number]) => {
            const el = document.elementFromPoint(x, y);
            if (!el) return false;
            const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };
            el.dispatchEvent(new MouseEvent("mousedown", opts));
            el.dispatchEvent(new MouseEvent("mouseup", opts));
            el.dispatchEvent(new MouseEvent("click", opts));
            el.dispatchEvent(new MouseEvent("mousedown", opts));
            el.dispatchEvent(new MouseEvent("mouseup", opts));
            el.dispatchEvent(new MouseEvent("click", opts));
            el.dispatchEvent(new MouseEvent("dblclick", opts));
            if (
              el.tagName === "INPUT" ||
              el.tagName === "TEXTAREA" ||
              (el as HTMLElement).isContentEditable
            )
              (el as HTMLElement).focus();
            return true;
          },
          [xCoord, yCoord] as [number, number],
        );
        if (!found) throw new Error(`No element found at coordinates (${xCoord}, ${yCoord})`);
        return { message: "Action 'dblclick' performed on the target", details };
      } else {
        return { message: `Error: Invalid control action '${control}'`, details };
      }
    } catch (e) {
      return { message: `Action failed: ${e}`, details };
    }
  }

  // ===== Mouse Drag =====

  private async _mouseDrag(action: ActionDict): Promise<{ message: string; details: Record<string, unknown> }> {
    const fromRef = action.from_ref as string | undefined;
    const toRef = action.to_ref as string | undefined;

    if (!fromRef || !toRef) {
      return {
        message: "Error: mouse_drag requires from_ref and to_ref",
        details: { error: "missing_refs" },
      };
    }

    const fromSelector = `[aria-ref='${escapeRef(fromRef)}']`;
    const toSelector = `[aria-ref='${escapeRef(toRef)}']`;
    const details: Record<string, unknown> = {
      action_type: "mouse_drag",
      from_ref: fromRef,
      to_ref: toRef,
      from_selector: fromSelector,
      to_selector: toSelector,
    };

    try {
      const fromElement = this.page.locator(fromSelector);
      if ((await fromElement.count()) === 0) {
        throw new Error(`Source element with ref '${fromRef}' not found`);
      }

      const toElement = this.page.locator(toSelector);
      if ((await toElement.count()) === 0) {
        throw new Error(`Target element with ref '${toRef}' not found`);
      }

      const fromBox = await fromElement.first().boundingBox();
      const toBox = await toElement.first().boundingBox();

      if (!fromBox) throw new Error(`Could not get bounding box for source element with ref '${fromRef}'`);
      if (!toBox) throw new Error(`Could not get bounding box for target element with ref '${toRef}'`);

      const fromX = fromBox.x + fromBox.width / 2;
      const fromY = fromBox.y + fromBox.height / 2;
      const toX = toBox.x + toBox.width / 2;
      const toY = toBox.y + toBox.height / 2;

      details.from_coordinates = { x: fromX, y: fromY };
      details.to_coordinates = { x: toX, y: toY };

      const dragSuccess = await this.page.evaluate(
        ([fX, fY, tX, tY]: [number, number, number, number]) => {
          const fromEl = document.elementFromPoint(fX, fY);
          const toEl = document.elementFromPoint(tX, tY);
          if (!fromEl) return false;
          const dt = new DataTransfer();
          const common: any = { bubbles: true, cancelable: true, button: 0, dataTransfer: dt };
          fromEl.dispatchEvent(new MouseEvent("mousedown", { ...common, clientX: fX, clientY: fY }));
          fromEl.dispatchEvent(new DragEvent("dragstart", { ...common, clientX: fX, clientY: fY }));
          const moveTarget = toEl || fromEl;
          moveTarget.dispatchEvent(new DragEvent("dragover", { ...common, clientX: tX, clientY: tY }));
          moveTarget.dispatchEvent(new DragEvent("drop", { ...common, clientX: tX, clientY: tY }));
          moveTarget.dispatchEvent(new MouseEvent("mouseup", { ...common, clientX: tX, clientY: tY }));
          fromEl.dispatchEvent(new DragEvent("dragend", { ...common, clientX: tX, clientY: tY }));
          return true;
        },
        [fromX, fromY, toX, toY] as [number, number, number, number],
      );

      if (!dragSuccess) {
        throw new Error(`No element found at source coordinates (${fromX}, ${fromY})`);
      }

      return {
        message: `Dragged from element [ref=${fromRef}] to element [ref=${toRef}]`,
        details,
      };
    } catch (e) {
      return { message: `Action failed: ${e}`, details };
    }
  }

  // ===== Press Key =====

  private async _pressKey(action: ActionDict): Promise<{ message: string; details: Record<string, unknown> }> {
    const keys = action.keys as string[] | undefined;
    if (!keys || keys.length === 0) {
      return {
        message: "Error: No keys specified",
        details: { action_type: "press_key", keys: "" },
      };
    }

    const combinedKeys = keys.join("+");
    const details: Record<string, unknown> = { action_type: "press_key", keys: combinedKeys };

    try {
      await this.page.keyboard.press(combinedKeys);
      return { message: "Pressed keys in the browser", details };
    } catch (e) {
      return { message: `Action failed: ${e}`, details };
    }
  }

  // ===== Navigate =====

  private async _navigate(action: ActionDict): Promise<{ message: string; details: Record<string, unknown> }> {
    const url = action.url as string | undefined;
    if (!url) {
      return { message: "Error: navigate requires url", details: { error: "missing_url" } };
    }

    const details: Record<string, unknown> = { action_type: "navigate", url };

    try {
      await this.page.goto(url, { timeout: BrowserConfig.navigationTimeout });
      await this.page.waitForLoadState("domcontentloaded");
      return { message: `Navigated to ${url}`, details };
    } catch (e) {
      details.error = String(e);
      return { message: `Navigation failed: ${e}`, details };
    }
  }

  // ===== Back / Forward =====

  private async _back(_action: ActionDict): Promise<{ message: string; details: Record<string, unknown> }> {
    const details: Record<string, unknown> = { action_type: "back" };
    try {
      await this.page.goBack({ timeout: BrowserConfig.navigationTimeout });
      return { message: "Navigated back", details };
    } catch (e) {
      details.error = String(e);
      return { message: `Back navigation failed: ${e}`, details };
    }
  }

  private async _forward(_action: ActionDict): Promise<{ message: string; details: Record<string, unknown> }> {
    const details: Record<string, unknown> = { action_type: "forward" };
    try {
      await this.page.goForward({ timeout: BrowserConfig.navigationTimeout });
      return { message: "Navigated forward", details };
    } catch (e) {
      details.error = String(e);
      return { message: `Forward navigation failed: ${e}`, details };
    }
  }

  // ===== Hover (new — Pinchtab compat) =====

  private async _hover(action: ActionDict): Promise<{ message: string; details: Record<string, unknown> }> {
    const ref = action.ref as string | undefined;
    if (!ref) {
      return { message: "Error: hover requires ref", details: { error: "missing_ref" } };
    }

    const target = `[aria-ref='${escapeRef(ref)}']`;
    const details: Record<string, unknown> = { ref, target, action_type: "hover" };

    try {
      const count = await this.page.locator(target).count();
      if (count === 0) {
        details.error = "element_not_found";
        return { message: "Error: Hover failed, element not found", details };
      }

      await this.page.locator(target).first().hover({ timeout: this.defaultTimeout });
      return { message: `Hovered over ${target}`, details };
    } catch (e) {
      details.error = String(e);
      return { message: `Hover failed: ${e}`, details };
    }
  }

  // ===== Focus (new — Pinchtab compat) =====

  private async _focus(action: ActionDict): Promise<{ message: string; details: Record<string, unknown> }> {
    const ref = action.ref as string | undefined;
    if (!ref) {
      return { message: "Error: focus requires ref", details: { error: "missing_ref" } };
    }

    const target = `[aria-ref='${escapeRef(ref)}']`;
    const details: Record<string, unknown> = { ref, target, action_type: "focus" };

    try {
      const count = await this.page.locator(target).count();
      if (count === 0) {
        details.error = "element_not_found";
        return { message: "Error: Focus failed, element not found", details };
      }

      await this.page.locator(target).first().focus({ timeout: this.defaultTimeout });
      return { message: `Focused on ${target}`, details };
    } catch (e) {
      details.error = String(e);
      return { message: `Focus failed: ${e}`, details };
    }
  }

  // ===== Utilities =====

  private _validCoordinates(xCoord: number, yCoord: number): boolean {
    const viewport = this.page.viewportSize();
    if (!viewport) {
      throw new Error("Viewport size not available from current page.");
    }
    return xCoord >= 0 && xCoord <= viewport.width && yCoord >= 0 && yCoord <= viewport.height;
  }
}
