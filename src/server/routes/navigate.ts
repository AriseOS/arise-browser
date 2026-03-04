import type { FastifyInstance, FastifyRequest } from "fastify";
import type { BrowserSession } from "../../browser/browser-session.js";

interface NavigateBody {
  url: string;
  newTab?: boolean;
  timeout?: number;
}

export function registerNavigateRoute(app: FastifyInstance) {
  app.post("/navigate", async (request: FastifyRequest<{ Body: NavigateBody }>, reply) => {
    const session = (app as any).session as BrowserSession;
    const { url, newTab } = request.body || {} as NavigateBody;

    if (!url) {
      return reply.code(400).send({ error: "url is required" });
    }

    if (newTab) {
      const [tabId] = await session.createNewTab(url);
      await session.switchToTab(tabId);
      return { tabId, url };
    }

    const result = await session.visit(url);
    return { message: result, url };
  });
}
