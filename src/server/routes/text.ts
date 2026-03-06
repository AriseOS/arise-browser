import type { FastifyInstance, FastifyRequest } from "fastify";
import type { BrowserSession } from "../../browser/browser-session.js";
import { sendRouteError } from "../route-utils.js";

interface TextQuery {
  tabId?: string;
}

export function registerTextRoute(app: FastifyInstance) {
  app.get("/text", async (request: FastifyRequest<{ Querystring: TextQuery }>, reply) => {
    const session = (app as any).session as BrowserSession;
    const { tabId } = request.query;
    try {
      const text = await session.getPageText(tabId);
      const info = await session.getPageInfo(tabId);
      return {
        text,
        url: info.url,
        title: info.title,
      };
    } catch (e) {
      return sendRouteError(reply, e, "Failed to extract text");
    }
  });
}
