import type { FastifyInstance, FastifyRequest } from "fastify";
import type { BrowserSession } from "../../browser/browser-session.js";

interface UploadBody {
  ref: string;
  filePath: string;
}

export function registerUploadRoute(app: FastifyInstance) {
  app.post("/upload", async (request: FastifyRequest<{ Body: UploadBody }>, reply) => {
    const session = (app as any).session as BrowserSession;
    const { ref, filePath } = request.body || {} as UploadBody;

    if (!ref || !filePath) {
      return reply.code(400).send({ error: "ref and filePath are required" });
    }

    const page = session.currentPage;
    if (!page || page.isClosed()) {
      return reply.code(500).send({ error: "No active page" });
    }

    try {
      const target = `[aria-ref='${ref.replace(/['"\\]/g, "")}']`;
      const fileInput = page.locator(target);

      if ((await fileInput.count()) === 0) {
        return reply.code(404).send({ error: "File input element not found" });
      }

      await fileInput.setInputFiles(filePath);
      return { success: true, ref, filePath };
    } catch (e) {
      return reply.code(500).send({ error: String(e) });
    }
  });
}
