import type { FastifyInstance } from "fastify";
import type { BrowserSession } from "../../browser/browser-session.js";

export function registerTextRoute(app: FastifyInstance) {
  app.get("/text", async (_request, reply) => {
    const session = (app as any).session as BrowserSession;
    try {
      const text = await session.getPageText();
      const page = session.currentPage;
      let title = "";
      try { title = page && !page.isClosed() ? await page.title() : ""; } catch { /* closed */ }
      return {
        text,
        url: page && !page.isClosed() ? page.url() : "",
        title,
      };
    } catch (e) {
      return reply.code(500).send({ error: "Failed to extract text" });
    }
  });
}
