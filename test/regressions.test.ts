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

  await t.test("semantic compact snapshot preserves calendar context for date buttons", async () => {
    const page = await (app as any).session.getPageForTab(undefined, { createIfMissing: true });
    assert.ok(page, "expected a page for semantic snapshot regression");

    await page.setContent(`
      <!doctype html>
      <html>
        <body>
          <div role="dialog" aria-label="Choose dates">
            <section>
              <h2>November 2026</h2>
              <div role="grid">
                <button type="button" aria-ref="e1" aria-selected="true">26</button>
              </div>
            </section>
          </div>
        </body>
      </html>
    `);

    const response = await fetch(
      `${baseUrl}/snapshot?format=compact&filter=interactive&semantic=true`,
    );
    const text = await response.text();

    assert.equal(response.status, 200);
    assert.match(text, /\[selected\]/i);
    assert.match(text, /\[widget=calendar\]/i);
    assert.match(text, /\[month="November 2026"\]/i);
    assert.match(text, /\[dialog="Choose dates"\]/i);
  });

  await t.test("viewport-limited semantic snapshot drops below-fold interactive elements", async () => {
    const page = await (app as any).session.getPageForTab(undefined, { createIfMissing: true });
    assert.ok(page, "expected a page for viewport-limited snapshot regression");

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.setContent(`
      <!doctype html>
      <html>
        <body style="margin: 0">
          <button type="button">Visible action</button>
          <div style="height: 2200px"></div>
          <button type="button">Below fold action</button>
        </body>
      </html>
    `);

    const semanticResponse = await fetch(
      `${baseUrl}/snapshot?format=compact&filter=interactive&semantic=true`,
    );
    const semanticText = await semanticResponse.text();

    const viewportResponse = await fetch(
      `${baseUrl}/snapshot?format=compact&filter=interactive&semantic=true&viewportLimit=true`,
    );
    const viewportText = await viewportResponse.text();

    assert.equal(semanticResponse.status, 200);
    assert.equal(viewportResponse.status, 200);
    assert.match(semanticText, /Visible action/);
    assert.match(semanticText, /Below fold action/);
    assert.match(semanticText, /\[viewport=off\]/i);
    assert.match(viewportText, /Visible action/);
    assert.doesNotMatch(viewportText, /Below fold action/);
    assert.doesNotMatch(viewportText, /\[viewport=off\]/i);
  });

  await t.test("calendar_change click succeeds for month navigation buttons", async () => {
    const page = await (app as any).session.getPageForTab(undefined, { createIfMissing: true });
    assert.ok(page, "expected a page for calendar navigation action regression");

    await page.setContent(`
      <!doctype html>
      <html>
        <body>
          <div role="dialog" aria-label="Choose dates">
            <div>
              <h2 id="month-label">July 2026</h2>
              <button
                type="button"
                aria-ref="e1"
                aria-label="Next"
                onclick="
                  document.getElementById('month-label').textContent = 'August 2026';
                  document.getElementById('selected-day').setAttribute('aria-selected', 'true');
                "
              >
                Next
              </button>
              <div role="grid">
                <button type="button" id="selected-day" aria-ref="e2">9</button>
              </div>
            </div>
          </div>
        </body>
      </html>
    `);

    const { response, data } = await postJson("/action", {
      kind: "click",
      ref: "e1",
      clickIntent: "ui",
      expectedEffect: "calendar_change",
    });

    assert.equal(response.status, 200);
    assert.equal(data.success, true);
    assert.match(String(data.message), /Clicked element/i);
    assert.equal(data.details?.calendar_effect_reason, "calendar_navigation_changed");
  });

  await t.test("calendar_change click succeeds when Done closes the calendar dialog", async () => {
    const page = await (app as any).session.getPageForTab(undefined, { createIfMissing: true });
    assert.ok(page, "expected a page for calendar done action regression");

    await page.setContent(`
      <!doctype html>
      <html>
        <body>
          <div role="dialog" aria-label="Choose dates" id="calendar-dialog">
            <h2>September 2026</h2>
            <button
              type="button"
              aria-ref="e3"
              aria-label="Done. Search for round trip flights, departing on September 9, 2026 and returning on September 13, 2026"
              onclick="document.getElementById('calendar-dialog').remove()"
            >
              Done
            </button>
          </div>
        </body>
      </html>
    `);

    const { response, data } = await postJson("/action", {
      kind: "click",
      ref: "e3",
      clickIntent: "ui",
      expectedEffect: "calendar_change",
    });

    assert.equal(response.status, 200);
    assert.equal(data.success, true);
    assert.equal(data.details?.calendar_effect_reason, "calendar_dialog_closed");
  });

  await t.test("semantic compact snapshot prioritizes calendar dialog and drops occluded background actions", async () => {
    const page = await (app as any).session.getPageForTab(undefined, { createIfMissing: true });
    assert.ok(page, "expected a page for modal snapshot regression");

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.setContent(`
      <!doctype html>
      <html>
        <body style="margin: 0">
          <button
            type="button"
            style="position: absolute; top: 16px; left: 16px; width: 180px; height: 44px;"
          >
            Background action
          </button>
          <div
            role="dialog"
            aria-label="Choose dates"
            style="position: fixed; inset: 0; background: rgba(0, 0, 0, 0.35);"
          >
            <section style="margin: 40px; padding: 24px; background: white;">
              <h2>September 2026</h2>
              <div role="grid">
                <button type="button" aria-selected="true">9</button>
                <button type="button">13</button>
              </div>
              <button type="button">Done</button>
            </section>
          </div>
        </body>
      </html>
    `);

    const response = await fetch(
      `${baseUrl}/snapshot?format=compact&filter=interactive&semantic=true`,
    );
    const text = await response.text();
    const [firstLine = ""] = text.split("\n");

    assert.equal(response.status, 200);
    assert.match(firstLine, /\[widget=calendar\]/i);
    assert.match(text, /September 2026/i);
    assert.doesNotMatch(text, /Background action/i);
  });

  await t.test("semantic compact snapshot compresses verbose flight-style labels without losing key facts", async () => {
    const page = await (app as any).session.getPageForTab(undefined, { createIfMissing: true });
    assert.ok(page, "expected a page for compact label regression");

    await page.setContent(`
      <!doctype html>
      <html>
        <body>
          <section aria-label="Search results">
            <a href="https://example.com/flight">
              From 6510 US dollars round trip total. 1 stop flight with United.
              Leaves Hong Kong International Airport at 9:45 PM on Tuesday, June 9
              and arrives at Orlando International Airport at 7:03 AM on Wednesday, June 10.
              Total duration 21 hr 18 min.
              Layover (1 of 1) is a 2 hr 44 min layover at Los Angeles International Airport in Los Angeles.
              Select flight
            </a>
          </section>
        </body>
      </html>
    `);

    const response = await fetch(
      `${baseUrl}/snapshot?format=compact&filter=interactive&semantic=true`,
    );
    const text = await response.text();

    assert.equal(response.status, 200);
    assert.match(text, /6510 USD/i);
    assert.match(text, /RT total/i);
    assert.match(text, /duration 21 hr 18 min/i);
    assert.doesNotMatch(text, /Select flight/i);
    assert.doesNotMatch(text, /\[context=/i);
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

  await t.test("select matches semantic time values on native selects and survives control re-render", async () => {
    const page = await (app as any).session.getPageForTab(undefined, { createIfMissing: true });
    assert.ok(page, "expected a page for native select regression");

    await page.setContent(`
      <!doctype html>
      <html>
        <body>
          <select
            id="time"
            name="time"
            aria-ref="e1"
            onchange="
              const current = this.value;
              const replacement = document.createElement('select');
              replacement.id = 'time';
              replacement.name = 'time';
              replacement.setAttribute('aria-ref', 'e2');
              replacement.innerHTML = this.innerHTML;
              replacement.value = current;
              document.body.replaceChild(replacement, this);
              window.selectedTime = current;
            "
          >
            <option value="All Day">All Day</option>
            <option value="1700">5:00 PM</option>
            <option value="1730">5:30 PM</option>
          </select>
          <script>window.selectedTime = "";</script>
        </body>
      </html>
    `);

    const startedAt = Date.now();
    const selected = await postJson("/action", {
      kind: "select",
      ref: "e1",
      value: "17:30",
    });

    assert.equal(selected.response.status, 200);
    assert.equal(selected.data.success, true);
    assert.equal(selected.data.details?.strategy, "native_select");
    assert.equal(selected.data.details?.resolution?.domain, "time");
    assert.ok(Date.now() - startedAt < 5000);

    const state = await postJson("/evaluate", {
      expression: `(() => ({
        value: document.getElementById("time")?.value || "",
        ref: document.getElementById("time")?.getAttribute("aria-ref") || "",
        selectedTime: window.selectedTime || ""
      }))()`,
    });

    assert.equal(state.response.status, 200);
    assert.deepEqual(state.data.result, {
      value: "1730",
      ref: "e2",
      selectedTime: "1730",
    });
  });

  await t.test("custom select resolves options inside its own popup scope instead of clicking same-page text matches", async () => {
    const page = await (app as any).session.getPageForTab(undefined, { createIfMissing: true });
    assert.ok(page, "expected a page for custom select regression");

    await page.setContent(`
      <!doctype html>
      <html>
        <body>
          <button
            id="time-trigger"
            type="button"
            aria-ref="e10"
            role="combobox"
            aria-controls="time-list"
            aria-expanded="false"
            aria-label="Time"
          >
            All Day
          </button>
          <div id="time-list" role="listbox" hidden>
            <div role="option" data-value="1700">5:00 PM</div>
            <div role="option" data-value="1730">5:30 PM</div>
          </div>
          <button id="date-17" type="button">Tuesday, March 17, 2026.</button>
          <script>
            window.dateClicks = 0;
            const trigger = document.getElementById("time-trigger");
            const list = document.getElementById("time-list");
            const dateButton = document.getElementById("date-17");
            trigger.addEventListener("click", () => {
              list.hidden = false;
              trigger.setAttribute("aria-expanded", "true");
            });
            dateButton.addEventListener("click", () => {
              window.dateClicks += 1;
            });
            for (const option of list.querySelectorAll("[role='option']")) {
              option.addEventListener("click", () => {
                const text = option.textContent.trim();
                trigger.textContent = text;
                trigger.setAttribute("data-value", option.getAttribute("data-value"));
                trigger.setAttribute("aria-valuetext", text);
                trigger.setAttribute("aria-expanded", "false");
                list.hidden = true;
              });
            }
          </script>
        </body>
      </html>
    `);

    const selected = await postJson("/action", {
      kind: "select",
      ref: "e10",
      value: "17:30",
    });

    assert.equal(selected.response.status, 200);
    assert.equal(selected.data.success, true);
    assert.equal(selected.data.details?.strategy, "custom_select");
    assert.equal(selected.data.details?.resolution?.domain, "time");

    const state = await postJson("/evaluate", {
      expression: `(() => ({
        text: document.getElementById("time-trigger")?.textContent?.trim() || "",
        valueText: document.getElementById("time-trigger")?.getAttribute("aria-valuetext") || "",
        dateClicks: window.dateClicks || 0
      }))()`,
    });

    assert.equal(state.response.status, 200);
    assert.deepEqual(state.data.result, {
      text: "5:30 PM",
      valueText: "5:30 PM",
      dateClicks: 0,
    });
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

  await t.test("strict ui click rejects focus-only changes", async () => {
    const page = await (app as any).session.getPageForTab(undefined, { createIfMissing: true });
    assert.ok(page, "expected a page for strict click regression");

    await page.setContent(`
      <!doctype html>
      <html>
        <body>
          <input id="focus-only-strict" aria-ref="e19" type="text" />
        </body>
      </html>
    `);

    const clicked = await postJson("/action", {
      kind: "click",
      ref: "e19",
      expectedEffect: "ui_change",
    });
    assert.equal(clicked.response.status, 200);
    assert.equal(clicked.data.success, false);
    assert.equal(clicked.data.details?.error, "ui_effect_not_observed");
  });

  await t.test("strict ui click accepts semantic page updates", async () => {
    const page = await (app as any).session.getPageForTab(undefined, { createIfMissing: true });
    assert.ok(page, "expected a page for strict semantic click regression");

    await page.setContent(`
      <!doctype html>
      <html>
        <body>
          <h2 id="month">March 2026</h2>
          <button
            type="button"
            aria-ref="e21"
            onclick="document.getElementById('month').textContent = 'April 2026';"
          >
            Next
          </button>
        </body>
      </html>
    `);

    const clicked = await postJson("/action", {
      kind: "click",
      ref: "e21",
      expectedEffect: "ui_change",
    });
    assert.equal(clicked.response.status, 200);
    assert.equal(clicked.data.success, true);
    assert.equal(clicked.data.details?.effect_satisfied, true);
  });
});
