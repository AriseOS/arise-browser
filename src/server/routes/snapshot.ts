import type { FastifyInstance, FastifyRequest } from "fastify";
import type { BrowserSession } from "../../browser/browser-session.js";
import { sendRouteError } from "../route-utils.js";

interface SnapshotQuery {
  tabId?: string;
  format?: "yaml" | "json" | "compact" | "text";
  diff?: string;
  viewportLimit?: string;
  filter?: "interactive" | "all";
}

interface SnapshotElement {
  role?: unknown;
  name?: unknown;
  tagName?: unknown;
  disabled?: unknown;
  checked?: unknown;
  expanded?: unknown;
  level?: unknown;
  href?: unknown;
  value?: unknown;
  placeholder?: unknown;
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

function parseRefOrder(ref: string): number {
  const match = ref.match(/^e(\d+)$/i);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

function buildCompactLine(ref: string, element: SnapshotElement): string {
  const role = normalizeText(element.role).toLowerCase() || "generic";
  const accessibleName = normalizeText(element.name);
  const placeholder = normalizeText(element.placeholder);
  const value = normalizeText(element.value);
  const tagName = normalizeText(element.tagName).toLowerCase();
  const href = normalizeText(element.href);

  const fallbackName =
    !accessibleName && ["textbox", "searchbox", "combobox"].includes(role)
      ? placeholder
      : "";
  const displayName = accessibleName || fallbackName;

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

  if (
    tagName &&
    (tagName !== role ||
      !displayName ||
      role === "combobox" ||
      role === "textbox" ||
      role === "searchbox")
  ) {
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

  return parts.join(" ");
}

function buildCompactSnapshotFromElements(
  elements: Record<string, unknown>,
  interactiveOnly: boolean,
): string {
  const lines = Object.entries(elements)
    .filter(([, el]) => el && typeof el === "object")
    .sort(([refA], [refB]) => {
      const orderA = parseRefOrder(refA);
      const orderB = parseRefOrder(refB);
      if (orderA !== orderB) return orderA - orderB;
      return refA.localeCompare(refB);
    })
    .flatMap(([ref, el]) => {
      const element = el as SnapshotElement;
      const role = normalizeText(element.role).toLowerCase();
      if (interactiveOnly && !INTERACTIVE_ROLES.has(role)) {
        return [];
      }
      return [buildCompactLine(ref, element)];
    });

  return lines.join("\n");
}

export function registerSnapshotRoute(app: FastifyInstance) {
  app.get("/snapshot", async (request: FastifyRequest<{ Querystring: SnapshotQuery }>, reply) => {
    const session = (app as any).session as BrowserSession;
    const { tabId, format = "yaml", diff, viewportLimit, filter } = request.query;

    const diffOnly = diff === "true" || diff === "1";
    const vpLimit = viewportLimit === "true" || viewportLimit === "1";
    const interactiveOnly = filter === "interactive";

    try {
      if (format === "json" || (format === "compact" && !diffOnly)) {
        const result = await session.getSnapshotWithElements({ tabId, viewportLimit: vpLimit });
        const elements = result.elements as Record<string, unknown>;

        if (format === "compact") {
          const compactText = buildCompactSnapshotFromElements(elements, interactiveOnly);
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
