import type { FastifyReply } from "fastify";
import type { BrowserSession } from "../browser/browser-session.js";
import { getLock } from "../lock.js";
import type { TabLock } from "../types/index.js";

export interface TabWriteConflict {
  tabId: string;
  lock: TabLock;
}

export function resolveTargetTabId(session: BrowserSession, tabId?: string): string | undefined {
  return tabId || session.currentTabId || undefined;
}

export function getTabWriteConflict(
  session: BrowserSession,
  options: { tabId?: string; owner?: string },
): TabWriteConflict | null {
  const tabId = resolveTargetTabId(session, options.tabId);
  if (!tabId) {
    return null;
  }

  const lock = getLock(tabId);
  if (!lock || lock.owner === options.owner) {
    return null;
  }

  return { tabId, lock };
}

export function sendTabLocked(reply: FastifyReply, conflict: TabWriteConflict) {
  return reply.code(423).send({
    error: "Tab is locked",
    tabId: conflict.tabId,
    lock: conflict.lock,
  });
}

export function sendRouteError(
  reply: FastifyReply,
  error: unknown,
  fallbackMessage: string,
  fallbackStatus = 500,
) {
  const message = error instanceof Error ? error.message : String(error);

  if (message.startsWith("Tab not found:")) {
    return reply.code(404).send({ error: message });
  }

  if (message === "No active page") {
    return reply.code(400).send({ error: message });
  }

  return reply.code(fallbackStatus).send({ error: fallbackMessage, detail: message });
}
