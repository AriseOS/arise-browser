import type { FastifyInstance } from "fastify";
import type { BrowserSession } from "../../browser/browser-session.js";

export function registerHealthRoute(app: FastifyInstance) {
  app.get("/health", async () => {
    const session = (app as any).session as BrowserSession;
    return {
      status: "ok",
      connected: session.isConnected,
      version: "0.3.0",
    };
  });
}
