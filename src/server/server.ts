/**
 * AmiPilot HTTP server — Fastify-based, Pinchtab-compatible API.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { BrowserSession } from "../browser/browser-session.js";
import { createLogger } from "../logger.js";
import type { AmiPilotConfig, ServerConfig } from "../types/index.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerTabsRoute } from "./routes/tabs.js";
import { registerNavigateRoute } from "./routes/navigate.js";
import { registerSnapshotRoute } from "./routes/snapshot.js";
import { registerActionRoute } from "./routes/action.js";
import { registerActionsRoute } from "./routes/actions.js";
import { registerTextRoute } from "./routes/text.js";
import { registerScreenshotRoute } from "./routes/screenshot.js";
import { registerPdfRoute } from "./routes/pdf.js";
import { registerEvaluateRoute } from "./routes/evaluate.js";
import { registerTabRoute } from "./routes/tab.js";
import { registerTabLockRoute } from "./routes/tab-lock.js";
import { registerCookiesRoute } from "./routes/cookies.js";
import { registerUploadRoute } from "./routes/upload.js";
import { registerDownloadRoute } from "./routes/download.js";
import { registerRecordingRoutes } from "./routes/recording.js";
import { authMiddleware } from "./middleware/auth.js";

const logger = createLogger("server");

export async function createServer(
  browserConfig: AmiPilotConfig,
  serverConfig: ServerConfig = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Auth middleware
  const token = serverConfig.token
    || process.env.AMIPILOT_TOKEN
    || process.env.BRIDGE_TOKEN;

  if (token) {
    app.addHook("onRequest", authMiddleware(token));
  }

  // Create and attach browser session
  const session = BrowserSession.create(browserConfig, "server");
  await session.ensureBrowser();

  // Decorate with session reference
  app.decorate("session", session);

  // Register routes
  registerHealthRoute(app);
  registerTabsRoute(app);
  registerNavigateRoute(app);
  registerSnapshotRoute(app);
  registerActionRoute(app);
  registerActionsRoute(app);
  registerTextRoute(app);
  registerScreenshotRoute(app);
  registerPdfRoute(app);
  registerEvaluateRoute(app);
  registerTabRoute(app);
  registerTabLockRoute(app);
  registerCookiesRoute(app);
  registerUploadRoute(app);
  registerDownloadRoute(app);
  registerRecordingRoutes(app);

  // Cleanup on close
  app.addHook("onClose", async () => {
    logger.info("Shutting down browser session");
    await session.close();
  });

  return app;
}
