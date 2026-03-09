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

  await t.test("interactive snapshot preserves semantic button under same-name generic wrapper", async () => {
    const page = await (app as any).session.getPageForTab(undefined, { createIfMissing: true });
    assert.ok(page, "expected a page for snapshot regression");

    await page.setContent(`
      <!doctype html>
      <html>
        <body>
          <div aria-label="Add adult">
            <button type="button" aria-label="Add adult">+</button>
          </div>
        </body>
      </html>
    `);

    const response = await fetch(`${baseUrl}/snapshot?format=compact&filter=interactive`);
    const text = await response.text();

    assert.equal(response.status, 200);
    assert.match(text, /button "Add adult"/i);
  });

  await t.test("evaluate optionally returns captured console without breaking default shape", async () => {
    const page = await (app as any).session.getPageForTab(undefined, { createIfMissing: true });
    assert.ok(page, "expected a page for evaluate regression");
    await page.setContent("<!doctype html><html><body>evaluate</body></html>");

    const captured = await postJson("/evaluate", {
      expression: 'console.log("hello", 42); return 7;',
      captureConsole: true,
    });
    assert.equal(captured.response.status, 200);
    assert.equal(captured.data.result, 7);
    assert.ok(Array.isArray(captured.data.console));
    assert.deepEqual(captured.data.console[0], { type: "log", text: "hello 42" });

    const plain = await postJson("/evaluate", { expression: "3 + 4" });
    assert.equal(plain.response.status, 200);
    assert.equal(plain.data.result, 7);
    assert.equal("console" in plain.data, false);
  });

  await t.test("type falls back to keyboard for comboboxes that reject fill semantics", async () => {
    const page = await (app as any).session.getPageForTab(undefined, { createIfMissing: true });
    assert.ok(page, "expected a page for type regression");

    await page.setContent(`
      <!doctype html>
      <html>
        <body>
          <input
            id="combo"
            aria-ref="e1"
            role="combobox"
            aria-autocomplete="list"
            autocomplete="off"
          />
          <script>
            const input = document.getElementById("combo");
            let fromKeyboard = false;
            input.addEventListener("keydown", () => {
              fromKeyboard = true;
            });
            input.addEventListener("input", () => {
              if (!fromKeyboard && input.value) {
                input.value = "";
              }
              fromKeyboard = false;
            });
          </script>
        </body>
      </html>
    `);

    const typed = await postJson("/action", {
      kind: "type",
      ref: "e1",
      text: "MCO",
    });
    assert.equal(typed.response.status, 200);
    assert.equal(typed.data.success, true);
    assert.equal(typed.data.details?.strategy, "keyboard_type");

    const value = await postJson("/evaluate", {
      expression: 'document.getElementById("combo").value',
    });
    assert.equal(value.response.status, 200);
    assert.equal(value.data.result, "MCO");
  });

  await t.test("click reports focus-only change separately from meaningful ui changes", async () => {
    const page = await (app as any).session.getPageForTab(undefined, { createIfMissing: true });
    assert.ok(page, "expected a page for click regression");

    await page.setContent(`
      <!doctype html>
      <html>
        <body>
          <input id="focus-only" aria-ref="e9" type="text" />
        </body>
      </html>
    `);

    const clicked = await postJson("/action", {
      kind: "click",
      ref: "e9",
    });
    assert.equal(clicked.response.status, 200);
    assert.equal(clicked.data.success, true);
    assert.equal(clicked.data.details?.warning, "focus_only_change");
    assert.match(String(clicked.data.message), /focus changed only/i);
  });
});
