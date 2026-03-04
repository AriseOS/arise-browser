import type { FastifyInstance } from "fastify";
import type { BrowserSession } from "../../browser/browser-session.js";

export function registerTabsRoute(app: FastifyInstance) {
  app.get("/tabs", async () => {
    const session = (app as any).session as BrowserSession;
    const tabs = await session.getTabInfo();
    return { tabs };
  });
}
