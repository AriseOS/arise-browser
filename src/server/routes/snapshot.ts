import type { FastifyInstance, FastifyRequest } from "fastify";
import type { BrowserSession, PageModel } from "../../browser/browser-session.js";
import { sendRouteError } from "../route-utils.js";

interface SnapshotQuery {
  tabId?: string;
  format?: "yaml" | "json" | "compact" | "text";
  diff?: string;
  viewportLimit?: string;
  semantic?: string;
  filter?: "interactive" | "all";
}

interface SnapshotElement {
  role?: unknown;
  name?: unknown;
  tagName?: unknown;
  disabled?: unknown;
  checked?: unknown;
  expanded?: unknown;
  selected?: unknown;
  level?: unknown;
  href?: unknown;
  value?: unknown;
  placeholder?: unknown;
  ariaLabel?: unknown;
  dialogLabel?: unknown;
  monthLabel?: unknown;
  widget?: unknown;
  contextTrail?: unknown;
  inViewport?: unknown;
  occluded?: unknown;
  receivesPointerEvents?: unknown;
  hasPointerCursor?: unknown;
}

const INTERACTIVE_ROLES = new Set([
  "link",
  "button",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "select",
  "menuitem",
  "tab",
  "switch",
  "slider",
  "spinbutton",
  "searchbox",
  "option",
  "menuitemcheckbox",
  "menuitemradio",
  "treeitem",
]);

const VALUE_ROLES = new Set([
  "textbox",
  "searchbox",
  "combobox",
  "select",
  "spinbutton",
  "slider",
]);

interface CompactEntry {
  ref: string;
  element: SnapshotElement;
  role: string;
  name: string;
  href: string;
  dialogLabel: string;
  widget: string;
  inViewport: boolean;
  occluded: boolean;
  hasValue: boolean;
  selected: boolean;
  expanded: boolean;
}

function extractRoleFromCompactLine(line: string): string | null {
  const trimmed = line.trim();

  // Current unified analyzer format: "- role \"name\" ... [ref=e123]"
  const bulletMatch = trimmed.match(/^-\s+([a-z][a-z0-9_-]*)\b/i);
  if (bulletMatch) return bulletMatch[1].toLowerCase();

  // Legacy compact format compatibility: "[ref=e123] role ..."
  const legacyMatch = trimmed.match(/^\[ref=[^\]]+\]\s*([a-z][a-z0-9_-]*)\b/i);
  if (legacyMatch) return legacyMatch[1].toLowerCase();

  return null;
}

function normalizeText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

function escapeCompactText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function normalizeTextList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => normalizeText(item))
    .filter(Boolean);
}

function parseRefOrder(ref: string): number {
  const match = ref.match(/^e(\d+)$/i);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

function isTruthyFlag(value: unknown): boolean {
  return value === true || value === "true";
}

function compactAccessibleName(role: string, value: string): string {
  let compact = normalizeText(value);
  if (!compact || compact.length < 180 || !["link", "button"].includes(role)) {
    return compact;
  }

  if (/\bselect flight\b/i.test(compact) || /\bround trip total\b/i.test(compact)) {
    compact = compact
      .replace(/\.\s+/g, " | ")
      .replace(/\bUS dollars\b/gi, "USD")
      .replace(/\bround trip total\b/gi, "RT total")
      .replace(/\bTotal duration\b/gi, "duration")
      .replace(/\bLayover \(\d+ of \d+\) is a\b/gi, "layover")
      .replace(/\bSelect flight\b/gi, "")
      .replace(/\s+\|\s+/g, " | ")
      .trim();
  }

  return compact;
}

function isLowInformationLabel(value: string): boolean {
  if (!value) return true;
  if (value.length < 24) return true;
  if (/^\d{1,2}(?:[$\s].*)?$/.test(value)) return true;
  return /^(next|previous|done|reset|close|apply|save)$/i.test(value);
}

function shouldIncludeTag(role: string, tagName: string, displayName: string): boolean {
  if (!tagName) return false;
  if (VALUE_ROLES.has(role)) return true;
  if (role === "link" && tagName !== "a") return true;
  if (role === "button" && tagName !== "button") return true;
  return !displayName;
}

function buildCompactEntries(
  elements: Record<string, unknown>,
  interactiveOnly: boolean,
): CompactEntry[] {
  return Object.entries(elements)
    .filter(([, el]) => el && typeof el === "object")
    .flatMap(([ref, el]) => {
      const element = el as SnapshotElement;
      const role = normalizeText(element.role).toLowerCase();
      if (interactiveOnly && !INTERACTIVE_ROLES.has(role)) {
        return [];
      }

      return [{
        ref,
        element,
        role,
        name: compactAccessibleName(role, normalizeText(element.name)),
        href: normalizeText(element.href),
        dialogLabel: normalizeText(element.dialogLabel),
        widget: normalizeText(element.widget).toLowerCase(),
        inViewport: !("inViewport" in element) || element.inViewport !== false,
        occluded: isTruthyFlag(element.occluded),
        hasValue: normalizeText(element.value).length > 0,
        selected: isTruthyFlag(element.selected),
        expanded: element.expanded !== undefined && element.expanded !== null,
      }];
    });
}

function detectDominantOverlay(entries: CompactEntry[]): { dialogLabel?: string; widget?: string } | null {
  const calendarEntries = entries.filter(
    (entry) => entry.widget === "calendar" && entry.inViewport,
  );
  if (calendarEntries.length >= 3) {
    const dialogLabel = calendarEntries.find((entry) => entry.dialogLabel)?.dialogLabel;
    return { widget: "calendar", ...(dialogLabel ? { dialogLabel } : {}) };
  }

  const dialogCounts = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.dialogLabel || !entry.inViewport || entry.occluded) continue;
    dialogCounts.set(entry.dialogLabel, (dialogCounts.get(entry.dialogLabel) || 0) + 1);
  }

  let bestLabel = "";
  let bestCount = 0;
  for (const [dialogLabel, count] of dialogCounts.entries()) {
    if (count > bestCount) {
      bestLabel = dialogLabel;
      bestCount = count;
    }
  }

  if (!bestLabel) return null;
  return { dialogLabel: bestLabel };
}

function isOverlayEntry(entry: CompactEntry, overlay: { dialogLabel?: string; widget?: string } | null): boolean {
  if (!overlay) return false;
  if (overlay.widget && entry.widget === overlay.widget) return true;
  if (overlay.dialogLabel && entry.dialogLabel === overlay.dialogLabel) return true;
  return false;
}

function shouldKeepEntry(entry: CompactEntry, overlay: { dialogLabel?: string; widget?: string } | null): boolean {
  if (!overlay) return true;
  if (isOverlayEntry(entry, overlay)) return true;
  if (entry.occluded) return false;
  if (VALUE_ROLES.has(entry.role) && entry.hasValue) return true;
  return entry.selected || entry.expanded;
}

function getEntryPriority(entry: CompactEntry, overlay: { dialogLabel?: string; widget?: string } | null): number {
  let priority = 0;
  if (isOverlayEntry(entry, overlay)) priority += 5000;
  if (entry.widget === "calendar") priority += 3000;
  if (entry.dialogLabel) priority += 1800;
  if (entry.selected) priority += 900;
  if (entry.expanded) priority += 800;
  if (VALUE_ROLES.has(entry.role) && entry.hasValue) priority += 700;
  if (entry.inViewport) priority += 250;
  if (!entry.occluded) priority += 120;
  if (entry.occluded) priority -= 500;
  if (entry.role === "button") priority += 80;
  if (entry.role === "textbox" || entry.role === "combobox" || entry.role === "searchbox") {
    priority += 140;
  }
  if (entry.role === "link") priority += 60;
  return priority;
}

function buildCompactLine(
  ref: string,
  element: SnapshotElement,
  semanticMode: boolean,
  options?: { includeLowInfoContext?: boolean },
): string {
  const role = normalizeText(element.role).toLowerCase() || "generic";
  const accessibleNameRaw = normalizeText(element.name);
  const placeholder = normalizeText(element.placeholder);
  const value = normalizeText(element.value);
  const tagName = normalizeText(element.tagName).toLowerCase();
  const href = normalizeText(element.href);
  const ariaLabelRaw = normalizeText(element.ariaLabel);
  const dialogLabel = normalizeText(element.dialogLabel);
  const monthLabel = normalizeText(element.monthLabel);
  const widget = normalizeText(element.widget).toLowerCase();
  const contextTrailRaw = normalizeTextList(element.contextTrail);

  const fallbackName =
    !accessibleNameRaw && ["textbox", "searchbox", "combobox"].includes(role)
      ? placeholder
      : "";
  const displayNameRaw = accessibleNameRaw || fallbackName;
  const displayName = compactAccessibleName(role, displayNameRaw);
  const ariaLabel = compactAccessibleName(role, ariaLabelRaw);
  const lowInfoName = isLowInformationLabel(displayNameRaw || ariaLabelRaw);
  const contextTrail = contextTrailRaw
    .filter((item) => item !== displayNameRaw && item !== ariaLabelRaw)
    .slice(0, lowInfoName ? 2 : 0);

  const parts: string[] = [`- ${role}`];
  if (displayName) {
    parts.push(`"${escapeCompactText(displayName)}"`);
  }

  if (element.disabled === true) parts.push("[disabled]");
  if (element.checked !== undefined && element.checked !== null) {
    parts.push(`checked=${String(element.checked)}`);
  }
  if (element.expanded !== undefined && element.expanded !== null) {
    parts.push(`expanded=${String(element.expanded)}`);
  }
  if (semanticMode && element.selected === true) parts.push("[selected]");
  if (semanticMode && element.occluded === true) parts.push("[occluded]");
  if (semanticMode && element.inViewport === false) parts.push("[viewport=off]");

  const level =
    typeof element.level === "number"
      ? element.level
      : typeof element.level === "string"
        ? Number(element.level)
        : NaN;
  if (Number.isInteger(level) && level > 0) {
    parts.push(`[level=${level}]`);
  }

  parts.push(`[ref=${ref}]`);

  if (element.receivesPointerEvents === true && element.hasPointerCursor === true) {
    parts.push("[cursor=pointer]");
  }

  if (shouldIncludeTag(role, tagName, displayNameRaw)) {
    parts.push(`[tag=${tagName}]`);
  }

  if (placeholder && placeholder !== displayName) {
    parts.push(`[placeholder="${escapeCompactText(placeholder)}"]`);
  }

  if (
    value &&
    value !== displayName &&
    value !== placeholder &&
    !["link", "button"].includes(role)
  ) {
    parts.push(`[value="${escapeCompactText(value)}"]`);
  }

  if (href) {
    parts.push(`-> ${href}`);
  }

  if (
    semanticMode &&
    ariaLabel &&
    ariaLabelRaw !== displayNameRaw &&
    (lowInfoName || VALUE_ROLES.has(role) || role === "tab")
  ) {
    parts.push(`[aria="${escapeCompactText(ariaLabel)}"]`);
  }
  if (semanticMode && widget) {
    parts.push(`[widget=${widget}]`);
  }
  if (semanticMode && monthLabel) {
    parts.push(`[month="${escapeCompactText(monthLabel)}"]`);
  }
  if (semanticMode && dialogLabel) {
    parts.push(`[dialog="${escapeCompactText(dialogLabel)}"]`);
  }
  const shouldIncludeContext =
    contextTrail.length > 0
    && (
      semanticMode
      || (
        options?.includeLowInfoContext === true
        && VALUE_ROLES.has(role)
        && lowInfoName
      )
    );
  if (shouldIncludeContext) {
    parts.push(`[context="${escapeCompactText(contextTrail.join(" | "))}"]`);
  }

  return parts.join(" ");
}

function normalizeHrefKey(value: string): string {
  return value.replace(/#.*$/, "").trim();
}

function isLowSignalResultListEntry(entry: CompactEntry): boolean {
  if (entry.role === "button") {
    return !entry.name && !entry.hasValue && !entry.selected && !entry.expanded;
  }
  if (entry.role === "link") {
    return Boolean(entry.href) && !entry.name;
  }
  return false;
}

interface ResultListGroup {
  href: string;
  refs: string[];
  primaryRef: string;
  title: string;
}

function buildResultListGroups(entries: CompactEntry[]): ResultListGroup[] {
  const byHref = new Map<string, CompactEntry[]>();
  for (const entry of entries) {
    if (entry.role !== "link" || !entry.href) continue;
    const key = normalizeHrefKey(entry.href);
    if (!key) continue;
    const list = byHref.get(key) ?? [];
    list.push(entry);
    byHref.set(key, list);
  }

  return [...byHref.entries()]
    .map(([href, groupEntries]) => {
      const sorted = [...groupEntries].sort((a, b) => b.name.length - a.name.length);
      const named = sorted.find((entry) => entry.name.length >= 8) ?? sorted[0];
      if (!named) return null;
      return {
        href,
        refs: groupEntries.map((entry) => entry.ref),
        primaryRef: named.ref,
        title: named.name || href,
      };
    })
    .filter((group): group is ResultListGroup => Boolean(group));
}

function buildResultListCompactLine(
  group: ResultListGroup,
  pageModel: PageModel | undefined,
): string {
  const matchedCard = pageModel?.listSummary?.cards.find(
    (card) => card.url && normalizeHrefKey(card.url) === group.href,
  );
  const parts = [`- link "${escapeCompactText(matchedCard?.title || group.title)}"`, `[ref=${group.primaryRef}]`];
  if (matchedCard?.price) parts.push(`[price="${escapeCompactText(matchedCard.price)}"]`);
  if (matchedCard?.location) parts.push(`[location="${escapeCompactText(matchedCard.location)}"]`);
  if (matchedCard?.meta) parts.push(`[meta="${escapeCompactText(matchedCard.meta)}"]`);
  parts.push("-> " + group.href);
  return parts.join(" ");
}

function buildCompactSnapshotFromElements(
  elements: Record<string, unknown>,
  interactiveOnly: boolean,
  semanticMode: boolean,
  pageModel?: PageModel,
): string {
  const entries = buildCompactEntries(elements, interactiveOnly);
  const overlay = semanticMode ? detectDominantOverlay(entries) : null;
  const sortEntries = (items: CompactEntry[]): CompactEntry[] =>
    [...items].sort((entryA, entryB) => {
      const priorityA = getEntryPriority(entryA, overlay);
      const priorityB = getEntryPriority(entryB, overlay);
      if (priorityA !== priorityB) return priorityB - priorityA;

      const orderA = parseRefOrder(entryA.ref);
      const orderB = parseRefOrder(entryB.ref);
      if (orderA !== orderB) return orderA - orderB;
      return entryA.ref.localeCompare(entryB.ref);
    });

  const resultListMode =
    !overlay
    && pageModel?.primaryContent === "result_list"
    && (pageModel.listSummary?.cards.length ?? 0) >= 5;

  if (resultListMode) {
    const groups = buildResultListGroups(entries)
      .filter((group) =>
        pageModel?.listSummary?.cards.some(
          (card) => card.url && normalizeHrefKey(card.url) === group.href,
        ),
      );
    const groupedRefs = new Set(groups.flatMap((group) => group.refs));
    const controlLines = sortEntries(entries)
      .filter((entry) => shouldKeepEntry(entry, overlay))
      .filter((entry) => !groupedRefs.has(entry.ref))
      .filter((entry) => !isLowSignalResultListEntry(entry))
      .map((entry) =>
        buildCompactLine(entry.ref, entry.element, semanticMode, {
          includeLowInfoContext: pageModel?.filtersVisible === true,
        }),
      );
    const cardLines = groups.map((group) => buildResultListCompactLine(group, pageModel));
    return [...controlLines, ...cardLines].join("\n");
  }

  return sortEntries(entries)
    .filter((entry) => shouldKeepEntry(entry, overlay))
    .map((entry) =>
      buildCompactLine(entry.ref, entry.element, semanticMode, {
        includeLowInfoContext: pageModel?.filtersVisible === true,
      }),
    )
    .join("\n");
}

export function registerSnapshotRoute(app: FastifyInstance) {
  app.get("/snapshot", async (request: FastifyRequest<{ Querystring: SnapshotQuery }>, reply) => {
    const session = (app as any).session as BrowserSession;
    const { tabId, format = "yaml", diff, viewportLimit, filter } = request.query;

    const diffOnly = diff === "true" || diff === "1";
    const vpLimit = viewportLimit === "true" || viewportLimit === "1";
    const semanticMode = request.query.semantic === "true" || request.query.semantic === "1";
    const interactiveOnly = filter === "interactive";

    try {
      if (format === "json" || (format === "compact" && !diffOnly)) {
        const result = await session.getSnapshotWithElements({ tabId, viewportLimit: vpLimit });
        const elements = result.elements as Record<string, unknown>;
        const pageModel =
          format === "compact"
            ? await session.getPageModel(tabId, { includeRawText: false }).catch(() => undefined)
            : undefined;

        if (format === "compact") {
          const compactText = buildCompactSnapshotFromElements(
            elements,
            interactiveOnly,
            semanticMode,
            pageModel,
          );
          if (compactText) {
            return reply.type("text/plain").send(compactText);
          }
        }

        // Convert to Pinchtab JSON format
        const nodes: Record<string, unknown>[] = [];
        let count = 0;
        if (elements && typeof elements === "object") {
          for (const [ref, el] of Object.entries(elements)) {
            if (el && typeof el === "object") {
              const elObj = el as Record<string, unknown>;
              if (interactiveOnly && !INTERACTIVE_ROLES.has(String(elObj.role || ""))) {
                continue;
              }
              nodes.push({ ref, ...elObj });
              count++;
            }
          }
        }

        const info = await session.getPageInfo(tabId);
        return {
          nodes,
          url: info.url,
          title: info.title,
          count,
        };
      }

      // yaml / compact / text all return the snapshot text
      const snapshotText = await session.getSnapshot({
        tabId,
        diffOnly,
        viewportLimit: vpLimit,
      });

      if (format === "compact") {
        let lines = snapshotText
          .split("\n")
          .filter((l) => l.includes("[ref="))
          .map((l) => l.trim());
        if (interactiveOnly) {
          lines = lines.filter((l) => {
            const role = extractRoleFromCompactLine(l);
            return role ? INTERACTIVE_ROLES.has(role) : false;
          });
        }
        return reply.type("text/plain").send(lines.join("\n"));
      }

      if (format === "text") {
        return reply.type("text/plain").send(snapshotText);
      }

      // Default: yaml
      return { snapshot: snapshotText, format: "yaml" };
    } catch (e) {
      return sendRouteError(reply, e, "Snapshot capture failed");
    }
  });
}
