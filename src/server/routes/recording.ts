import type { FastifyInstance, FastifyRequest } from "fastify";
import type { BrowserSession } from "../../browser/browser-session.js";
import { BehaviorRecorder } from "../../browser/behavior-recorder.js";
import type { LearnData, LearnStep } from "../../types/index.js";

// Active recorders by recording ID
const recorders = new Map<string, BehaviorRecorder>();

const MAX_RECORDERS = 10;

/** Stop and remove all active recorders (called on server shutdown). */
export async function cleanupRecorders(): Promise<void> {
  for (const [id, recorder] of recorders) {
    try {
      if (recorder.isRecording()) {
        await recorder.stopRecording();
      }
    } catch {
      // best effort
    }
  }
  recorders.clear();
}

export function registerRecordingRoutes(app: FastifyInstance) {
  // Cleanup recorders on server close
  app.addHook("onClose", async () => {
    await cleanupRecorders();
  });

  app.post("/recording/start", async (_request, reply) => {
    const session = (app as any).session as BrowserSession;

    if (recorders.size >= MAX_RECORDERS) {
      return reply.code(429).send({ error: `Maximum ${MAX_RECORDERS} concurrent recordings reached` });
    }

    try {
      const recorder = new BehaviorRecorder(true);
      await recorder.startRecording(session);
      recorders.set(recorder.sessionId, recorder);

      return { recordingId: recorder.sessionId };
    } catch (e) {
      return reply.code(500).send({ error: "Failed to start recording" });
    }
  });

  app.post("/recording/stop", async (request: FastifyRequest<{ Body: { recordingId: string } }>, reply) => {
    const { recordingId } = request.body || {} as { recordingId: string };

    if (!recordingId) {
      return reply.code(400).send({ error: "recordingId is required" });
    }

    const recorder = recorders.get(recordingId);
    if (!recorder) {
      return reply.code(404).send({ error: "Recording not found" });
    }

    try {
      const result = await recorder.stopRecording();
      recorders.delete(recordingId);
      return result;
    } catch (e) {
      recorders.delete(recordingId);
      return reply.code(500).send({ error: "Failed to stop recording" });
    }
  });

  app.get("/recording/status", async (request: FastifyRequest<{ Querystring: { recordingId?: string } }>) => {
    const { recordingId } = request.query;

    if (recordingId) {
      const recorder = recorders.get(recordingId);
      if (!recorder) {
        return { active: false, count: 0 };
      }
      return {
        active: recorder.isRecording(),
        count: recorder.getOperationsCount(),
        recordingId,
      };
    }

    // List all active recordings
    const active: Record<string, unknown>[] = [];
    for (const [id, recorder] of recorders) {
      active.push({
        recordingId: id,
        active: recorder.isRecording(),
        count: recorder.getOperationsCount(),
      });
    }
    return { recordings: active };
  });

  app.post("/recording/export", async (request: FastifyRequest<{ Body: { recordingId: string; task?: string } }>, reply) => {
    const { recordingId, task } = request.body || {} as { recordingId: string; task?: string };

    if (!recordingId) {
      return reply.code(400).send({ error: "recordingId is required" });
    }

    const recorder = recorders.get(recordingId);
    if (!recorder) {
      return reply.code(404).send({ error: "Recording not found" });
    }

    const operations = recorder.getOperations();

    // Convert operations to Learn protocol format
    const steps: LearnStep[] = [];
    const domains = new Set<string>();
    let startTime: number | null = null;
    let endTime: number | null = null;
    const pageUrls = new Set<string>();

    for (const op of operations) {
      const ts = new Date(op.timestamp).getTime();
      if (startTime === null || ts < startTime) startTime = ts;
      if (endTime === null || ts > endTime) endTime = ts;

      if (op.url) {
        pageUrls.add(op.url);
        try {
          domains.add(new URL(op.url).hostname);
        } catch {
          // invalid URL
        }
      }

      if (op.type === "navigate" && op.url) {
        steps.push({ url: op.url, action: "navigate" });
      } else if (op.type === "click") {
        steps.push({
          url: op.url || "",
          action: "click",
          target: op.text || op.ref,
        });
      } else if (op.type === "type") {
        steps.push({
          url: op.url || "",
          action: "type",
          target: op.ref,
          value: op.value,
        });
      } else if (op.type === "scroll") {
        steps.push({
          url: op.url || "",
          action: "scroll",
        });
      } else if (op.type === "select") {
        steps.push({
          url: op.url || "",
          action: "select",
          target: op.ref,
          value: op.value,
        });
      }
    }

    const learnData: LearnData = {
      type: "browser_workflow",
      task: task || "untitled recording",
      success: true,
      source: "arise-browser",
      domain: [...domains][0] || "",
      steps,
      metadata: {
        duration_ms: startTime && endTime ? endTime - startTime : 0,
        page_count: pageUrls.size,
        recorded_at: new Date().toISOString(),
      },
    };

    return learnData;
  });
}
