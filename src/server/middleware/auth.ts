/**
 * Bearer token authentication middleware.
 */

import type { FastifyRequest, FastifyReply, HookHandlerDoneFunction } from "fastify";

export function authMiddleware(expectedToken: string) {
  return (request: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction) => {
    // Skip auth for health check
    if (request.url === "/health") {
      done();
      return;
    }

    const authHeader = request.headers.authorization;
    if (!authHeader) {
      reply.code(401).send({ error: "Authorization header required" });
      return;
    }

    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (token !== expectedToken) {
      reply.code(403).send({ error: "Invalid token" });
      return;
    }

    done();
  };
}
