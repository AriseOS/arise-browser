import type { FastifyInstance, FastifyRequest } from "fastify";
import type { BrowserSession } from "../../browser/browser-session.js";

interface SetCookiesBody {
  cookies: Array<{
    name: string;
    value: string;
    url?: string;
    domain?: string;
    path?: string;
  }>;
}

export function registerCookiesRoute(app: FastifyInstance) {
  app.get("/cookies", async (_request, reply) => {
    const session = (app as any).session as BrowserSession;
    try {
      const cookies = await session.getCookies();
      return { cookies };
    } catch (e) {
      return reply.code(500).send({ error: "Failed to get cookies" });
    }
  });

  app.post("/cookies", async (request: FastifyRequest<{ Body: SetCookiesBody }>, reply) => {
    const session = (app as any).session as BrowserSession;
    const { cookies } = request.body || {} as SetCookiesBody;

    if (!cookies || !Array.isArray(cookies)) {
      return reply.code(400).send({ error: "cookies array is required" });
    }

    try {
      await session.setCookies(cookies);
      return { set: cookies.length };
    } catch (e) {
      return reply.code(500).send({ error: "Failed to set cookies" });
    }
  });
}
