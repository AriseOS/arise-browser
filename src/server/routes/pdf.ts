import type { FastifyInstance, FastifyRequest } from "fastify";
import type { BrowserSession } from "../../browser/browser-session.js";
import { sendRouteError } from "../route-utils.js";

interface PdfQuery {
  tabId?: string;
}

export function registerPdfRoute(app: FastifyInstance) {
  app.get("/pdf", async (request: FastifyRequest<{ Querystring: PdfQuery }>, reply) => {
    const session = (app as any).session as BrowserSession;
    const { tabId } = request.query;

    try {
      const buffer = await session.exportPdf(tabId);

      if (!buffer) {
        return reply.code(500).send({ error: "PDF export failed" });
      }

      return reply
        .type("application/pdf")
        .send(buffer);
    } catch (e) {
      return sendRouteError(reply, e, "PDF export failed", 400);
    }
  });
}
