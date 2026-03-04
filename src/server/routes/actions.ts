import type { FastifyInstance, FastifyRequest } from "fastify";
import type { BrowserSession } from "../../browser/browser-session.js";
import type { ActionResult } from "../../types/index.js";

interface ActionsBody {
  actions: Record<string, unknown>[];
  stopOnError?: boolean;
}

export function registerActionsRoute(app: FastifyInstance) {
  app.post("/actions", async (request: FastifyRequest<{ Body: ActionsBody }>, reply) => {
    const session = (app as any).session as BrowserSession;
    const { actions, stopOnError = true } = request.body || {} as ActionsBody;

    if (!actions || !Array.isArray(actions)) {
      return reply.code(400).send({ error: "actions array is required" });
    }

    const results: ActionResult[] = [];

    for (const action of actions) {
      const result = await session.execAction(action);
      results.push(result);

      if (stopOnError && !result.success) {
        break;
      }
    }

    return {
      results,
      total: actions.length,
      executed: results.length,
      all_success: results.every((r) => r.success),
    };
  });
}
