import type { FastifyInstance, FastifyRequest } from "fastify";
import type { BrowserSession } from "../../browser/browser-session.js";
import { sendRouteError } from "../route-utils.js";

interface PageModelQuery {
  tabId?: string;
  includeRawText?: string;
}

export function registerPageModelRoute(app: FastifyInstance) {
  app.get(
    "/page-model",
    async (request: FastifyRequest<{ Querystring: PageModelQuery }>, reply) => {
      const session = (app as any).session as BrowserSession;
      const { tabId, includeRawText } = request.query;
      try {
        const model = await session.getPageModel(tabId, {
          includeRawText: includeRawText === "true" || includeRawText === "1",
        });
        const info = await session.getPageInfo(tabId);
        return {
          model,
          url: info.url,
          title: info.title,
        };
      } catch (e) {
        return sendRouteError(reply, e, "Failed to build page model");
      }
    },
  );
}
