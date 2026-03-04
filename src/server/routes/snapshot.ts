import type { FastifyInstance, FastifyRequest } from "fastify";
import type { BrowserSession } from "../../browser/browser-session.js";

interface SnapshotQuery {
  tabId?: string;
  format?: "yaml" | "json" | "compact" | "text";
  diff?: string;
  viewportLimit?: string;
  filter?: "interactive" | "all";
}

export function registerSnapshotRoute(app: FastifyInstance) {
  app.get("/snapshot", async (request: FastifyRequest<{ Querystring: SnapshotQuery }>, reply) => {
    const session = (app as any).session as BrowserSession;
    const { format = "yaml", diff, viewportLimit, filter } = request.query;

    const diffOnly = diff === "true" || diff === "1";
    const vpLimit = viewportLimit === "true" || viewportLimit === "1";
    const interactiveOnly = filter === "interactive";

    try {
      if (format === "json") {
        const result = await session.getSnapshotWithElements({ viewportLimit: vpLimit });
        const elements = result.elements as Record<string, unknown>;

        // Convert to Pinchtab JSON format
        const INTERACTIVE_ROLES = new Set([
          "link", "button", "textbox", "checkbox", "radio",
          "combobox", "menuitem", "tab", "switch", "slider",
          "spinbutton", "searchbox", "option", "menuitemcheckbox",
          "menuitemradio", "treeitem",
        ]);

        const nodes: Record<string, unknown>[] = [];
        let count = 0;
        if (elements && typeof elements === "object") {
          for (const [ref, el] of Object.entries(elements)) {
            if (el && typeof el === "object") {
              const elObj = el as Record<string, unknown>;
              if (interactiveOnly && !INTERACTIVE_ROLES.has(String(elObj.role || ""))) {
                continue;
              }
              nodes.push({ ref, ...elObj });
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
        let lines = snapshotText
          .split("\n")
          .filter((l) => l.includes("[ref="))
          .map((l) => l.trim());
        if (interactiveOnly) {
          lines = lines.filter((l) => {
            const m = l.match(/^\[ref=\w+\]\s*(\w+)/);
            return m && ["link", "button", "textbox", "checkbox", "radio",
              "combobox", "menuitem", "tab", "switch", "slider",
              "spinbutton", "searchbox", "option"].includes(m[1]);
          });
        }
        return reply.type("text/plain").send(lines.join("\n"));
      }

      if (format === "text") {
        return reply.type("text/plain").send(snapshotText);
      }

      // Default: yaml
      return { snapshot: snapshotText, format: "yaml" };
    } catch (e) {
      return reply.code(500).send({ error: "Snapshot capture failed" });
    }
  });
}
