import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "../src/server/server.js";

const HOST = "127.0.0.1";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJson(response: Response): Promise<any> {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

test("arise-browser regressions", async (t) => {
  const app = await createServer(
    { mode: "standalone", headless: true },
    { host: HOST },
  );
  await app.listen({ port: 0, host: HOST });

  t.after(async () => {
    await app.close();
  });

  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not determine test server port");
  }
  const baseUrl = `http://${HOST}:${address.port}`;

  async function getJson(path: string) {
    const response = await fetch(`${baseUrl}${path}`);
    return {
      response,
      data: await readJson(response),
    };
  }

  async function postJson(path: string, body: Record<string, unknown>) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return {
      response,
      data: await readJson(response),
    };
  }

  await t.test("action navigate failure returns success false", async () => {
    await postJson("/navigate", {
      url: "https://example.com/?seed=action-failure",
    });

    const { response, data } = await postJson("/action", {
      type: "navigate",
      url: "http://127.0.0.1:9/",
    });

    assert.equal(response.status, 200);
    assert.equal(data.success, false);
    assert.match(String(data.message), /Navigation failed/i);
  });

  await t.test("newTab navigation failure returns error and rolls back tab", async () => {
    const before = await getJson("/tabs");
    const beforeCount = before.data.tabs.length;

    const { response } = await postJson("/navigate", {
      url: "http://127.0.0.1:9/",
      newTab: true,
      timeout: 3000,
    });

    assert.equal(response.ok, false);

    const after = await getJson("/tabs");
    assert.equal(after.data.tabs.length, beforeCount);
  });

  await t.test("recording ids are unique", async () => {
    const first = await postJson("/recording/start", {});
    const second = await postJson("/recording/start", {});

    assert.notEqual(first.data.recordingId, second.data.recordingId);

    await postJson("/recording/stop", { recordingId: first.data.recordingId });
    await postJson("/recording/stop", { recordingId: second.data.recordingId });
  });

  await t.test("recorder captures navigation on current tab", async () => {
    const start = await postJson("/recording/start", {});
    const recordingId = start.data.recordingId;
    const url = `https://example.com/?record=current-${Date.now()}`;

    await postJson("/navigate", { url });
    await delay(250);

    const stop = await postJson("/recording/stop", { recordingId });
    const operations = stop.data.operations as Array<Record<string, unknown>>;

    assert.ok(stop.data.operations_count > 0);
    assert.ok(
      operations.some((op) => op.type === "navigate" && op.url === url),
      "expected navigate operation for current-tab navigation",
    );
  });

  await t.test("recorder captures navigation on tabs created after start", async () => {
    const start = await postJson("/recording/start", {});
    const recordingId = start.data.recordingId;
    const url = `https://example.com/?record=new-tab-${Date.now()}`;

    await postJson("/navigate", { url, newTab: true });
    await delay(250);

    const stop = await postJson("/recording/stop", { recordingId });
    const operations = stop.data.operations as Array<Record<string, unknown>>;

    assert.ok(stop.data.operations_count > 0);
    assert.ok(
      operations.some((op) => op.type === "navigate" && op.url === url),
      "expected navigate operation for new-tab navigation",
    );
  });
});
