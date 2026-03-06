import type { FastifyInstance, FastifyRequest } from "fastify";
import type { BrowserSession } from "../../browser/browser-session.js";
import { getTabWriteConflict, sendRouteError, sendTabLocked } from "../route-utils.js";

interface UploadBody {
  ref: string;
  filePath: string;
  tabId?: string;
  owner?: string;
}

export function registerUploadRoute(app: FastifyInstance) {
  app.post("/upload", async (request: FastifyRequest<{ Body: UploadBody }>, reply) => {
    const session = (app as any).session as BrowserSession;
    const { ref, filePath, tabId, owner } = request.body || {} as UploadBody;

    if (!ref || !filePath) {
      return reply.code(400).send({ error: "ref and filePath are required" });
    }

    const conflict = getTabWriteConflict(session, { tabId, owner });
    if (conflict) {
      return sendTabLocked(reply, conflict);
    }

    try {
      const page = await session.getPageForTab(tabId);
      if (!page || page.isClosed()) {
        return reply.code(400).send({ error: "No active page" });
      }

      const target = `[aria-ref='${ref.replace(/['"\\]/g, "")}']`;
      const fileInput = page.locator(target);

      if ((await fileInput.count()) === 0) {
        return reply.code(404).send({ error: "File input element not found" });
      }

      const inputMeta = await fileInput.first().evaluate((node: Element) => ({
        tagName: node.tagName.toLowerCase(),
        inputType: node instanceof HTMLInputElement ? node.type.toLowerCase() : "",
      }));
      if (inputMeta.tagName !== "input" || inputMeta.inputType !== "file") {
        return reply.code(400).send({ error: "Target element is not an <input type=\"file\">" });
      }

      await fileInput.setInputFiles(filePath);
      return { success: true, ref, filePath, tabId };
    } catch (e) {
      return sendRouteError(reply, e, "Upload failed");
    }
  });
}
