import type { FastifyInstance, FastifyRequest } from "fastify";
import type { BrowserSession } from "../../browser/browser-session.js";
import { BehaviorRecorder } from "../../browser/behavior-recorder.js";
import type {
  LearnData,
  LearnStep,
  RecordedOperation,
  RecordingResult,
} from "../../types/index.js";

interface CompletedRecording {
  result: RecordingResult;
  completedAt: number;
}

// Active recorders by recording ID
const activeRecorders = new Map<string, BehaviorRecorder>();
const completedRecordings = new Map<string, CompletedRecording>();

const MAX_RECORDERS = 10;
const MAX_COMPLETED_RECORDINGS = 100;
const COMPLETED_TTL_MS = 60 * 60 * 1000;

function pruneCompletedRecordings(now = Date.now()): void {
  for (const [recordingId, completed] of completedRecordings) {
    if (completed.completedAt + COMPLETED_TTL_MS < now) {
      completedRecordings.delete(recordingId);
    }
  }

  if (completedRecordings.size <= MAX_COMPLETED_RECORDINGS) {
    return;
  }

  const oldestFirst = [...completedRecordings.entries()]
    .sort((a, b) => a[1].completedAt - b[1].completedAt);
  const overflow = completedRecordings.size - MAX_COMPLETED_RECORDINGS;
  for (const [recordingId] of oldestFirst.slice(0, overflow)) {
    completedRecordings.delete(recordingId);
  }
}

function getCompletedRecording(recordingId: string): CompletedRecording | null {
  pruneCompletedRecordings();
  return completedRecordings.get(recordingId) ?? null;
}

function storeCompletedRecording(recordingId: string, result: RecordingResult): void {
  pruneCompletedRecordings();
  completedRecordings.set(recordingId, {
    result,
    completedAt: Date.now(),
  });
  pruneCompletedRecordings();
}

function buildLearnData(operations: RecordedOperation[], task?: string): LearnData {
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

  return {
    type: "browser_workflow",
    task: task || "untitled recording",
    success: true,
    source: "arise-browser",
    domain: [...domains][0] || "",
    steps,
    metadata: {
      duration_ms: startTime !== null && endTime !== null ? endTime - startTime : 0,
      page_count: pageUrls.size,
      recorded_at: new Date().toISOString(),
    },
  };
}

/** Stop and remove all active recorders (called on server shutdown). */
export async function cleanupRecorders(): Promise<void> {
  for (const [, recorder] of activeRecorders) {
    try {
      if (recorder.isRecording()) {
        await recorder.stopRecording();
      }
    } catch {
      // best effort
    }
  }
  activeRecorders.clear();
  completedRecordings.clear();
}

export function registerRecordingRoutes(app: FastifyInstance) {
  // Cleanup recorders on server close
  app.addHook("onClose", async () => {
    await cleanupRecorders();
  });

  app.post("/recording/start", async (_request, reply) => {
    const session = (app as any).session as BrowserSession;
    pruneCompletedRecordings();

    if (activeRecorders.size >= MAX_RECORDERS) {
      return reply.code(429).send({ error: `Maximum ${MAX_RECORDERS} concurrent recordings reached` });
    }

    try {
      const recorder = new BehaviorRecorder(true);
      await recorder.startRecording(session);
      activeRecorders.set(recorder.sessionId, recorder);

      return { recordingId: recorder.sessionId };
    } catch {
      return reply.code(500).send({ error: "Failed to start recording" });
    }
  });

  app.post("/recording/stop", async (request: FastifyRequest<{ Body: { recordingId: string } }>, reply) => {
    const { recordingId } = request.body || {} as { recordingId: string };

    if (!recordingId) {
      return reply.code(400).send({ error: "recordingId is required" });
    }

    const completed = getCompletedRecording(recordingId);
    if (completed) {
      return completed.result;
    }

    const recorder = activeRecorders.get(recordingId);
    if (!recorder) {
      return reply.code(404).send({ error: "Recording not found" });
    }

    try {
      const result = await recorder.stopRecording();
      activeRecorders.delete(recordingId);
      storeCompletedRecording(recordingId, result);
      return result;
    } catch {
      activeRecorders.delete(recordingId);
      return reply.code(500).send({ error: "Failed to stop recording" });
    }
  });

  app.get("/recording/status", async (request: FastifyRequest<{ Querystring: { recordingId?: string } }>) => {
    const { recordingId } = request.query;
    pruneCompletedRecordings();

    if (recordingId) {
      const recorder = activeRecorders.get(recordingId);
      if (recorder) {
        return {
          active: recorder.isRecording(),
          count: recorder.getOperationsCount(),
          recordingId,
        };
      }

      const completed = getCompletedRecording(recordingId);
      if (!completed) {
        return { active: false, completed: false, count: 0 };
      }

      return {
        active: false,
        completed: true,
        count: completed.result.operations_count,
        recordingId,
      };
    }

    const active: Record<string, unknown>[] = [];
    for (const [id, recorder] of activeRecorders) {
      active.push({
        recordingId: id,
        active: recorder.isRecording(),
        count: recorder.getOperationsCount(),
      });
    }
    return {
      recordings: active,
      completed_count: completedRecordings.size,
    };
  });

  app.post("/recording/export", async (request: FastifyRequest<{ Body: { recordingId: string; task?: string } }>, reply) => {
    const { recordingId, task } = request.body || {} as { recordingId: string; task?: string };

    if (!recordingId) {
      return reply.code(400).send({ error: "recordingId is required" });
    }

    pruneCompletedRecordings();

    const recorder = activeRecorders.get(recordingId);
    const completed = getCompletedRecording(recordingId);
    if (!recorder && !completed) {
      return reply.code(404).send({ error: "Recording not found" });
    }

    const operations = recorder
      ? recorder.getOperations()
      : completed!.result.operations;

    return buildLearnData(operations, task);
  });
}
