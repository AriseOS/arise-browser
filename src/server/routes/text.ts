import type { FastifyInstance } from "fastify";
import type { BrowserSession } from "../../browser/browser-session.js";

export function registerTextRoute(app: FastifyInstance) {
  app.get("/text", async () => {
    const session = (app as any).session as BrowserSession;
    const text = await session.getPageText();
    const page = session.currentPage;
    return {
      text,
      url: page ? page.url() : "",
      title: page ? await page.title() : "",
    };
  });
}
