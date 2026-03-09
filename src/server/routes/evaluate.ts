import type { FastifyInstance, FastifyRequest } from "fastify";
import type { BrowserSession } from "../../browser/browser-session.js";
import { getTabWriteConflict, sendRouteError, sendTabLocked } from "../route-utils.js";

interface EvaluateBody {
  expression?: string;
  code?: string; // Pinchtab-compatible alias for expression
  tabId?: string;
  owner?: string;
  captureConsole?: boolean;
}

export function registerEvaluateRoute(app: FastifyInstance) {
  app.post("/evaluate", async (request: FastifyRequest<{ Body: EvaluateBody }>, reply) => {
    const session = (app as any).session as BrowserSession;
    const body = request.body || {} as EvaluateBody;
    const expression = body.expression || body.code;
    const { tabId, owner, captureConsole } = body;

    if (!expression) {
      return reply.code(400).send({ error: "expression (or code) is required" });
    }

    try {
      const conflict = getTabWriteConflict(session, { tabId, owner });
      if (conflict) {
        return sendTabLocked(reply, conflict);
      }

      const evaluation = await session.evaluateDetailed(expression, tabId, { captureConsole });
      if (captureConsole) {
        return evaluation;
      }
      return { result: evaluation.result };
    } catch (e) {
      return sendRouteError(reply, e, "Evaluation failed");
    }
  });
}
