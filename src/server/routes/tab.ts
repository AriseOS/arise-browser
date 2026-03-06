import type { FastifyInstance, FastifyRequest } from "fastify";
import type { BrowserSession } from "../../browser/browser-session.js";
import { getTabWriteConflict, sendRouteError, sendTabLocked } from "../route-utils.js";

interface TabBody {
  action: "create" | "close" | "switch";
  tabId?: string;
  url?: string;
  owner?: string;
}

export function registerTabRoute(app: FastifyInstance) {
  app.post("/tab", async (request: FastifyRequest<{ Body: TabBody }>, reply) => {
    const session = (app as any).session as BrowserSession;
    const { action, tabId, url, owner } = request.body || {} as TabBody;

    if (!action) {
      return reply.code(400).send({ error: "action is required (create, close, switch)" });
    }

    try {
      switch (action) {
        case "create": {
          const [newTabId] = await session.createNewTab(url);
          await session.switchToTab(newTabId);
          return { tabId: newTabId, action: "created" };
        }

        case "close": {
          if (!tabId) {
            return reply.code(400).send({ error: "tabId is required for close" });
          }
          const conflict = getTabWriteConflict(session, { tabId, owner });
          if (conflict) {
            return sendTabLocked(reply, conflict);
          }
          const closed = await session.closeTab(tabId);
          return { tabId, action: "closed", success: closed };
        }

        case "switch": {
          if (!tabId) {
            return reply.code(400).send({ error: "tabId is required for switch" });
          }
          const conflict = getTabWriteConflict(session, { tabId, owner });
          if (conflict) {
            return sendTabLocked(reply, conflict);
          }
          const switched = await session.switchToTab(tabId);
          return { tabId, action: "switched", success: switched };
        }

        default:
          return reply.code(400).send({ error: `Unknown action: ${action}` });
      }
    } catch (e) {
      return sendRouteError(reply, e, "Tab operation failed");
    }
  });
}
