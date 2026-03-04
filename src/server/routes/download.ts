import { readFile, unlink } from "node:fs/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { BrowserSession } from "../../browser/browser-session.js";

interface DownloadQuery {
  timeout?: string;
}

export function registerDownloadRoute(app: FastifyInstance) {
  app.get("/download", async (request: FastifyRequest<{ Querystring: DownloadQuery }>, reply) => {
    const session = (app as any).session as BrowserSession;
    const { timeout = "30000" } = request.query;

    const page = session.currentPage;
    if (!page || page.isClosed()) {
      return reply.code(500).send({ error: "No active page" });
    }

    try {
      const download = await page.waitForEvent("download", {
        timeout: parseInt(timeout, 10) || 30000,
      });

      const filePath = await download.path();
      const suggestedFilename = download.suggestedFilename();

      if (!filePath) {
        return reply.code(500).send({ error: "Download failed — no file path" });
      }

      // Async read + cleanup temp file
      const buffer = await readFile(filePath);
      unlink(filePath).catch(() => {}); // best effort cleanup

      // Sanitize filename for Content-Disposition header
      const safeFilename = suggestedFilename.replace(/["\\]/g, "_");

      return reply
        .header("Content-Disposition", `attachment; filename="${safeFilename}"`)
        .type("application/octet-stream")
        .send(buffer);
    } catch (e) {
      return reply.code(500).send({ error: "Download failed" });
    }
  });
}
