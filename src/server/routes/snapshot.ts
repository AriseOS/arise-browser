import type { FastifyInstance, FastifyRequest } from "fastify";
import type { BrowserSession } from "../../browser/browser-session.js";

interface SnapshotQuery {
  tabId?: string;
  format?: "yaml" | "json" | "compact" | "text";
  diff?: string;
  viewportLimit?: string;
}

export function registerSnapshotRoute(app: FastifyInstance) {
  app.get("/snapshot", async (request: FastifyRequest<{ Querystring: SnapshotQuery }>, reply) => {
    const session = (app as any).session as BrowserSession;
    const { format = "yaml", diff, viewportLimit } = request.query;

    const diffOnly = diff === "true" || diff === "1";
    const vpLimit = viewportLimit === "true" || viewportLimit === "1";

    try {
      if (format === "json") {
        const result = await session.getSnapshotWithElements({ viewportLimit: vpLimit });
        const elements = result.elements as Record<string, unknown>;

        // Convert to Pinchtab JSON format
        const nodes: Record<string, unknown>[] = [];
        let count = 0;
        if (elements && typeof elements === "object") {
          for (const [ref, el] of Object.entries(elements)) {
            if (el && typeof el === "object") {
              nodes.push({ ref, ...(el as Record<string, unknown>) });
              count++;
            }
          }
        }

        const page = session.currentPage;
        let title = "";
        try { title = page && !page.isClosed() ? await page.title() : ""; } catch { /* closed */ }
        return {
          nodes,
          url: page && !page.isClosed() ? page.url() : "",
          title,
          count,
        };
      }

      // yaml / compact / text all return the snapshot text
      const snapshotText = await session.getSnapshot({
        diffOnly,
        viewportLimit: vpLimit,
      });

      if (format === "compact") {
        const lines = snapshotText
          .split("\n")
          .filter((l) => l.includes("[ref="))
          .map((l) => l.trim());
        return { snapshot: lines.join("\n"), format: "compact" };
      }

      if (format === "text") {
        return { snapshot: snapshotText, format: "text" };
      }

      // Default: yaml
      return { snapshot: snapshotText, format: "yaml" };
    } catch (e) {
      return reply.code(500).send({ error: "Snapshot capture failed" });
    }
  });
}
