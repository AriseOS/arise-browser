import type { FastifyInstance, FastifyRequest } from "fastify";
import type { BrowserSession } from "../../browser/browser-session.js";

interface EvaluateBody {
  expression: string;
}

export function registerEvaluateRoute(app: FastifyInstance) {
  app.post("/evaluate", async (request: FastifyRequest<{ Body: EvaluateBody }>, reply) => {
    const session = (app as any).session as BrowserSession;
    const { expression } = request.body || {} as EvaluateBody;

    if (!expression) {
      return reply.code(400).send({ error: "expression is required" });
    }

    try {
      const result = await session.evaluate(expression);
      return { result };
    } catch (e) {
      return reply.code(500).send({ error: String(e) });
    }
  });
}
