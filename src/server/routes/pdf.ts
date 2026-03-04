import type { FastifyInstance } from "fastify";
import type { BrowserSession } from "../../browser/browser-session.js";

export function registerPdfRoute(app: FastifyInstance) {
  app.get("/pdf", async (_request, reply) => {
    const session = (app as any).session as BrowserSession;

    try {
      const buffer = await session.exportPdf();

      if (!buffer) {
        return reply.code(500).send({ error: "PDF export failed" });
      }

      return reply
        .type("application/pdf")
        .send(buffer);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "PDF export failed";
      return reply.code(400).send({ error: msg });
    }
  });
}
