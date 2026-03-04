import type { FastifyInstance, FastifyRequest } from "fastify";
import { acquireLock, releaseLock, getLock } from "../../lock.js";

interface LockBody {
  tabId: string;
  owner: string;
  ttlMs?: number;
}

interface UnlockBody {
  tabId: string;
  owner: string;
}

export function registerTabLockRoute(app: FastifyInstance) {
  app.post("/tab/lock", async (request: FastifyRequest<{ Body: LockBody }>, reply) => {
    const { tabId, owner, ttlMs } = request.body || {} as LockBody;

    if (!tabId || !owner) {
      return reply.code(400).send({ error: "tabId and owner are required" });
    }

    const lock = acquireLock(tabId, owner, ttlMs);
    if (!lock) {
      const existing = getLock(tabId);
      return reply.code(409).send({
        error: "Tab is already locked",
        lock: existing,
      });
    }
    return { tabId, lock };
  });

  app.post("/tab/unlock", async (request: FastifyRequest<{ Body: UnlockBody }>, reply) => {
    const { tabId, owner } = request.body || {} as UnlockBody;

    if (!tabId || !owner) {
      return reply.code(400).send({ error: "tabId and owner are required" });
    }

    const released = releaseLock(tabId, owner);
    if (!released) {
      return reply.code(404).send({ error: "Lock not found or owner mismatch" });
    }

    return { tabId, released: true };
  });
}
