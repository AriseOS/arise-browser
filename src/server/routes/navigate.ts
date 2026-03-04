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

    try {
      if (newTab) {
        const [tabId] = await session.createNewTab(url);
        await session.switchToTab(tabId);
        const page = session.currentPage;
        let title = "";
        try { title = page && !page.isClosed() ? await page.title() : ""; } catch { /* closed */ }
        return { tabId, url: page && !page.isClosed() ? page.url() : url, title };
      }

      await session.visit(url);
      const page = session.currentPage;
      let title = "";
      try { title = page && !page.isClosed() ? await page.title() : ""; } catch { /* closed */ }
      return { url: page && !page.isClosed() ? page.url() : url, title };
    } catch (e) {
      return reply.code(500).send({ error: "Navigation failed" });
    }
  });
}
