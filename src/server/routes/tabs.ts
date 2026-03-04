import type { FastifyInstance } from "fastify";
import type { BrowserSession } from "../../browser/browser-session.js";

export function registerTabsRoute(app: FastifyInstance) {
  app.get("/tabs", async (_request, reply) => {
    const session = (app as any).session as BrowserSession;
    try {
      const tabs = await session.getTabInfo();
      return { tabs };
    } catch (e) {
      return reply.code(500).send({ error: "Failed to get tab info" });
    }
  });
}
