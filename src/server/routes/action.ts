import type { FastifyInstance, FastifyRequest } from "fastify";
import type { BrowserSession } from "../../browser/browser-session.js";
import type { ActionDict } from "../../types/index.js";
import { getTabWriteConflict, sendRouteError, sendTabLocked } from "../route-utils.js";

// Pinchtab kind -> AriseBrowser type mapping
const KIND_MAP: Record<string, string> = {
  click: "click",
  type: "type",
  fill: "type",
  press: "press_key",
  hover: "hover",
  scroll: "scroll",
  select: "select",
  focus: "focus",
};

export function mapPinchtabAction(body: Record<string, unknown>): ActionDict {
  const kind = body.kind as string | undefined;

  // If already has 'type' field, pass through
  if (body.type) {
    return body;
  }

  if (!kind) {
    return body;
  }

  const actionType = KIND_MAP[kind] || kind;
  const action: ActionDict = { ...body, type: actionType };
  delete action.kind;

  // Map Pinchtab field names
  if (kind === "press" && body.key) {
    action.keys = [body.key as string];
    delete action.key;
  }

  if (kind === "scroll") {
    // Pinchtab uses scrollY (positive = down)
    if (body.scrollY !== undefined) {
      const scrollY = Number(body.scrollY);
      action.direction = scrollY >= 0 ? "down" : "up";
      action.amount = Math.abs(scrollY);
      delete action.scrollY;
    }
  }

  if (kind === "fill" || kind === "type") {
    if (body.value !== undefined && body.text === undefined) {
      action.text = body.value;
    }
  }

  return action;
}

export function registerActionRoute(app: FastifyInstance) {
  app.post("/action", async (request: FastifyRequest<{ Body: Record<string, unknown> }>, reply) => {
    const session = (app as any).session as BrowserSession;
    const body = request.body || {};
    const tabId = typeof body.tabId === "string" ? body.tabId : undefined;
    const owner = typeof body.owner === "string" ? body.owner : undefined;

    const action = mapPinchtabAction(body);

    if (!action.type) {
      return reply.code(400).send({ error: "action type (kind or type) is required" });
    }

    try {
      const conflict = getTabWriteConflict(session, { tabId, owner });
      if (conflict) {
        return sendTabLocked(reply, conflict);
      }

      const result = await session.execAction(action, tabId);
      return result;
    } catch (e) {
      return sendRouteError(reply, e, "Action execution failed");
    }
  });
}
