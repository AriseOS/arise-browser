import type { FastifyInstance, FastifyRequest } from "fastify";
import type { BrowserSession } from "../../browser/browser-session.js";

interface SnapshotQuery {
  tabId?: string;
  format?: "yaml" | "json" | "compact" | "text";
  diff?: string;
  viewportLimit?: string;
}

export function registerSnapshotRoute(app: FastifyInstance) {
  app.get("/snapshot", async (request: FastifyRequest<{ Querystring: SnapshotQuery }>) => {
    const session = (app as any).session as BrowserSession;
    const { format = "yaml", diff, viewportLimit } = request.query;

    const diffOnly = diff === "true" || diff === "1";
    const vpLimit = viewportLimit === "true" || viewportLimit === "1";

    if (format === "json") {
      const result = await session.getSnapshotWithElements({ viewportLimit: vpLimit });
      const snapshotText = result.snapshotText as string;
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
      return {
        nodes,
        url: page ? page.url() : "",
        title: page ? await page.title() : "",
        count,
      };
    }

    // yaml / compact / text all return the snapshot text
    const snapshotText = await session.getSnapshot({
      diffOnly,
      viewportLimit: vpLimit,
    });

    if (format === "compact") {
      // Strip YAML formatting, one node per line
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
  });
}
