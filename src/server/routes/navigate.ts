import type { FastifyInstance, FastifyRequest } from "fastify";
import type { BrowserSession } from "../../browser/browser-session.js";
import { getTabWriteConflict, sendRouteError, sendTabLocked } from "../route-utils.js";

interface NavigateBody {
  url: string;
  newTab?: boolean;
  timeout?: number;
  tabId?: string;
  owner?: string;
}

export function registerNavigateRoute(app: FastifyInstance) {
  app.post("/navigate", async (request: FastifyRequest<{ Body: NavigateBody }>, reply) => {
    const session = (app as any).session as BrowserSession;
    const { url, newTab, timeout, tabId, owner } = request.body || {} as NavigateBody;

    if (!url) {
      return reply.code(400).send({ error: "url is required" });
    }

    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
      return reply.code(400).send({ error: "timeout must be a positive number" });
    }

    try {
      if (newTab) {
        const [newTabId] = await session.createNewTab(url, { timeout });
        await session.switchToTab(newTabId);
        const info = await session.getPageInfo(newTabId);
        return { tabId: newTabId, url: info.url || url, title: info.title };
      }

      const conflict = getTabWriteConflict(session, { tabId, owner });
      if (conflict) {
        return sendTabLocked(reply, conflict);
      }

      await session.visit(url, { tabId, timeout });
      const info = await session.getPageInfo(tabId);
      return {
        tabId: info.tabId,
        url: info.url || url,
        title: info.title,
      };
    } catch (e) {
      return sendRouteError(reply, e, "Navigation failed");
    }
  });
}
