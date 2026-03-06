import type { FastifyInstance, FastifyRequest } from "fastify";
import type { BrowserSession } from "../../browser/browser-session.js";
import type { ActionResult } from "../../types/index.js";
import { mapPinchtabAction } from "./action.js";
import { getTabWriteConflict, sendRouteError } from "../route-utils.js";

interface ActionsBody {
  actions: Record<string, unknown>[];
  stopOnError?: boolean;
  tabId?: string;
  owner?: string;
}

export function registerActionsRoute(app: FastifyInstance) {
  app.post("/actions", async (request: FastifyRequest<{ Body: ActionsBody }>, reply) => {
    const session = (app as any).session as BrowserSession;
    const { actions, stopOnError = true, tabId, owner } = request.body || {} as ActionsBody;

    if (!actions || !Array.isArray(actions)) {
      return reply.code(400).send({ error: "actions array is required" });
    }

    try {
      const results: ActionResult[] = [];

      for (const action of actions) {
        const mappedAction = mapPinchtabAction(action);
        const actionTabId = typeof action.tabId === "string" ? action.tabId : tabId;
        const actionOwner = typeof action.owner === "string" ? action.owner : owner;
        const conflict = getTabWriteConflict(session, {
          tabId: actionTabId,
          owner: actionOwner,
        });

        if (conflict) {
          results.push({
            success: false,
            message: `Error: Tab ${conflict.tabId} is locked by ${conflict.lock.owner}`,
            details: {
              error: "tab_locked",
              tab_id: conflict.tabId,
              lock: conflict.lock,
            },
          });
          if (stopOnError) {
            break;
          }
          continue;
        }

        const result = await session.execAction(mappedAction, actionTabId);
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
    } catch (e) {
      return sendRouteError(reply, e, "Batch action execution failed");
    }
  });
}
