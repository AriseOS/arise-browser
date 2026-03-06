import type { FastifyInstance, FastifyRequest } from "fastify";
import type { BrowserSession } from "../../browser/browser-session.js";
import { sendRouteError } from "../route-utils.js";

interface ScreenshotQuery {
  tabId?: string;
  quality?: string;
  raw?: string;
}

export function registerScreenshotRoute(app: FastifyInstance) {
  app.get("/screenshot", async (request: FastifyRequest<{ Querystring: ScreenshotQuery }>, reply) => {
    const session = (app as any).session as BrowserSession;
    const { tabId, quality = "75", raw } = request.query;

    try {
      const buffer = await session.takeScreenshot({
        tabId,
        type: "jpeg",
        quality: Math.min(100, Math.max(1, parseInt(quality) || 75)),
      });

      if (!buffer) {
        return reply.code(500).send({ error: "Screenshot failed" });
      }

      const acceptHeader = request.headers.accept || "";
      const wantsRaw = raw === "true" || raw === "1" || acceptHeader.includes("image/");
      if (wantsRaw) {
        return reply
          .type("image/jpeg")
          .send(buffer);
      }

      return {
        image: `data:image/jpeg;base64,${buffer.toString("base64")}`,
        format: "jpeg",
      };
    } catch (e) {
      return sendRouteError(reply, e, "Screenshot failed");
    }
  });
}
