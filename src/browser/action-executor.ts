/**
 * ActionExecutor — Executes high-level actions on a Playwright Page.
 *
 * Action types: click, type, select, wait, extract, scroll, enter,
 * mouse_control, mouse_drag, press_key, navigate, back, forward,
 * hover, focus
 *
 * Click: supports aria-ref/CSS selector, prefers regular click,
 * and validates observable state change to avoid false success.
 * Mouse control: JS elementFromPoint + dispatchEvent.
 */

import type { Locator, Page } from "playwright";
import { BrowserConfig } from "./config.js";
import { createLogger } from "../logger.js";
import type { ActionDict, ActionResult, SessionRef } from "../types/index.js";

const logger = createLogger("action-executor");

function escapeRef(ref: string): string {
  return ref.replace(/['"\\]/g, "");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface SelectState {
  tagName: string;
  role: string;
  value: string;
  selectedText: string;
  text: string;
  ariaLabel: string;
  ariaValueText: string;
}

interface ClickElementDiag {
  tag: string;
  href: string | null;
  closestHref: string | null;
  role: string | null;
  text: string;
  descendantHref: string | null;
  descendantText: string;
  descendantCount: number;
  onclick: boolean;
  inViewport: boolean;
}

interface ClickTargetState {
  role: string;
  ariaExpanded: string | null;
  ariaSelected: string | null;
  ariaPressed: string | null;
  value: string;
  checked: boolean | null;
  text: string;
  className: string;
}

interface ClickObservation {
  pageUrl: string;
  activeElement: string;
  targetPresent: boolean;
  targetState: ClickTargetState | null;
  dialogCount: number;
  listboxCount: number;
  menuCount: number;
  expandedCount: number;
}

interface ActionHandlerResult {
  success: boolean;
  message: string;
  details: Record<string, unknown>;
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
      const handlers: Record<string, (a: ActionDict) => Promise<ActionHandlerResult>> = {
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
      return { success: result.success, message: result.message, details: result.details };
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

  private async _click(action: ActionDict): Promise<ActionHandlerResult> {
    const ref = action.ref as string | undefined;
    const selector = action.selector as string | undefined;
    if (!ref && !selector) {
      return { success: false, message: "Error: click requires ref or selector", details: { error: "missing_target" } };
    }

    const target = ref ? `[aria-ref='${escapeRef(ref)}']` : selector!;
    const details: Record<string, unknown> = {
      ref: ref ?? null,
      selector: selector ?? null,
      target,
      strategies_tried: [],
      successful_strategy: null,
      click_method: null,
      new_tab_created: false,
    };

    const count = await this.page.locator(target).count();
    if (count === 0) {
      details.error = "element_not_found";
      return { success: false, message: "Error: Click failed, element not found", details };
    }

    const element = this.page.locator(target).first();
    details.successful_strategy = target;

    let clickTarget = element;

    // Collect element diagnostics
    let elementDiag: ClickElementDiag | null = null;
    try {
      const diag = await element.evaluate((el: Element) => {
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
      elementDiag = diag as ClickElementDiag;
      logger.debug({ elementDiag }, "Click element diagnostics");
    } catch (e) {
      logger.debug({ err: e }, "Click diagnostics failed");
    }

    // Conservative redirect: if container wraps a single link, prefer that link
    try {
      if (elementDiag) {
        const tag = elementDiag.tag;
        const href = elementDiag.href;
        const closestHref = elementDiag.closestHref;
        const hasOnclick = elementDiag.onclick;
        const descendantCount = elementDiag.descendantCount;
        const descendantHref = elementDiag.descendantHref;
        const sourceText = (elementDiag.text || "").trim();
        const descendantText = (elementDiag.descendantText || "").trim();
        const role = elementDiag.role;
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

    const beforeObservation = await this._captureClickObservation(clickTarget);
    details.before_observation = beforeObservation;

    const isLikelyLink = this._isLikelyLink(elementDiag);
    let clickPerformed = false;

    // Strategy 1: Ctrl+Click (links only, when tab session exists)
    if (isLikelyLink && this.session) {
      try {
        const context = this.page.context();
        const t0 = performance.now();
        const tabsBefore = new Set((await this.session.getTabInfo()).map((t) => t.tab_id));

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
          (t) => !tabsBefore.has(t.tab_id) && t.url !== "(closed)" && t.url !== "(error)",
        );
        const newTabId = newTabInfo?.tab_id;

        if (newTabId) {
          await this.session.switchToTab(newTabId);
        }

        details.click_method = "ctrl_click_new_tab";
        clickPerformed = true;
        details.new_tab_created = true;
        details.new_tab_index = newTabId;
        details.ctrl_click_elapsed_ms = elapsedMs;

        return {
          success: true,
          message: `Clicked element, opened in new tab ${newTabId}`,
          details,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("Timeout") || msg.includes("timeout")) {
          // Ctrl+Click was dispatched but no new tab appeared; continue with same-tab verification.
          details.click_method = "ctrl_click_same_tab";
          clickPerformed = true;
        } else {
          (details.strategies_tried as unknown[]).push({
            selector: target,
            method: "ctrl_click",
            error: msg,
          });
        }
      }
    }

    // Strategy 2: Regular click (default for non-link elements)
    if (!clickPerformed) {
      try {
        await clickTarget.click({ timeout: this.defaultTimeout });
        details.click_method = "click";
        clickPerformed = true;
      } catch (e) {
        (details.strategies_tried as unknown[]).push({
          selector: target,
          method: "click",
          error: String(e),
        });
      }
    }

    // Strategy 3: Force click fallback
    if (!clickPerformed) {
      logger.debug("Falling back to force click...");
      try {
        await clickTarget.click({ force: true, timeout: this.defaultTimeout });
        details.click_method = "force_click";
        clickPerformed = true;
      } catch (e) {
        logger.debug({ err: e }, "Force click also failed");
        details.click_method = "all_failed";
        details.error = String(e);
        return {
          success: false,
          message: `Error: All click strategies failed for ${target}`,
          details,
        };
      }
    }

    await this.page.waitForTimeout(180);
    const afterObservation = await this._captureClickObservation(clickTarget);
    details.after_observation = afterObservation;

    if (!this._didClickObservationChange(beforeObservation, afterObservation)) {
      details.no_state_change = true;
      details.warning = "no_state_change";
      return {
        success: true,
        message: `Clicked element (${details.click_method}): ${target} (no observable page state change)`,
        details,
      };
    }

    return { success: true, message: `Clicked element (${details.click_method}): ${target}`, details };
  }

  // ===== Type =====

  private async _type(action: ActionDict): Promise<ActionHandlerResult> {
    const ref = action.ref as string | undefined;
    const text = (action.text as string) || "";

    if (!ref) {
      return { success: false, message: "Error: type requires ref", details: { error: "missing_ref" } };
    }

    const target = `[aria-ref='${escapeRef(ref)}']`;
    const details: Record<string, unknown> = { ref, target, text, text_length: text.length };

    try {
      await this.page.fill(target, text, { timeout: this.shortTimeout });
      return { success: true, message: `Typed '${text}' into ${target}`, details };
    } catch (exc) {
      details.error = String(exc);
      return { success: false, message: `Type failed: ${exc}`, details };
    }
  }

  // ===== Select =====

  private async _select(action: ActionDict): Promise<ActionHandlerResult> {
    const ref = action.ref as string | undefined;
    const selector = action.selector as string | undefined;
    const value = (action.value as string) || "";

    if (!ref && !selector) {
      return { success: false, message: "Error: select requires ref or selector", details: { error: "missing_target" } };
    }

    const target = ref ? `[aria-ref='${escapeRef(ref)}']` : selector!;
    const details: Record<string, unknown> = { ref: ref ?? null, selector: selector ?? null, target, value };
    const control = this.page.locator(target).first();
    const variants = this._buildSelectVariants(value);
    details.value_variants = variants;

    try {
      const controlCount = await control.count();
      if (controlCount === 0) {
        details.error = "element_not_found";
        return { success: false, message: "Error: Select failed, element not found", details };
      }

      const beforeState = await this._readSelectState(control);
      details.before_state = beforeState;

      // Strategy 1: Native <select> element
      try {
        const nativeSelectedValues = await control.selectOption(value, { timeout: this.defaultTimeout });
        details.native_selected_values = nativeSelectedValues;

        const nativeReturnMatched = this._valuesMatchExpected(nativeSelectedValues, variants);
        details.native_return_matched = nativeReturnMatched;

        const afterNativeState = await this._readSelectState(control);
        details.native_after_state = afterNativeState;
        const nativeStateMatched =
          this._stateMatchesExpected(afterNativeState, variants) ||
          this._stateChanged(beforeState, afterNativeState);
        details.native_state_matched = nativeStateMatched;

        if (nativeReturnMatched || nativeStateMatched) {
          details.strategy = nativeStateMatched ? "native_select" : "native_select_return";
          return { success: true, message: `Selected '${value}' in ${target}`, details };
        }
      } catch (nativeErr) {
        details.native_error = String(nativeErr);
      }

      // Strategy 2: Custom dropdown/combobox/listbox controls
      const customClicked = await this._selectFromCustomControl(control, variants, details);
      const afterState = await this._readSelectState(control);
      details.after_state = afterState;

      if (customClicked && (this._stateMatchesExpected(afterState, variants) || this._stateChanged(beforeState, afterState))) {
        details.strategy = "custom_select";
        return { success: true, message: `Selected '${value}' in ${target}`, details };
      }

      details.error = "selection_not_verified";
      return { success: false, message: `Select failed: could not verify selection '${value}' in ${target}`, details };
    } catch (err) {
      details.error = String(err);
      return { success: false, message: `Select failed: ${err}`, details };
    }
  }

  // ===== Wait =====

  private async _wait(action: ActionDict): Promise<ActionHandlerResult> {
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
      return { success: true, message: `Waited ${ms}ms`, details };
    }

    if ("selector" in action) {
      const sel = action.selector as string;
      details.wait_type = "selector";
      details.selector = sel;
      await this.page.waitForSelector(sel, { timeout: this.defaultTimeout });
      return { success: true, message: `Waited for ${sel}`, details };
    }

    return { success: false, message: "Error: wait requires timeout/selector", details };
  }

  // ===== Extract =====

  private async _extract(action: ActionDict): Promise<ActionHandlerResult> {
    const ref = action.ref as string | undefined;
    if (!ref) {
      return { success: false, message: "Error: extract requires ref", details: { error: "missing_ref" } };
    }

    const target = `[aria-ref='${escapeRef(ref)}']`;
    const details: Record<string, unknown> = { ref, target };

    try {
      await this.page.waitForSelector(target, { timeout: this.defaultTimeout });
      const txt = await this.page.textContent(target);

      details.extracted_text = txt;
      details.text_length = txt ? txt.length : 0;

      return {
        success: true,
        message: `Extracted: ${txt ? txt.slice(0, 100) : "None"}`,
        details,
      };
    } catch (e) {
      details.error = String(e);
      return { success: false, message: `Error: extract failed: ${e}`, details };
    }
  }

  // ===== Scroll =====

  private async _scroll(action: ActionDict): Promise<ActionHandlerResult> {
    const direction = (action.direction as string) || "down";
    const amount = action.amount !== undefined ? Number(action.amount) : 300;

    const details: Record<string, unknown> = {
      direction,
      requested_amount: amount,
      actual_amount: null,
      scroll_offset: null,
    };

    if (direction !== "up" && direction !== "down") {
      return { success: false, message: "Error: direction must be 'up' or 'down'", details };
    }

    let amountInt: number;
    try {
      amountInt = Math.round(amount);
      amountInt = Math.max(-this.maxScrollAmount, Math.min(this.maxScrollAmount, amountInt));
      details.actual_amount = amountInt;
    } catch {
      return { success: false, message: "Error: amount must be a valid number", details };
    }

    const scrollOffset = direction === "down" ? amountInt : -amountInt;
    details.scroll_offset = scrollOffset;

    await this.page.evaluate((offset: number) => window.scrollBy(0, offset), scrollOffset);
    await new Promise((resolve) => setTimeout(resolve, 500));

    return { success: true, message: `Scrolled ${direction} by ${Math.abs(amountInt)}px`, details };
  }

  // ===== Enter =====

  private async _enter(_action: ActionDict): Promise<ActionHandlerResult> {
    const details: Record<string, unknown> = { action_type: "enter", target: "focused_element" };
    await this.page.keyboard.press("Enter");
    return { success: true, message: "Pressed Enter on focused element", details };
  }

  // ===== Mouse Control =====

  private async _mouseControl(action: ActionDict): Promise<ActionHandlerResult> {
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
        return { success: true, message: "Action 'click' performed on the target", details };
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
        return { success: true, message: "Action 'right_click' performed on the target", details };
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
        return { success: true, message: "Action 'dblclick' performed on the target", details };
      } else {
        return { success: false, message: `Error: Invalid control action '${control}'`, details };
      }
    } catch (e) {
      return { success: false, message: `Action failed: ${e}`, details };
    }
  }

  // ===== Mouse Drag =====

  private async _mouseDrag(action: ActionDict): Promise<ActionHandlerResult> {
    const fromRef = action.from_ref as string | undefined;
    const toRef = action.to_ref as string | undefined;

    if (!fromRef || !toRef) {
      return {
        success: false,
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
        success: true,
        message: `Dragged from element [ref=${fromRef}] to element [ref=${toRef}]`,
        details,
      };
    } catch (e) {
      return { success: false, message: `Action failed: ${e}`, details };
    }
  }

  // ===== Press Key =====

  private async _pressKey(action: ActionDict): Promise<ActionHandlerResult> {
    const keys = action.keys as string[] | undefined;
    if (!keys || keys.length === 0) {
      return {
        success: false,
        message: "Error: No keys specified",
        details: { action_type: "press_key", keys: "" },
      };
    }

    const combinedKeys = keys.join("+");
    const details: Record<string, unknown> = { action_type: "press_key", keys: combinedKeys };

    try {
      await this.page.keyboard.press(combinedKeys);
      return { success: true, message: "Pressed keys in the browser", details };
    } catch (e) {
      return { success: false, message: `Action failed: ${e}`, details };
    }
  }

  // ===== Navigate =====

  private async _navigate(action: ActionDict): Promise<ActionHandlerResult> {
    const url = action.url as string | undefined;
    if (!url) {
      return { success: false, message: "Error: navigate requires url", details: { error: "missing_url" } };
    }

    const details: Record<string, unknown> = { action_type: "navigate", url };

    try {
      await this.page.goto(url, { timeout: BrowserConfig.navigationTimeout });
      await this.page.waitForLoadState("domcontentloaded");
      return { success: true, message: `Navigated to ${url}`, details };
    } catch (e) {
      details.error = String(e);
      return { success: false, message: `Navigation failed: ${e}`, details };
    }
  }

  // ===== Back / Forward =====

  private async _back(_action: ActionDict): Promise<ActionHandlerResult> {
    const details: Record<string, unknown> = { action_type: "back" };
    try {
      await this.page.goBack({ timeout: BrowserConfig.navigationTimeout });
      return { success: true, message: "Navigated back", details };
    } catch (e) {
      details.error = String(e);
      return { success: false, message: `Back navigation failed: ${e}`, details };
    }
  }

  private async _forward(_action: ActionDict): Promise<ActionHandlerResult> {
    const details: Record<string, unknown> = { action_type: "forward" };
    try {
      await this.page.goForward({ timeout: BrowserConfig.navigationTimeout });
      return { success: true, message: "Navigated forward", details };
    } catch (e) {
      details.error = String(e);
      return { success: false, message: `Forward navigation failed: ${e}`, details };
    }
  }

  // ===== Hover (new — Pinchtab compat) =====

  private async _hover(action: ActionDict): Promise<ActionHandlerResult> {
    const ref = action.ref as string | undefined;
    if (!ref) {
      return { success: false, message: "Error: hover requires ref", details: { error: "missing_ref" } };
    }

    const target = `[aria-ref='${escapeRef(ref)}']`;
    const details: Record<string, unknown> = { ref, target, action_type: "hover" };

    try {
      const count = await this.page.locator(target).count();
      if (count === 0) {
        details.error = "element_not_found";
        return { success: false, message: "Error: Hover failed, element not found", details };
      }

      await this.page.locator(target).first().hover({ timeout: this.defaultTimeout });
      return { success: true, message: `Hovered over ${target}`, details };
    } catch (e) {
      details.error = String(e);
      return { success: false, message: `Hover failed: ${e}`, details };
    }
  }

  // ===== Focus (new — Pinchtab compat) =====

  private async _focus(action: ActionDict): Promise<ActionHandlerResult> {
    const ref = action.ref as string | undefined;
    if (!ref) {
      return { success: false, message: "Error: focus requires ref", details: { error: "missing_ref" } };
    }

    const target = `[aria-ref='${escapeRef(ref)}']`;
    const details: Record<string, unknown> = { ref, target, action_type: "focus" };

    try {
      const count = await this.page.locator(target).count();
      if (count === 0) {
        details.error = "element_not_found";
        return { success: false, message: "Error: Focus failed, element not found", details };
      }

      await this.page.locator(target).first().focus({ timeout: this.defaultTimeout });
      return { success: true, message: `Focused on ${target}`, details };
    } catch (e) {
      details.error = String(e);
      return { success: false, message: `Focus failed: ${e}`, details };
    }
  }

  // ===== Utilities =====

  private _isLikelyLink(diag: ClickElementDiag | null): boolean {
    if (!diag) return false;

    const tag = (diag.tag || "").toLowerCase();
    const role = (diag.role || "").toLowerCase();
    return (
      tag === "a" ||
      role === "link" ||
      !!diag.href ||
      !!diag.closestHref ||
      !!diag.descendantHref
    );
  }

  private async _captureClickObservation(target: Locator): Promise<ClickObservation> {
    const pageUrl = this.page.url();

    const pageState = await this.page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      const activeTag = active?.tagName?.toLowerCase() || "";
      const activeId = active?.id || "";
      const activeRole = active?.getAttribute?.("role") || "";
      const activeRef = active?.getAttribute?.("aria-ref") || "";
      const activeSig = `${activeTag}#${activeId}[role=${activeRole}][ref=${activeRef}]`;

      const count = (selector: string) => document.querySelectorAll(selector).length;

      return {
        activeElement: activeSig,
        dialogCount: count("[role='dialog'], [aria-modal='true']"),
        listboxCount: count("[role='listbox']"),
        menuCount: count("[role='menu'], [role='menuitem'], [role='menuitemradio']"),
        expandedCount: count("[aria-expanded='true']"),
      };
    });

    let targetPresent = false;
    let targetState: ClickTargetState | null = null;

    try {
      const count = await target.count();
      targetPresent = count > 0;
      if (targetPresent) {
        targetState = await target.evaluate((node: Element) => {
          const el = node as HTMLElement;
          const inputLike = node as HTMLInputElement;
          return {
            role: node.getAttribute("role") || "",
            ariaExpanded: node.getAttribute("aria-expanded"),
            ariaSelected: node.getAttribute("aria-selected"),
            ariaPressed: node.getAttribute("aria-pressed"),
            value: inputLike.value || "",
            checked: typeof inputLike.checked === "boolean" ? inputLike.checked : null,
            text: (el.innerText || node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200),
            className: (el.className || "").toString().slice(0, 200),
          };
        });
      }
    } catch {
      targetPresent = false;
      targetState = null;
    }

    return {
      pageUrl,
      activeElement: pageState.activeElement,
      targetPresent,
      targetState,
      dialogCount: pageState.dialogCount,
      listboxCount: pageState.listboxCount,
      menuCount: pageState.menuCount,
      expandedCount: pageState.expandedCount,
    };
  }

  private _didClickObservationChange(before: ClickObservation, after: ClickObservation): boolean {
    if (before.pageUrl !== after.pageUrl) return true;
    if (before.activeElement !== after.activeElement) return true;
    if (before.targetPresent !== after.targetPresent) return true;

    if (before.dialogCount !== after.dialogCount) return true;
    if (before.listboxCount !== after.listboxCount) return true;
    if (before.menuCount !== after.menuCount) return true;
    if (before.expandedCount !== after.expandedCount) return true;

    return JSON.stringify(before.targetState) !== JSON.stringify(after.targetState);
  }

  private _normalizeSelectToken(value: string | null | undefined): string {
    return (value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  private _buildSelectVariants(value: string): string[] {
    const raw = value.trim();
    if (!raw) return [];

    const variants = new Set<string>([raw]);
    const number = raw.match(/\d+/)?.[0];
    if (number) {
      variants.add(number);
      variants.add(`${number} people`);
      variants.add(`${number} person`);
      variants.add(`${number} guests`);
      variants.add(`for ${number}`);
    }
    return Array.from(variants);
  }

  private _matchesVariant(text: string, variant: string): boolean {
    if (!text || !variant) return false;
    if (text === variant) return true;

    if (/^\d+$/.test(variant)) {
      const re = new RegExp(`(^|\\D)${escapeRegex(variant)}(\\D|$)`);
      return re.test(text);
    }
    return text.includes(variant);
  }

  private _stateMatchesExpected(state: SelectState | null, variants: string[]): boolean {
    if (!state || variants.length === 0) return false;

    const normalizedVariants = variants
      .map((v) => this._normalizeSelectToken(v))
      .filter((v) => !!v);
    const fields = [
      state.value,
      state.selectedText,
      state.text,
      state.ariaLabel,
      state.ariaValueText,
    ].map((f) => this._normalizeSelectToken(f));

    return fields.some((field) => normalizedVariants.some((variant) => this._matchesVariant(field, variant)));
  }

  private _valuesMatchExpected(values: string[] | null | undefined, variants: string[]): boolean {
    if (!Array.isArray(values) || values.length === 0 || variants.length === 0) return false;

    const normalizedVariants = variants
      .map((v) => this._normalizeSelectToken(v))
      .filter((v) => !!v);
    const normalizedValues = values
      .map((value) => this._normalizeSelectToken(value))
      .filter((value) => !!value);

    return normalizedValues.some((value) =>
      normalizedVariants.some((variant) => this._matchesVariant(value, variant)),
    );
  }

  private _stateChanged(before: SelectState | null, after: SelectState | null): boolean {
    if (!before || !after) return false;

    return (
      this._normalizeSelectToken(before.value) !== this._normalizeSelectToken(after.value) ||
      this._normalizeSelectToken(before.selectedText) !== this._normalizeSelectToken(after.selectedText) ||
      this._normalizeSelectToken(before.text) !== this._normalizeSelectToken(after.text) ||
      this._normalizeSelectToken(before.ariaValueText) !== this._normalizeSelectToken(after.ariaValueText)
    );
  }

  private async _readSelectState(control: Locator): Promise<SelectState | null> {
    try {
      return await control.evaluate((node: Element) => {
        const el = node as HTMLElement;
        const tagName = (node.tagName || "").toLowerCase();
        const role = node.getAttribute("role") || "";
        const value = (node as HTMLInputElement).value || "";
        const selectedText = tagName === "select"
          ? Array.from(((node as HTMLSelectElement).selectedOptions || []))
            .map((opt) => (opt.textContent || "").trim())
            .filter((txt) => !!txt)
            .join(" ")
          : "";
        const text = (el.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
        const ariaLabel = node.getAttribute("aria-label") || "";
        const ariaValueText = node.getAttribute("aria-valuetext") || "";

        return {
          tagName,
          role,
          value,
          selectedText,
          text,
          ariaLabel,
          ariaValueText,
        };
      });
    } catch {
      return null;
    }
  }

  private async _clickFirstVisible(
    locator: Locator,
    label: string,
    debugLog: Array<Record<string, unknown>>,
  ): Promise<boolean> {
    let count = 0;
    try {
      count = await locator.count();
    } catch (e) {
      debugLog.push({ label, count: 0, error: String(e) });
      return false;
    }

    const inspectCount = Math.min(count, 8);
    for (let i = 0; i < inspectCount; i++) {
      const candidate = locator.nth(i);
      const visible = await candidate.isVisible().catch(() => false);
      if (!visible) continue;

      const enabled = await candidate.isEnabled().catch(() => true);
      if (!enabled) continue;

      try {
        await candidate.click({ timeout: this.shortTimeout });
        debugLog.push({ label, index: i, clicked: true });
        await this.page.waitForTimeout(100);
        return true;
      } catch (e) {
        debugLog.push({ label, index: i, clicked: false, error: String(e) });
      }
    }

    return false;
  }

  private async _selectFromCustomControl(
    control: Locator,
    variants: string[],
    details: Record<string, unknown>,
  ): Promise<boolean> {
    const debugLog: Array<Record<string, unknown>> = [];
    details.custom_attempts = debugLog;

    try {
      await control.click({ timeout: this.defaultTimeout });
      debugLog.push({ step: "open_control", success: true });
      await this.page.waitForTimeout(120);
    } catch (e) {
      debugLog.push({ step: "open_control", success: false, error: String(e) });
      return false;
    }

    for (const variant of variants) {
      const escapedVariant = variant.replace(/["\\]/g, "\\$&");
      const fuzzyName = new RegExp(`\\b${escapeRegex(variant)}\\b`, "i");

      const attempts: Array<{ label: string; locator: Locator }> = [
        { label: `role=option exact "${variant}"`, locator: this.page.getByRole("option", { name: variant, exact: true }) },
        { label: `role=option fuzzy "${variant}"`, locator: this.page.getByRole("option", { name: fuzzyName }) },
        { label: `role=menuitemradio exact "${variant}"`, locator: this.page.getByRole("menuitemradio", { name: variant, exact: true }) },
        { label: `role=menuitemradio fuzzy "${variant}"`, locator: this.page.getByRole("menuitemradio", { name: fuzzyName }) },
        { label: `role=menuitem exact "${variant}"`, locator: this.page.getByRole("menuitem", { name: variant, exact: true }) },
        { label: `role=menuitem fuzzy "${variant}"`, locator: this.page.getByRole("menuitem", { name: fuzzyName }) },
        { label: `role=button exact "${variant}"`, locator: this.page.getByRole("button", { name: variant, exact: true }) },
        { label: `role=button fuzzy "${variant}"`, locator: this.page.getByRole("button", { name: fuzzyName }) },
        { label: `data-value="${variant}"`, locator: this.page.locator(`[data-value="${escapedVariant}"]`) },
        { label: `aria-label="${variant}"`, locator: this.page.locator(`[aria-label="${escapedVariant}"]`) },
        { label: `text exact "${variant}"`, locator: this.page.getByText(variant, { exact: true }) },
        { label: `text fuzzy "${variant}"`, locator: this.page.getByText(fuzzyName) },
      ];

      for (const attempt of attempts) {
        const clicked = await this._clickFirstVisible(attempt.locator, attempt.label, debugLog);
        if (clicked) return true;
      }
    }

    // Last-resort keyboard interaction for focused combobox-like controls
    try {
      await control.focus();
      await control.press("ArrowDown", { timeout: this.shortTimeout });
      await this.page.waitForTimeout(80);
      await control.press("Enter", { timeout: this.shortTimeout });
      debugLog.push({ step: "keyboard_fallback", success: true });
      return true;
    } catch (e) {
      debugLog.push({ step: "keyboard_fallback", success: false, error: String(e) });
      return false;
    }
  }

  private _validCoordinates(xCoord: number, yCoord: number): boolean {
    const viewport = this.page.viewportSize();
    if (!viewport) {
      throw new Error("Viewport size not available from current page.");
    }
    return xCoord >= 0 && xCoord <= viewport.width && yCoord >= 0 && yCoord <= viewport.height;
  }
}
