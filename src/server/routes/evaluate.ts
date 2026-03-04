import type { FastifyInstance, FastifyRequest } from "fastify";
import type { BrowserSession } from "../../browser/browser-session.js";

interface EvaluateBody {
  expression?: string;
  code?: string; // Pinchtab-compatible alias for expression
}

export function registerEvaluateRoute(app: FastifyInstance) {
  app.post("/evaluate", async (request: FastifyRequest<{ Body: EvaluateBody }>, reply) => {
    const session = (app as any).session as BrowserSession;
    const body = request.body || {} as EvaluateBody;
    const expression = body.expression || body.code;

    if (!expression) {
      return reply.code(400).send({ error: "expression (or code) is required" });
    }

    try {
      const result = await session.evaluate(expression);
      return { result };
    } catch (e) {
      return reply.code(500).send({ error: "Evaluation failed" });
    }
  });
}
