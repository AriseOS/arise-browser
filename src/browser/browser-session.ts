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

type PageTextMode = "auto" | "raw" | "list" | "article" | "table" | "readability";
type ResolvedPageTextMode = Exclude<PageTextMode, "readability">;

export interface PageModelInput {
  type?: string;
  label?: string;
  placeholder?: string;
  name?: string;
  value?: string;
  context?: string;
}

export interface PageModelCard {
  title: string;
  url?: string;
  price?: string;
  location?: string;
  meta?: string;
}

export interface PageModelListSummary {
  totalResults?: string;
  querySummary?: string;
  visibleCards: number;
  hiddenVisibleCards: number;
  strongCardCount: number;
  score: number;
  cards: PageModelCard[];
}

export interface PageModelTableSummary {
  caption?: string;
  columns: string[];
  rows: string[][];
  visibleRows: number;
  score: number;
  calendarLike: boolean;
}

export interface PageModelArticleSummary {
  title?: string;
  paragraphs: string[];
  score: number;
}

export interface PageModel {
  primaryContent: "result_list" | "table" | "article" | "form" | "generic";
  confidence: number;
  querySummary?: string;
  queryParams: Record<string, string>;
  filtersVisible: boolean;
  visibleInputs: PageModelInput[];
  auxiliarySections: string[];
  listSummary?: PageModelListSummary;
  tableSummary?: PageModelTableSummary;
  articleSummary?: PageModelArticleSummary;
  rawText?: string;
}

function renderListSummary(summary: PageModelListSummary): string {
  const lines = ["Result list summary"];
  if (summary.totalResults) lines.push(`- results: ${summary.totalResults}`);
  if (summary.querySummary) lines.push(`- active query params: ${summary.querySummary}`);
  lines.push(`- visible cards summarized: ${summary.cards.length}`);
  lines.push("");
  lines.push("Visible items:");
  summary.cards.forEach((card, index) => {
    const parts = [`${index + 1}. ${card.title}`];
    if (card.price) parts.push(`price=${card.price}`);
    if (card.location) parts.push(`location=${card.location}`);
    if (card.meta) parts.push(`meta=${card.meta}`);
    if (card.url) parts.push(`url=${card.url}`);
    lines.push(parts.join(" | "));
  });
  if (summary.hiddenVisibleCards > 0) {
    lines.push(`... ${summary.hiddenVisibleCards} more visible cards not expanded`);
  }
  return lines.join("\n");
}

function renderTableSummary(summary: PageModelTableSummary): string {
  const lines = ["Table summary"];
  if (summary.caption) lines.push(`- caption: ${summary.caption}`);
  lines.push(`- columns: ${summary.columns.join(" | ")}`);
  lines.push(`- visible rows summarized: ${Math.min(summary.visibleRows, summary.rows.length)}`);
  lines.push("");
  lines.push("Rows:");
  summary.rows.forEach((row, index) => {
    const pairs = row
      .slice(0, summary.columns.length)
      .map((cell, cellIndex) => `${summary.columns[cellIndex] || `col${cellIndex + 1}`}=${cell}`);
    lines.push(`${index + 1}. ${pairs.join(" | ")}`);
  });
  if (summary.visibleRows > summary.rows.length) {
    lines.push(`... ${summary.visibleRows - summary.rows.length} more visible rows not expanded`);
  }
  return lines.join("\n");
}

function renderArticleSummary(summary: PageModelArticleSummary): string {
  const lines = ["Article summary"];
  if (summary.title) lines.push(`- title: ${summary.title}`);
  lines.push("");
  lines.push(...summary.paragraphs.slice(0, 8));
  if (summary.paragraphs.length > 8) {
    lines.push(`... ${summary.paragraphs.length - 8} more paragraphs not expanded`);
  }
  return lines.join("\n");
}

function renderTextFromPageModel(model: PageModel, mode: ResolvedPageTextMode): string {
  const rawText = model.rawText || "";
  if (mode === "raw") return rawText;
  if (mode === "list") return model.listSummary ? renderListSummary(model.listSummary) : rawText;
  if (mode === "table") return model.tableSummary ? renderTableSummary(model.tableSummary) : rawText;
  if (mode === "article") {
    return model.articleSummary ? renderArticleSummary(model.articleSummary) : rawText;
  }

  if (model.primaryContent === "result_list" && model.listSummary) {
    const summary = renderListSummary(model.listSummary);
    if (model.auxiliarySections.includes("calendar_table")) {
      return `${summary}\n\nAuxiliary sections:\n- calendar availability table detected but not treated as the main content`;
    }
    return summary;
  }
  if (model.primaryContent === "table" && model.tableSummary) {
    return renderTableSummary(model.tableSummary);
  }
  if (model.primaryContent === "article" && model.articleSummary) {
    return renderArticleSummary(model.articleSummary);
  }
  if (model.listSummary) return renderListSummary(model.listSummary);
  if (model.tableSummary) return renderTableSummary(model.tableSummary);
  if (model.articleSummary) return renderArticleSummary(model.articleSummary);
  return rawText;
}

function buildTextExtractionSource(mode: ResolvedPageTextMode): string {
  return `
(() => {
  const requestedMode = ${JSON.stringify(mode)};
  const normalize = function(value, max) {
    const collapsed = String(value || '')
      .replace(/\\u200b/g, ' ')
      .replace(/\\s+/g, ' ')
      .trim();
    if (!max || collapsed.length <= max) return collapsed;
    return collapsed.slice(0, Math.max(0, max - 3)).trimEnd() + '...';
  };

  const normalizeLines = function(value) {
    return String(value || '')
      .split(/\\n+/)
      .map(function(line) { return normalize(line, 0); })
      .filter(Boolean);
  };

  const isVisible = function(element) {
    if (!(element instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    const rect = element.getBoundingClientRect();
    return rect.width >= 1
      && rect.height >= 1
      && rect.bottom > 0
      && rect.right > 0
      && rect.top < (window.innerHeight || document.documentElement.clientHeight) * 1.5;
  };

  const isTimeLikeLine = function(line) {
    return /^(?:<\\s*)?\\d+\\s*(?:m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|week|weeks|mo|month|months)\\s+ago$/i.test(line)
      || /^(?:today|yesterday)$/i.test(line)
      || /^\\d{1,2}:\\d{2}\\s*(?:AM|PM)$/i.test(line);
  };

  const bodyText = normalize(document.body.innerText || document.body.textContent || '', 0);

  const buildQuerySummary = function() {
    try {
      const params = new URL(window.location.href).searchParams;
      const entries = [];
      for (const pair of params.entries()) {
        const key = pair[0];
        const value = pair[1];
        if (!key || key === 'tabId') continue;
        entries.push(value ? key + '=' + normalize(value, 48) : key);
        if (entries.length >= 6) break;
      }
      return entries.length > 0 ? entries.join(', ') : null;
    } catch {
      return null;
    }
  };

  const buildTableSummary = function() {
    const tables = Array.from(document.querySelectorAll('table')).filter(isVisible);
    if (tables.length === 0) return null;

    const candidates = tables
      .map(function(table) {
        const rows = Array.from(table.querySelectorAll('tr'))
          .map(function(row) {
            return Array.from(row.querySelectorAll('th, td'))
              .map(function(cell) { return normalize(cell.innerText || cell.textContent || '', 80); })
              .filter(Boolean);
          })
          .filter(function(row) { return row.length > 0; });
        const header = rows[0] || [];
        const dataRows = rows.slice(header.length > 0 ? 1 : 0);
        return {
          header,
          dataRows,
          score: (header.length * 2) + dataRows.length,
        };
      })
      .filter(function(candidate) { return candidate.header.length >= 2 && candidate.dataRows.length >= 2; })
      .sort(function(a, b) { return b.score - a.score; });

    const best = candidates[0];
    if (!best) return null;

    const lines = [
      'Table summary',
      '- columns: ' + best.header.join(' | '),
      '- visible rows summarized: ' + String(Math.min(best.dataRows.length, 12)),
      '',
      'Rows:',
    ];

    best.dataRows.slice(0, 12).forEach(function(row, index) {
      const pairs = row
        .slice(0, best.header.length)
        .map(function(cell, cellIndex) {
          return (best.header[cellIndex] || ('col' + String(cellIndex + 1))) + '=' + cell;
        });
      lines.push(String(index + 1) + '. ' + pairs.join(' | '));
    });

    if (best.dataRows.length > 12) {
      lines.push('... ' + String(best.dataRows.length - 12) + ' more visible rows not expanded');
    }

    return lines.join('\\n');
  };

  const findCardRoot = function(anchor) {
    let best = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    let current = anchor;
    let depth = 0;
    while (current && current !== document.body && depth < 6) {
      if (isVisible(current)) {
        const text = normalize(current.innerText || current.textContent || '', 900);
        const linkCount = Array.from(current.querySelectorAll('a[href]')).filter(isVisible).length;
        const tag = current.tagName.toLowerCase();
        const rect = current.getBoundingClientRect();
        let score = 0;
        if (text.length >= 24 && text.length <= 800) score += 4;
        if (['article', 'li', 'section', 'tr'].includes(tag)) score += 3;
        if (tag === 'div') score += 1;
        if (linkCount >= 1 && linkCount <= 6) score += 2;
        if (/\\$\\s?\\d[\\d,]*/.test(text)) score += 2;
        if (/(?:^|\\b)(studio|\\d+\\s*br|\\d+\\s*ba|\\d+\\s*ft2|\\d+\\s*beds?|\\d+\\s*baths?)(?:\\b|$)/i.test(text)) {
          score += 2;
        }
        if (rect.width >= 140 && rect.height >= 48) score += 2;

        const parent = current.parentElement;
        if (parent) {
          const siblingCount = Array.from(parent.children).filter(function(child) {
            if (!(child instanceof HTMLElement)) return false;
            if (child.tagName !== current.tagName) return false;
            return isVisible(child) && !!child.querySelector('a[href]');
          }).length;
          if (siblingCount >= 3) score += Math.min(5, siblingCount);
        }

        if (score > bestScore) {
          best = current;
          bestScore = score;
        }
      }
      current = current.parentElement;
      depth += 1;
    }
    return best || anchor;
  };

  const buildListSummary = function(force) {
    const mainRoot =
      document.querySelector("main, [role='main'], #main, .main")
      || document.body;

    const anchors = Array.from(mainRoot.querySelectorAll('a[href]'))
      .filter(function(anchor) { return anchor instanceof HTMLAnchorElement; })
      .filter(function(anchor) {
        if (!isVisible(anchor)) return false;
        const href = normalize(anchor.href, 0);
        const text = normalize(anchor.innerText || anchor.textContent || '', 0);
        if (!href || href.startsWith('javascript:') || href === window.location.href) return false;
        return text.length >= 8;
      });

    const seenRoots = new Set();
    const roots = anchors
      .map(function(anchor) { return findCardRoot(anchor); })
      .filter(function(root) {
        if (seenRoots.has(root)) return false;
        seenRoots.add(root);
        return true;
      })
      .map(function(root) {
        return {
          root,
          top: root.getBoundingClientRect().top + window.scrollY,
          text: normalize(root.innerText || root.textContent || '', 1200),
        };
      })
      .filter(function(entry) { return entry.text.length >= 24; })
      .sort(function(a, b) { return a.top - b.top; });

    const strongCards = roots.filter(function(entry) {
      return /\\$\\s?\\d[\\d,]*/.test(entry.text)
        || /(?:^|\\b)(studio|\\d+\\s*br|\\d+\\s*ba|\\d+\\s*ft2|\\d+\\s*beds?|\\d+\\s*baths?)(?:\\b|$)/i.test(entry.text);
    });

    if (!force && (roots.length < 5 || strongCards.length < Math.min(3, roots.length))) {
      return null;
    }
    if (roots.length === 0) return null;

    const totalResultsMatch = bodyText.match(/\\b\\d+\\s*-\\s*\\d+\\s+of\\s+\\d[\\d,]*\\b/i);
    const querySummary = buildQuerySummary();

    const lines = ['Result list summary'];
    if (totalResultsMatch) lines.push('- results: ' + totalResultsMatch[0]);
    if (querySummary) lines.push('- active query params: ' + querySummary);

    const visibleCards = roots.slice(0, 15).map(function(entry, index) {
      const root = entry.root;
      const fullText = normalize(root.innerText || root.textContent || '', 1400);
      const textLines = normalizeLines(root.innerText || root.textContent || '');
      const visibleLinks = Array.from(root.querySelectorAll('a[href]'))
        .filter(function(link) { return link instanceof HTMLAnchorElement; })
        .filter(isVisible);

      const primaryLink = visibleLinks
        .map(function(link) {
          const text = normalize(link.innerText || link.textContent || '', 180);
          return {
            link,
            text,
            score: Math.min(normalize(link.innerText || link.textContent || '', 0).length, 180),
          };
        })
        .filter(function(candidate) { return candidate.text.length >= 8; })
        .sort(function(a, b) { return b.score - a.score; })[0]?.link || visibleLinks[0] || null;

      const heading = Array.from(root.querySelectorAll('h1, h2, h3, h4, h5, h6'))
        .filter(isVisible)
        .map(function(node) { return normalize(node.innerText || node.textContent || '', 180); })
        .find(Boolean) || '';

      const title = heading || normalize((primaryLink && (primaryLink.innerText || primaryLink.textContent)) || '', 180);
      const priceMatch = fullText.match(/(?:US\\$|\\$)\\s?\\d[\\d,]*(?:\\.\\d{2})?/);
      const price = priceMatch ? priceMatch[0] : '';
      const meta = textLines.find(function(line) {
        return /(?:^|\\b)(studio|\\d+\\s*br|\\d+\\s*ba|\\d+\\s*ft2|\\d+\\s*beds?|\\d+\\s*baths?)(?:\\b|$)/i.test(line);
      }) || '';
      const location = textLines.find(function(line) {
        return line !== title
          && line !== price
          && line !== meta
          && !isTimeLikeLine(line)
          && !/show duplicates/i.test(line)
          && !/^\\d+\\s*-\\s*\\d+\\s+of\\s+\\d+/i.test(line)
          && !/^(?:US\\$|\\$)\\s?\\d[\\d,]*(?:\\.\\d{2})?$/i.test(line)
          && line.length >= 3
          && line.length <= 72;
      }) || '';

      const parts = [String(index + 1) + '. ' + (title || normalize(fullText, 120))];
      if (price) parts.push('price=' + price);
      if (location) parts.push('location=' + location);
      if (meta) parts.push('meta=' + meta);
      if (primaryLink && primaryLink.href) parts.push('url=' + normalize(primaryLink.href, 220));
      return parts.join(' | ');
    });

    lines.push('- visible cards summarized: ' + String(visibleCards.length));
    lines.push('');
    lines.push('Visible items:');
    lines.push.apply(lines, visibleCards);
    if (roots.length > visibleCards.length) {
      lines.push('... ' + String(roots.length - visibleCards.length) + ' more visible cards not expanded');
    }

    return lines.join('\\n');
  };

  const buildArticleSummary = function() {
    const container = document.querySelector("article, main, [role='main']");
    if (!container || !isVisible(container)) return null;

    const paragraphs = Array.from(container.querySelectorAll('p'))
      .filter(isVisible)
      .map(function(node) { return normalize(node.innerText || node.textContent || '', 420); })
      .filter(function(text) { return text.length >= 50; });
    if (paragraphs.length < 3) return null;

    const headingNode = container.querySelector('h1, h2, h3');
    const heading = normalize((headingNode && (headingNode.innerText || headingNode.textContent)) || document.title || '', 180);
    const lines = ['Article summary'];
    if (heading) lines.push('- title: ' + heading);
    lines.push('');
    lines.push.apply(lines, paragraphs.slice(0, 8));
    if (paragraphs.length > 8) {
      lines.push('... ' + String(paragraphs.length - 8) + ' more paragraphs not expanded');
    }
    return lines.join('\\n');
  };

  if (requestedMode === 'raw') return bodyText;
  if (requestedMode === 'table') return buildTableSummary() || bodyText;
  if (requestedMode === 'list') return buildListSummary(true) || bodyText;
  if (requestedMode === 'article') return buildArticleSummary() || bodyText;

  const tableSummary = buildTableSummary();
  if (tableSummary) return tableSummary;
  const listSummary = buildListSummary(false);
  if (listSummary) return listSummary;
  return bodyText;
})()
`.trim();
}

function buildPageModelSource(options?: { includeRawText?: boolean }): string {
  const includeRawText = options?.includeRawText ?? false;
  return `
(() => {
  const includeRawText = ${includeRawText ? "true" : "false"};
  const normalize = function(value, max) {
    const collapsed = String(value || '')
      .replace(/\\u200b/g, ' ')
      .replace(/\\s+/g, ' ')
      .trim();
    if (!max || collapsed.length <= max) return collapsed;
    return collapsed.slice(0, Math.max(0, max - 3)).trimEnd() + '...';
  };
  const normalizeLines = function(value) {
    return String(value || '')
      .split(/\\n+/)
      .map(function(line) { return normalize(line, 0); })
      .filter(Boolean);
  };
  const isVisible = function(element) {
    if (!(element instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    const rect = element.getBoundingClientRect();
    return rect.width >= 1
      && rect.height >= 1
      && rect.bottom > 0
      && rect.right > 0
      && rect.top < (window.innerHeight || document.documentElement.clientHeight) * 1.5;
  };
  const bodyText = normalize(document.body.innerText || document.body.textContent || '', 0);
  const buildQueryData = function() {
    const paramsObject = {};
    const parts = [];
    try {
      const params = new URL(window.location.href).searchParams;
      for (const pair of params.entries()) {
        const key = pair[0];
        const value = pair[1];
        if (!key || key === 'tabId') continue;
        paramsObject[key] = value;
        if (parts.length < 6) {
          parts.push(value ? key + '=' + normalize(value, 48) : key);
        }
      }
    } catch {
      return { summary: undefined, params: {} };
    }
    return { summary: parts.length > 0 ? parts.join(', ') : undefined, params: paramsObject };
  };
  const isTimeLikeLine = function(line) {
    return /^(?:<\\s*)?\\d+\\s*(?:m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|week|weeks|mo|month|months)\\s+ago$/i.test(line)
      || /^(?:today|yesterday)$/i.test(line)
      || /^\\d{1,2}:\\d{2}\\s*(?:AM|PM)$/i.test(line);
  };
  const getAssociatedLabel = function(element) {
    if (!(element instanceof HTMLElement)) return '';
    const ariaLabel = normalize(element.getAttribute('aria-label') || '', 120);
    if (ariaLabel) return ariaLabel;
    const id = element.getAttribute('id');
    if (id) {
      const label = document.querySelector('label[for="' + CSS.escape(id) + '"]');
      if (label instanceof HTMLElement) {
        const text = normalize(label.innerText || label.textContent || '', 120);
        if (text) return text;
      }
    }
    const wrappingLabel = element.closest('label');
    if (wrappingLabel instanceof HTMLElement) {
      const text = normalize(wrappingLabel.innerText || wrappingLabel.textContent || '', 120);
      if (text) return text;
    }
    return '';
  };
  const getContextText = function(element) {
    if (!(element instanceof HTMLElement)) return '';
    const seen = new Set();
    const parts = [];
    let current = element.parentElement;
    let depth = 0;
    while (current && current !== document.body && depth < 5) {
      const directContext = current.querySelector(':scope > legend, :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > .label, :scope > .title, :scope > button, :scope > strong');
      if (directContext instanceof HTMLElement) {
        const text = normalize(directContext.innerText || directContext.textContent || '', 120);
        if (text && !seen.has(text)) {
          seen.add(text);
          parts.push(text);
        }
      }
      const ownText = normalize(current.getAttribute('aria-label') || '', 120);
      if (ownText && !seen.has(ownText)) {
        seen.add(ownText);
        parts.push(ownText);
      }
      current = current.parentElement;
      depth += 1;
    }
    return parts.slice(0, 3).join(' | ');
  };
  const visibleInputs = Array.from(document.querySelectorAll('input, select, textarea'))
    .filter(isVisible)
    .map(function(element) {
      if (!(element instanceof HTMLElement)) return null;
      const result = {
        type: normalize(element.getAttribute('type') || element.tagName || '', 24).toLowerCase(),
        label: getAssociatedLabel(element),
        placeholder: normalize(element.getAttribute('placeholder') || '', 80),
        name: normalize(element.getAttribute('name') || element.getAttribute('id') || '', 80),
        context: getContextText(element),
      };
      if ('value' in element && typeof element.value === 'string') {
        const value = normalize(element.value || '', 80);
        if (value) return { ...result, value };
      }
      return result;
    })
    .filter(Boolean);
  const detectFiltersVisible = function() {
    const bodyClass = normalize(document.body.className || '', 200);
    if (/\\b(?:cl-show-filters|show-filters|filters-open|open-filters)\\b/i.test(bodyClass)) {
      return true;
    }
    const containers = Array.from(document.querySelectorAll("aside, form, [role='complementary'], [class*='filter'], [id*='filter'], [data-testid*='filter'], [data-test*='filter']")).filter(isVisible);
    const hasVisibleApply = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter(isVisible)
      .some(function(node) {
        const text = normalize(node.innerText || node.textContent || '', 80);
        return /^(apply|reset|update search|search)$/i.test(text);
      });
    const strongContainer = containers.some(function(container) {
      const controls = Array.from(container.querySelectorAll('input, select, textarea, button, [role="button"], [role="checkbox"], [role="switch"]')).filter(isVisible);
      const text = normalize(container.innerText || container.textContent || '', 500);
      return controls.length >= 4 && (/\\b(filter|price|rent|beds?|baths?|sqft|square footage|housing type|laundry|parking|pets|amenities|neighborhood)\\b/i.test(text) || /\\b(apply|reset|update search)\\b/i.test(text));
    });
    return strongContainer || (visibleInputs.length >= 4 && hasVisibleApply);
  };
  const buildTableSummary = function() {
    const tables = Array.from(document.querySelectorAll('table')).filter(isVisible);
    if (tables.length === 0) return null;
    const candidates = tables
      .map(function(table) {
        const rows = Array.from(table.querySelectorAll('tr'))
          .map(function(row) {
            return Array.from(row.querySelectorAll('th, td'))
              .map(function(cell) { return normalize(cell.innerText || cell.textContent || '', 80); })
              .filter(Boolean);
          })
          .filter(function(row) { return row.length > 0; });
        const columns = rows[0] || [];
        const dataRows = rows.slice(columns.length > 0 ? 1 : 0);
        const captionNode = table.querySelector('caption');
        const caption = normalize(table.getAttribute('aria-label') || (captionNode && (captionNode.innerText || captionNode.textContent)) || '', 120);
        const weekdayHeaders = columns.filter(function(cell) { return /^(?:s|m|t|w|f|sa|su|sun|mon|tue|wed|thu|fri|sat)$/i.test(cell); }).length;
        const calendarLike = columns.length === 7 && weekdayHeaders >= 6;
        return {
          caption,
          columns,
          rows: dataRows.slice(0, 12),
          visibleRows: dataRows.length,
          calendarLike,
          score: (columns.length * 2) + dataRows.length + (caption ? 2 : 0) - (calendarLike ? 4 : 0),
        };
      })
      .filter(function(candidate) { return candidate.columns.length >= 2 && candidate.visibleRows >= 2; })
      .sort(function(a, b) { return b.score - a.score; });
    return candidates[0] || null;
  };
  const findCardRoot = function(anchor) {
    let best = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    let current = anchor;
    let depth = 0;
    while (current && current !== document.body && depth < 6) {
      if (isVisible(current)) {
        const text = normalize(current.innerText || current.textContent || '', 900);
        const linkCount = Array.from(current.querySelectorAll('a[href]')).filter(isVisible).length;
        const tag = current.tagName.toLowerCase();
        const rect = current.getBoundingClientRect();
        let score = 0;
        if (text.length >= 24 && text.length <= 900) score += 4;
        if (['article', 'li', 'section', 'tr'].includes(tag)) score += 3;
        if (tag === 'div') score += 1;
        if (linkCount >= 1 && linkCount <= 6) score += 2;
        if (/\\$\\s?\\d[\\d,]*/.test(text)) score += 2;
        if (/(?:^|\\b)(studio|\\d+\\s*br|\\d+\\s*ba|\\d+\\s*ft2|\\d+\\s*beds?|\\d+\\s*baths?)(?:\\b|$)/i.test(text)) score += 2;
        if (rect.width >= 140 && rect.height >= 48) score += 2;
        const parent = current.parentElement;
        if (parent) {
          const siblingCount = Array.from(parent.children).filter(function(child) {
            if (!(child instanceof HTMLElement)) return false;
            if (child.tagName !== current.tagName) return false;
            return isVisible(child) && !!child.querySelector('a[href]');
          }).length;
          if (siblingCount >= 3) score += Math.min(5, siblingCount);
        }
        if (score > bestScore) {
          best = current;
          bestScore = score;
        }
      }
      current = current.parentElement;
      depth += 1;
    }
    return best || anchor;
  };
  const buildListSummary = function(force) {
    const mainRoot = document.querySelector("main, [role='main'], #main, .main") || document.body;
    const anchors = Array.from(mainRoot.querySelectorAll('a[href]'))
      .filter(function(anchor) { return anchor instanceof HTMLAnchorElement; })
      .filter(function(anchor) {
        if (!isVisible(anchor)) return false;
        const href = normalize(anchor.href, 0);
        const text = normalize(anchor.innerText || anchor.textContent || '', 0);
        if (!href || href.startsWith('javascript:') || href === window.location.href) return false;
        return text.length >= 8;
      });
    const seenRoots = new Set();
    const roots = anchors
      .map(function(anchor) { return findCardRoot(anchor); })
      .filter(function(root) {
        if (seenRoots.has(root)) return false;
        seenRoots.add(root);
        return true;
      })
      .map(function(root) {
        return { root, top: root.getBoundingClientRect().top + window.scrollY, text: normalize(root.innerText || root.textContent || '', 1200) };
      })
      .filter(function(entry) { return entry.text.length >= 24; })
      .sort(function(a, b) { return a.top - b.top; });
    const strongCards = roots.filter(function(entry) {
      return /\\$\\s?\\d[\\d,]*/.test(entry.text) || /(?:^|\\b)(studio|\\d+\\s*br|\\d+\\s*ba|\\d+\\s*ft2|\\d+\\s*beds?|\\d+\\s*baths?)(?:\\b|$)/i.test(entry.text);
    });
    if (!force && (roots.length < 5 || strongCards.length < Math.min(3, roots.length))) return null;
    if (roots.length === 0) return null;
    const totalResultsMatch = bodyText.match(/\\b\\d+\\s*-\\s*\\d+\\s+of\\s+\\d[\\d,]*\\b/i);
    const queryData = buildQueryData();
    const cards = roots.slice(0, 30).map(function(entry) {
      const root = entry.root;
      const fullText = normalize(root.innerText || root.textContent || '', 1400);
      const textLines = normalizeLines(root.innerText || root.textContent || '');
      const visibleLinks = Array.from(root.querySelectorAll('a[href]')).filter(function(link) { return link instanceof HTMLAnchorElement; }).filter(isVisible);
      const primaryLink = visibleLinks
        .map(function(link) {
          const text = normalize(link.innerText || link.textContent || '', 180);
          return { link, text, score: Math.min(normalize(link.innerText || link.textContent || '', 0).length, 180) };
        })
        .filter(function(candidate) { return candidate.text.length >= 8; })
        .sort(function(a, b) { return b.score - a.score; })[0]?.link || visibleLinks[0] || null;
      const heading = Array.from(root.querySelectorAll('h1, h2, h3, h4, h5, h6')).filter(isVisible).map(function(node) { return normalize(node.innerText || node.textContent || '', 180); }).find(Boolean) || '';
      const title = heading || normalize((primaryLink && (primaryLink.innerText || primaryLink.textContent)) || '', 180);
      const priceMatch = fullText.match(/(?:US\\$|\\$)\\s?\\d[\\d,]*(?:\\.\\d{2})?/);
      const price = priceMatch ? priceMatch[0] : '';
      const meta = textLines.find(function(line) { return /(?:^|\\b)(studio|\\d+\\s*br|\\d+\\s*ba|\\d+\\s*ft2|\\d+\\s*beds?|\\d+\\s*baths?)(?:\\b|$)/i.test(line); }) || '';
      const location = textLines.find(function(line) {
        return line !== title && line !== price && line !== meta && !isTimeLikeLine(line) && !/show duplicates/i.test(line) && !/^\\d+\\s*-\\s*\\d+\\s+of\\s+\\d+/i.test(line) && !/^(?:US\\$|\\$)\\s?\\d[\\d,]*(?:\\.\\d{2})?$/i.test(line) && line.length >= 3 && line.length <= 72;
      }) || '';
      return {
        title: title || normalize(fullText, 120),
        ...(price ? { price } : {}),
        ...(location ? { location } : {}),
        ...(meta ? { meta } : {}),
        ...(primaryLink && primaryLink.href ? { url: normalize(primaryLink.href, 220) } : {}),
      };
    });
    return {
      totalResults: totalResultsMatch ? totalResultsMatch[0] : undefined,
      querySummary: queryData.summary,
      visibleCards: roots.length,
      hiddenVisibleCards: Math.max(0, roots.length - Math.min(roots.length, 30)),
      strongCardCount: strongCards.length,
      score: roots.length + (strongCards.length * 2) + (totalResultsMatch ? 3 : 0),
      cards,
    };
  };
  const buildArticleSummary = function() {
    const container = document.querySelector("article, main, [role='main']");
    if (!container || !isVisible(container)) return null;
    const paragraphs = Array.from(container.querySelectorAll('p')).filter(isVisible).map(function(node) { return normalize(node.innerText || node.textContent || '', 420); }).filter(function(text) { return text.length >= 50; });
    if (paragraphs.length < 3) return null;
    const headingNode = container.querySelector('h1, h2, h3');
    const title = normalize((headingNode && (headingNode.innerText || headingNode.textContent)) || document.title || '', 180);
    return { ...(title ? { title } : {}), paragraphs, score: paragraphs.length * 2 + (title ? 2 : 0) };
  };
  const queryData = buildQueryData();
  const listSummary = buildListSummary(false);
  const tableSummary = buildTableSummary();
  const articleSummary = buildArticleSummary();
  const filtersVisible = detectFiltersVisible();
  const auxiliarySections = [];
  let primaryContent = 'generic';
  let confidence = 0.25;
  if (listSummary && (!tableSummary || tableSummary.calendarLike || listSummary.score >= tableSummary.score + 1)) {
    primaryContent = 'result_list';
    confidence = Math.min(0.98, 0.55 + (listSummary.strongCardCount / Math.max(3, listSummary.cards.length)));
    if (tableSummary) auxiliarySections.push(tableSummary.calendarLike ? 'calendar_table' : 'table');
  } else if (tableSummary && tableSummary.score >= 7) {
    primaryContent = 'table';
    confidence = Math.min(0.95, 0.45 + (tableSummary.score / 30));
  } else if (articleSummary && articleSummary.score >= 8) {
    primaryContent = 'article';
    confidence = Math.min(0.92, 0.4 + (articleSummary.score / 40));
  } else if (filtersVisible && visibleInputs.length >= 3) {
    primaryContent = 'form';
    confidence = 0.6;
  }
  return {
    primaryContent,
    confidence,
    ...(queryData.summary ? { querySummary: queryData.summary } : {}),
    queryParams: queryData.params,
    filtersVisible,
    visibleInputs,
    auxiliarySections,
    ...(listSummary ? { listSummary } : {}),
    ...(tableSummary ? { tableSummary } : {}),
    ...(articleSummary ? { articleSummary } : {}),
    ...(includeRawText ? { rawText: bodyText } : {}),
  };
})()
`.trim();
}

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

interface EvaluationConsoleEntry {
  type: string;
  text: string;
}

interface EvaluationDetailedResult {
  result: unknown;
  console: EvaluationConsoleEntry[];
}

function buildCapturedEvaluationSource(expression: string): string {
  const source = expression.trim();
  const setup = `
const __capture = [];
const __truncate = (value, max = 280) => value.length > max ? value.slice(0, max - 3) + "..." : value;
const __serialize = (value) => {
  if (typeof value === "string") return __truncate(value);
  if (value instanceof Error) return __truncate(value.stack || value.message || String(value));
  try {
    const json = JSON.stringify(value);
    if (typeof json === "string") return __truncate(json);
  } catch {}
  return __truncate(String(value));
};
const __record = (type, args) => {
  if (__capture.length >= 50) return;
  __capture.push({
    type,
    text: __truncate(args.map((arg) => __serialize(arg)).join(" "), 500),
  });
};
const __origConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
  debug: console.debug,
};
for (const __key of Object.keys(__origConsole)) {
  console[__key] = (...args) => {
    __record(__key, args);
  };
}
`;

  const teardown = `
for (const __key of Object.keys(__origConsole)) {
  console[__key] = __origConsole[__key];
}
`;

  if (isLikelySingleExpression(source)) {
    const expr = source.replace(/;$/, "");
    return `(async () => {
${setup}
  try {
    const __result = (${expr});
    return { result: await __result, console: __capture };
  } finally {
${teardown}
  }
})()`;
  }

  return `(async () => {
${setup}
  try {
    const __result = await (async () => {
${source}
    })();
    return { result: __result, console: __capture };
  } finally {
${teardown}
  }
})()`;
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

  /**
   * Try local Chrome first, then Playwright's bundled Chromium.
   * Avoids requiring `npx playwright install` when Chrome is already installed.
   */
  private async _launchStandalone(): Promise<Browser> {
    const headless = this._config.headless ?? true;
    const stealthOpts = {
      args: ['--disable-blink-features=AutomationControlled'],
      ignoreDefaultArgs: ['--enable-automation'],
    };

    // Try local Chrome / Edge first
    for (const channel of ["chrome", "msedge"] as const) {
      try {
        const browser = await chromium.launch({ channel, headless, ...stealthOpts });
        logger.info({ channel }, "Using local browser");
        return browser;
      } catch {
        // Not installed — try next
      }
    }

    // Fall back to Playwright's bundled Chromium
    logger.info("No local Chrome/Edge found — using Playwright Chromium");
    return chromium.launch({ headless, ...stealthOpts });
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

        this._browser = await this._launchStandalone();

        const contextOpts: Record<string, unknown> = {
          viewport,
        };
        if (ua) {
          contextOpts.userAgent = ua;
        }

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
          viewport: managedViewport,
          args: ['--disable-blink-features=AutomationControlled'],
          ignoreDefaultArgs: ['--enable-automation'],
        };
        if (managedUa) {
          contextOpts2.userAgent = managedUa;
        }

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

    this._context.addInitScript(() => {
      // In a normal (non-automated) Chrome, navigator.webdriver is false.
      // Playwright sets it to true. Simply deleting it or setting undefined
      // is detected by fingerprinters like CreepJS, which flag
      // `webdriver === undefined` as suspicious on modern browsers.
      // We must set it to false AND make it non-configurable so CDP
      // cannot re-define it after our init script runs.
      Object.defineProperty(Navigator.prototype, 'webdriver', {
        get: () => false,
        configurable: false,
        enumerable: true,
      });
    });

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

  async getPageModel(
    tabId?: string,
    options?: { includeRawText?: boolean },
  ): Promise<PageModel> {
    const page = await this.getPageForTab(tabId);
    if (!page || page.isClosed()) {
      return {
        primaryContent: "generic",
        confidence: 0,
        queryParams: {},
        filtersVisible: false,
        visibleInputs: [],
        auxiliarySections: [],
        ...(options?.includeRawText ? { rawText: "" } : {}),
      };
    }

    try {
      return await page.evaluate(buildPageModelSource(options));
    } catch (e) {
      logger.warn({ err: e }, "Page model extraction failed");
      return {
        primaryContent: "generic",
        confidence: 0,
        queryParams: {},
        filtersVisible: false,
        visibleInputs: [],
        auxiliarySections: [],
        ...(options?.includeRawText ? { rawText: "" } : {}),
      };
    }
  }

  async getPageText(tabId?: string, mode: PageTextMode = "auto"): Promise<string> {
    try {
      const resolvedMode: ResolvedPageTextMode = mode === "readability" ? "auto" : mode;
      const model = await this.getPageModel(tabId, {
        includeRawText: resolvedMode === "raw" || resolvedMode === "auto",
      });
      return renderTextFromPageModel(model, resolvedMode);
    } catch (e) {
      logger.warn({ err: e }, "Text extraction failed");
      return "";
    }
  }

  // ===== Evaluate =====

  async evaluate(expression: string, tabId?: string): Promise<unknown> {
    const detailed = await this.evaluateDetailed(expression, tabId);
    return detailed.result;
  }

  async evaluateDetailed(
    expression: string,
    tabId?: string,
    options?: { captureConsole?: boolean },
  ): Promise<EvaluationDetailedResult> {
    const page = await this.getPageForTab(tabId);
    if (!page || page.isClosed()) {
      throw new Error("No active page");
    }

    if (options?.captureConsole) {
      const wrappedSource = buildCapturedEvaluationSource(expression);
      const result = await page.evaluate(wrappedSource);
      return result as EvaluationDetailedResult;
    }

    try {
      const result = await page.evaluate(expression);
      return { result, console: [] };
    } catch (error) {
      const fallback = getEvaluationFallback(expression, error);
      if (!fallback) {
        throw error;
      }

      logger.debug({ mode: fallback.mode }, "Retrying evaluation with wrapped function body");
      const result = await page.evaluate(fallback.source);
      return { result, console: [] };
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
