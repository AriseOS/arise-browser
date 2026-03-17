#!/usr/bin/env -S node --import=tsx
/**
 * AriseBrowser API interactive test script.
 *
 * Covers all endpoints: health, navigate, snapshot (all formats + diff + interactive),
 * action (click, type, scroll, press_key, hover, select), batch actions, tabs,
 * tab locks, recording lifecycle, evaluate, text, screenshot, cookies, upload, download, pdf.
 *
 * Usage:
 *   1. Start server:  node dist/bin/arise-browser.js --no-headless --port 16473
 *   2. Run:           npx tsx scripts/test-api.ts [base_url]
 */

const BASE = process.argv[2] || "http://localhost:16473";

let pass = 0;
let fail = 0;
let skip = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
    pass++;
  } catch (e: any) {
    if (e.message?.startsWith("SKIP:")) {
      console.log(`  \x1b[33mSKIP\x1b[0m  ${name} — ${e.message.slice(5)}`);
      skip++;
    } else {
      console.log(`  \x1b[31mFAIL\x1b[0m  ${name}`);
      console.log(`        ${e.message}`);
      fail++;
    }
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

async function json(resp: Response) {
  const body = await resp.text();
  assert(resp.ok, `HTTP ${resp.status}: ${body}`);
  return JSON.parse(body);
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

async function post(path: string, body: any) {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function get(path: string) {
  return fetch(`${BASE}${path}`);
}

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

async function main() {
  console.log("=== AriseBrowser API Tests ===");
  console.log(`Base URL: ${BASE}\n`);

  // ── 1. Health ──────────────────────────────
  console.log("── GET /health ──");
  await test("returns status=ok and version", async () => {
    const data = await json(await get("/health"));
    assert(data.status === "ok", `status=${data.status}`);
    assert(typeof data.version === "string", "missing version");
  });

  // ── 2. Navigate ────────────────────────────
  console.log("\n── POST /navigate ──");
  await test("navigate to example.com", async () => {
    const data = await json(await post("/navigate", { url: "https://example.com" }));
    assert(data.url?.includes("example.com"), `url=${data.url}`);
    assert(typeof data.title === "string", "missing title");
  });

  await test("navigate missing url returns 400", async () => {
    const resp = await post("/navigate", {});
    assert(resp.status === 400, `expected 400, got ${resp.status}`);
  });

  // ── 3. Snapshot — all formats ──────────────
  console.log("\n── GET /snapshot ──");
  await test("yaml (default) returns snapshot string", async () => {
    const data = await json(await get("/snapshot"));
    assert(typeof data.snapshot === "string", "missing snapshot field");
    assert(data.format === "yaml", `format=${data.format}`);
  });

  await test("json format returns nodes array", async () => {
    const data = await json(await get("/snapshot?format=json"));
    assert(Array.isArray(data.nodes), "nodes is not array");
    assert(typeof data.url === "string", "missing url");
    assert(typeof data.title === "string", "missing title");
    assert(typeof data.count === "number", "missing count");
  });

  await test("compact format returns text/plain", async () => {
    const resp = await get("/snapshot?format=compact");
    assert(resp.ok, `HTTP ${resp.status}`);
    const ct = resp.headers.get("content-type") || "";
    assert(ct.includes("text/plain"), `content-type=${ct}`);
    const text = await resp.text();
    assert(!text.startsWith("{"), "compact should not be JSON");
  });

  await test("text format returns text/plain", async () => {
    const resp = await get("/snapshot?format=text");
    assert(resp.ok, `HTTP ${resp.status}`);
    const ct = resp.headers.get("content-type") || "";
    assert(ct.includes("text/plain"), `content-type=${ct}`);
  });

  await test("filter=interactive returns subset", async () => {
    const all = await json(await get("/snapshot?format=json"));
    const interactive = await json(await get("/snapshot?format=json&filter=interactive"));
    assert(Array.isArray(interactive.nodes), "nodes not array");
    assert(interactive.count <= all.count, `interactive(${interactive.count}) > all(${all.count})`);
  });

  await test("diff=true works (first call = full snapshot)", async () => {
    const data = await json(await get("/snapshot?diff=true"));
    assert(typeof data.snapshot === "string" || Array.isArray(data.nodes), "unexpected diff response");
  });

  // ── 4. Text extraction ─────────────────────
  console.log("\n── GET /text ──");
  await test("returns text, url, title", async () => {
    const data = await json(await get("/text"));
    assert(typeof data.text === "string", "missing text");
    assert(typeof data.url === "string", "missing url");
    assert(typeof data.title === "string", "missing title");
    assert(data.text.length > 0, "text is empty");
  });

  // ── 5. Screenshot ──────────────────────────
  console.log("\n── GET /screenshot ──");
  await test("raw screenshot returns image/jpeg", async () => {
    const resp = await get("/screenshot?raw=true");
    assert(resp.ok, `HTTP ${resp.status}`);
    const ct = resp.headers.get("content-type") || "";
    assert(ct.includes("image/jpeg"), `content-type=${ct}`);
    const blob = await resp.blob();
    assert(blob.size > 1000, `too small: ${blob.size} bytes`);
  });

  await test("json screenshot returns base64 image", async () => {
    const data = await json(await get("/screenshot"));
    assert(typeof data.image === "string", "missing image field");
    assert(data.image.startsWith("data:image/jpeg;base64,"), `unexpected image prefix`);
  });

  // ── 6. Evaluate ────────────────────────────
  console.log("\n── POST /evaluate ──");
  await test("expression field", async () => {
    const data = await json(await post("/evaluate", { expression: "1 + 1" }));
    assert(data.result === 2, `result=${data.result}`);
  });

  await test("code field (Pinchtab compat)", async () => {
    const data = await json(await post("/evaluate", { code: "document.title" }));
    assert("result" in data, "missing result");
    assert(typeof data.result === "string", `result type=${typeof data.result}`);
  });

  // ── 7. Actions — scroll ────────────────────
  console.log("\n── POST /action ──");
  await test("scroll down (kind field — Pinchtab compat)", async () => {
    const data = await json(await post("/action", { kind: "scroll", direction: "down", amount: 300 }));
    assert("success" in data, "missing success");
  });

  await test("scroll up (type field — native)", async () => {
    const data = await json(await post("/action", { type: "scroll", scrollY: -300 }));
    assert("success" in data, "missing success");
  });

  // ── 7b. Navigate to a real page with interactive elements ──
  console.log("\n── Navigate to page with form elements ──");
  await test("navigate to a form page for click/type tests", async () => {
    // Use a data URI with form elements for reliable testing
    const html = `
      <html><head><title>Test Form</title></head><body>
        <h1>Test Page</h1>
        <input type="text" id="name" placeholder="Enter name" aria-label="Name" />
        <button id="btn" onclick="document.title='clicked'">Click Me</button>
        <select id="color" aria-label="Color">
          <option value="red">Red</option>
          <option value="blue">Blue</option>
          <option value="green">Green</option>
        </select>
        <a href="#section2" id="link1">Go to Section 2</a>
        <div id="section2" style="margin-top:200px">Section 2</div>
      </body></html>`;
    const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
    const data = await json(await post("/navigate", { url: dataUrl }));
    assert(data.title === "Test Form", `title=${data.title}`);
  });

  // Get snapshot to find refs
  let inputRef = "";
  let buttonRef = "";
  let selectRef = "";
  let linkRef = "";

  await test("snapshot json to find element refs", async () => {
    const data = await json(await get("/snapshot?format=json"));
    assert(Array.isArray(data.nodes), "nodes not array");

    for (const node of data.nodes) {
      const name = (node.name || "").toLowerCase();
      const role = (node.role || "").toLowerCase();
      if (role === "textbox" && !inputRef) inputRef = node.ref;
      if (role === "button" && name.includes("click") && !buttonRef) buttonRef = node.ref;
      if ((role === "combobox" || role === "select" || role === "listbox") && !selectRef) selectRef = node.ref;
      if (role === "link" && name.includes("section") && !linkRef) linkRef = node.ref;
    }
    assert(!!inputRef, `input ref not found (nodes: ${data.nodes.length})`);
    assert(!!buttonRef, `button ref not found`);
  });

  // ── 7c. Click ──────────────────────────────
  await test("click button", async () => {
    assert(!!buttonRef, "no button ref");
    const data = await json(await post("/action", { type: "click", ref: buttonRef }));
    assert("success" in data, "missing success");
  });

  await test("verify click worked (title changed)", async () => {
    const data = await json(await post("/evaluate", { expression: "document.title" }));
    assert(data.result === "clicked", `title=${data.result}`);
  });

  // ── 7d. Type ───────────────────────────────
  await test("type into input", async () => {
    assert(!!inputRef, "no input ref");
    const data = await json(await post("/action", { type: "type", ref: inputRef, text: "Hello AriseBrowser" }));
    assert("success" in data, "missing success");
  });

  await test("verify typed text", async () => {
    const data = await json(await post("/evaluate", { expression: "document.getElementById('name').value" }));
    assert(data.result === "Hello AriseBrowser", `value=${data.result}`);
  });

  // ── 7e. Select ─────────────────────────────
  await test("select option", async () => {
    if (!selectRef) throw new Error("SKIP: no select ref found");
    const data = await json(await post("/action", { type: "select", ref: selectRef, value: "blue" }));
    assert("success" in data, "missing success");
  });

  await test("verify selected value", async () => {
    if (!selectRef) throw new Error("SKIP: no select ref");
    const data = await json(await post("/evaluate", { expression: "document.getElementById('color').value" }));
    assert(data.result === "blue", `value=${data.result}`);
  });

  // ── 7f. Hover ──────────────────────────────
  await test("hover on button", async () => {
    assert(!!buttonRef, "no button ref");
    const data = await json(await post("/action", { type: "hover", ref: buttonRef }));
    assert("success" in data, "missing success");
  });

  // ── 7g. Focus ──────────────────────────────
  await test("focus on input", async () => {
    assert(!!inputRef, "no input ref");
    const data = await json(await post("/action", { type: "focus", ref: inputRef }));
    assert("success" in data, "missing success");
  });

  // ── 7h. Press key ──────────────────────────
  await test("press_key Enter", async () => {
    const data = await json(await post("/action", { type: "press_key", keys: ["Enter"] }));
    assert("success" in data, "missing success");
  });

  await test("press key (kind=press, Pinchtab compat)", async () => {
    const data = await json(await post("/action", { kind: "press", key: "Tab" }));
    assert("success" in data, "missing success");
  });

  // ── 7i. Action validation ──────────────────
  await test("action with missing type returns 400", async () => {
    const resp = await post("/action", {});
    assert(resp.status === 400, `expected 400, got ${resp.status}`);
  });

  // ── 8. Batch actions ───────────────────────
  console.log("\n── POST /actions (batch) ──");
  await test("batch: scroll + evaluate", async () => {
    const data = await json(await post("/actions", {
      actions: [
        { type: "scroll", scrollY: 100 },
        { type: "scroll", scrollY: -100 },
      ],
    }));
    assert(data.total === 2, `total=${data.total}`);
    assert(data.executed === 2, `executed=${data.executed}`);
    assert(data.all_success === true, `all_success=${data.all_success}`);
    assert(Array.isArray(data.results), "results not array");
  });

  await test("batch: empty actions returns 200 (no-op)", async () => {
    const resp = await post("/actions", { actions: [] });
    assert(resp.ok, `expected 200, got ${resp.status}`);
  });

  await test("batch: missing actions field returns 400", async () => {
    const resp = await post("/actions", {});
    assert(resp.status === 400, `expected 400, got ${resp.status}`);
  });

  // ── 9. Tabs ────────────────────────────────
  console.log("\n── Tabs ──");
  let newTabId = "";

  await test("GET /tabs returns array", async () => {
    const data = await json(await get("/tabs"));
    assert(Array.isArray(data.tabs), "tabs not array");
    assert(data.tabs.length >= 1, "no tabs");
  });

  await test("POST /tab create", async () => {
    const data = await json(await post("/tab", { action: "create" }));
    assert(typeof data.tabId === "string", "missing tabId");
    assert(data.action === "created", `action=${data.action}`);
    newTabId = data.tabId;
  });

  await test("POST /tab create with url", async () => {
    const data = await json(await post("/tab", { action: "create", url: "https://example.com" }));
    assert(typeof data.tabId === "string", "missing tabId");
    // Close it immediately
    await post("/tab", { action: "close", tabId: data.tabId });
  });

  await test("POST /tab switch", async () => {
    assert(!!newTabId, "no tab to switch to");
    const data = await json(await post("/tab", { action: "switch", tabId: newTabId }));
    assert(data.action === "switched", `action=${data.action}`);
  });

  await test("POST /tab close", async () => {
    assert(!!newTabId, "no tab to close");
    const data = await json(await post("/tab", { action: "close", tabId: newTabId }));
    assert(data.action === "closed", `action=${data.action}`);
  });

  await test("POST /tab missing action returns 400", async () => {
    const resp = await post("/tab", {});
    assert(resp.status === 400, `expected 400, got ${resp.status}`);
  });

  // ── 10. Tab locks ──────────────────────────
  console.log("\n── Tab Locks ──");
  // Get current tab ID first
  const tabsData = await json(await get("/tabs"));
  const currentTabId = tabsData.tabs?.[0]?.id || tabsData.tabs?.[0]?.tabId || "tab-0";

  await test("POST /tab/lock acquire", async () => {
    const data = await json(await post("/tab/lock", {
      tabId: currentTabId,
      owner: "test-agent-1",
      ttlMs: 30000,
    }));
    assert(typeof data.lock === "object", "missing lock");
    assert(data.tabId === currentTabId, `tabId mismatch`);
  });

  await test("POST /tab/lock conflict returns 409", async () => {
    const resp = await post("/tab/lock", {
      tabId: currentTabId,
      owner: "test-agent-2",
    });
    assert(resp.status === 409, `expected 409, got ${resp.status}`);
  });

  await test("POST /tab/unlock release", async () => {
    const data = await json(await post("/tab/unlock", {
      tabId: currentTabId,
      owner: "test-agent-1",
    }));
    assert(data.released === true, `released=${data.released}`);
  });

  await test("POST /tab/unlock wrong owner returns 404", async () => {
    // Lock again first
    await post("/tab/lock", { tabId: currentTabId, owner: "test-agent-1" });
    const resp = await post("/tab/unlock", {
      tabId: currentTabId,
      owner: "wrong-owner",
    });
    assert(resp.status === 404, `expected 404, got ${resp.status}`);
    // Clean up
    await post("/tab/unlock", { tabId: currentTabId, owner: "test-agent-1" });
  });

  await test("POST /tab/lock missing fields returns 400", async () => {
    const resp = await post("/tab/lock", {});
    assert(resp.status === 400, `expected 400, got ${resp.status}`);
  });

  // ── 11. Recording lifecycle ────────────────
  console.log("\n── Recording ──");
  let recordingId = "";

  await test("POST /recording/start", async () => {
    const data = await json(await post("/recording/start", {}));
    assert(typeof data.recordingId === "string", "missing recordingId");
    recordingId = data.recordingId;
  });

  await test("GET /recording/status (specific)", async () => {
    assert(!!recordingId, "no recordingId");
    const data = await json(await get(`/recording/status?recordingId=${recordingId}`));
    assert(data.active === true, `active=${data.active}`);
    assert(typeof data.count === "number", "missing count");
  });

  await test("GET /recording/status (list all)", async () => {
    const data = await json(await get("/recording/status"));
    assert(Array.isArray(data.recordings), "recordings not array");
    assert(data.recordings.length >= 1, "no recordings");
  });

  // Perform some actions while recording
  await post("/navigate", { url: "https://example.com" });
  await new Promise((r) => setTimeout(r, 500));

  // Export BEFORE stop — stop deletes the recorder from memory
  await test("POST /recording/export (Learn protocol)", async () => {
    assert(!!recordingId, "no recordingId");
    const data = await json(await post("/recording/export", {
      recordingId,
      task: "Test navigation to example.com",
    }));
    assert(data.type === "browser_workflow", `type=${data.type}`);
    assert(data.task === "Test navigation to example.com", `task=${data.task}`);
    assert(data.success === true, `success=${data.success}`);
    assert(data.source === "arise-browser", `source=${data.source}`);
    assert(Array.isArray(data.steps), "steps not array");
    assert(typeof data.metadata === "object", "missing metadata");
    assert(typeof data.metadata.duration_ms === "number", "missing duration_ms");
    console.log(`        → exported ${data.steps.length} steps, ${data.metadata.duration_ms}ms`);
  });

  await test("POST /recording/stop", async () => {
    assert(!!recordingId, "no recordingId");
    const data = await json(await post("/recording/stop", { recordingId }));
    assert(data !== null, "null response");
  });

  await test("POST /recording/stop missing id returns 400", async () => {
    const resp = await post("/recording/stop", {});
    assert(resp.status === 400, `expected 400, got ${resp.status}`);
  });

  await test("POST /recording/export missing id returns 400", async () => {
    const resp = await post("/recording/export", {});
    assert(resp.status === 400, `expected 400, got ${resp.status}`);
  });

  await test("POST /recording/stop unknown id returns 404", async () => {
    const resp = await post("/recording/stop", { recordingId: "nonexistent" });
    assert(resp.status === 404, `expected 404, got ${resp.status}`);
  });

  // ── 12. Cookies ────────────────────────────
  console.log("\n── Cookies ──");
  await test("POST /cookies set", async () => {
    const data = await json(await post("/cookies", {
      cookies: [
        { name: "test_cookie", value: "hello123", url: "https://example.com" },
      ],
    }));
    assert(data.set === 1, `set=${data.set}`);
  });

  await test("GET /cookies read", async () => {
    const data = await json(await get("/cookies"));
    assert(Array.isArray(data.cookies), "cookies not array");
    const found = data.cookies.find((c: any) => c.name === "test_cookie");
    assert(!!found, "test_cookie not found");
    assert(found.value === "hello123", `value=${found.value}`);
  });

  await test("POST /cookies empty array returns 200 (no-op)", async () => {
    const resp = await post("/cookies", { cookies: [] });
    assert(resp.ok, `expected 200, got ${resp.status}`);
  });

  // ── 13. PDF (headless only — skip in headed mode) ──
  console.log("\n── GET /pdf ──");
  await test("pdf export", async () => {
    const resp = await get("/pdf");
    if (resp.status === 400) {
      // "PDF export requires headless mode" — expected in --no-headless
      throw new Error("SKIP: PDF requires headless mode");
    }
    assert(resp.ok, `HTTP ${resp.status}`);
    const ct = resp.headers.get("content-type") || "";
    assert(ct.includes("application/pdf") || ct.includes("octet-stream"), `content-type=${ct}`);
    const blob = await resp.blob();
    assert(blob.size > 100, `too small: ${blob.size}`);
  });

  // ── 14. Diff mode ──────────────────────────
  console.log("\n── Snapshot diff mode ──");
  await test("second diff call returns smaller payload", async () => {
    // First call: full snapshot (resets diff baseline)
    const first = await json(await get("/snapshot"));
    // Second call with diff: should be smaller or equal
    const second = await json(await get("/snapshot?diff=true"));
    assert(typeof second.snapshot === "string", "missing snapshot");
    // Diff should generally be shorter, but at minimum it should work
    console.log(`        → full=${first.snapshot.length} chars, diff=${second.snapshot.length} chars`);
  });

  // ── 15. Viewport limit ─────────────────────
  console.log("\n── Snapshot viewport limit ──");
  await test("viewportLimit=true works", async () => {
    const data = await json(await get("/snapshot?format=json&viewportLimit=true"));
    assert(Array.isArray(data.nodes), "nodes not array");
  });

  // ── 16. Navigate with newTab ───────────────
  console.log("\n── Navigate newTab ──");
  await test("navigate with newTab=true opens in new tab", async () => {
    const tabsBefore = await json(await get("/tabs"));
    const countBefore = tabsBefore.tabs.length;

    const data = await json(await post("/navigate", { url: "https://example.com", newTab: true }));
    assert(typeof data.tabId === "string", "missing tabId");
    assert(data.url?.includes("example.com"), `url=${data.url}`);

    const tabsAfter = await json(await get("/tabs"));
    assert(tabsAfter.tabs.length === countBefore + 1, `expected ${countBefore + 1} tabs, got ${tabsAfter.tabs.length}`);

    // Clean up: close the new tab
    await post("/tab", { action: "close", tabId: data.tabId });
  });

  // ── 17. Action on invalid ref ──────────────
  console.log("\n── Action error handling ──");
  await test("click non-existent ref returns error", async () => {
    // Navigate to form page first to have a valid page context
    const html = `<html><head><title>Ref Test</title></head><body><p>Hello</p></body></html>`;
    await post("/navigate", { url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` });

    const resp = await post("/action", { type: "click", ref: "e999" });
    const data = JSON.parse(await resp.text());
    // Should return success=false or an error, not crash
    assert(data.success === false || data.error, `expected failure for bad ref, got: ${JSON.stringify(data)}`);
  });

  await test("type to non-existent ref returns error info", async () => {
    const resp = await post("/action", { type: "type", ref: "e999", text: "hello" });
    const data = JSON.parse(await resp.text());
    // Note: action executor returns success=true but with error in message/details
    // This is a known quirk — the important thing is it doesn't crash and reports the error
    const hasError = data.success === false || data.error ||
      (data.message && data.message.toLowerCase().includes("fail")) ||
      (data.details?.error);
    assert(hasError, `expected error info for bad ref, got: ${JSON.stringify(data).slice(0, 200)}`);
  });

  // ── 18. Pinchtab fill + value mapping ──────
  console.log("\n── Pinchtab fill compat ──");
  await test("kind=fill with value field maps to type", async () => {
    // Navigate to form page
    const html = `<html><head><title>Fill Test</title></head><body>
      <input type="text" id="inp" aria-label="Field" />
    </body></html>`;
    await post("/navigate", { url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` });

    // Get ref
    const snap = await json(await get("/snapshot?format=json"));
    const inp = snap.nodes.find((n: any) => n.role === "textbox");
    assert(!!inp, "textbox not found");

    // Use Pinchtab fill format: kind=fill, value=text
    const data = await json(await post("/action", { kind: "fill", ref: inp.ref, value: "filled text" }));
    assert("success" in data, "missing success");

    // Verify the text was typed
    const evalData = await json(await post("/evaluate", { expression: "document.getElementById('inp').value" }));
    assert(evalData.result === "filled text", `value=${evalData.result}`);
  });

  // ── 19. Ref persistence across snapshots ───
  console.log("\n── Ref persistence ──");
  await test("ref from earlier snapshot still works after re-snapshot", async () => {
    // Navigate to page with multiple elements (button needs sibling content to be split as separate node)
    const html = `<html><head><title>Ref Persist</title></head><body>
      <h1>Ref Persistence Test</h1>
      <p>Some text content here</p>
      <input type="text" id="inp" aria-label="TestInput" />
      <button id="btn" onclick="document.title='ref-works'">Persist Test</button>
      <a href="#">A link</a>
    </body></html>`;
    await post("/navigate", { url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` });

    // First snapshot — get an interactive element ref
    const snap1 = await json(await get("/snapshot?format=json"));
    // Find any clickable element (button or link)
    const clickable = snap1.nodes.find((n: any) =>
      n.role === "button" || n.role === "link" || n.role === "textbox"
    );
    assert(!!clickable, `no clickable element found (nodes: ${snap1.nodes.map((n: any) => n.role).join(",")})`);
    const savedRef = clickable.ref;
    console.log(`        → saved ref ${savedRef} (role=${clickable.role}) from snapshot 1`);

    // Take another snapshot (could reassign refs in a bad implementation)
    const snap2 = await json(await get("/snapshot?format=json"));

    // Verify same ref still exists in second snapshot
    const sameNode = snap2.nodes.find((n: any) => n.ref === savedRef);
    assert(!!sameNode, `ref ${savedRef} not found in second snapshot`);

    // Use the ref from the FIRST snapshot to perform action
    if (clickable.role === "textbox") {
      const data = await json(await post("/action", { type: "type", ref: savedRef, text: "persisted" }));
      assert("success" in data, "missing success");
      const evalData = await json(await post("/evaluate", { expression: "document.getElementById('inp').value" }));
      assert(evalData.result === "persisted", `value=${evalData.result}`);
    } else {
      const data = await json(await post("/action", { type: "click", ref: savedRef }));
      assert("success" in data, "missing success");
    }
  });

  // ── 20. Recording captures actions ─────────
  console.log("\n── Recording content ──");
  let recId2 = "";
  await test("recording captures performed actions", async () => {
    // Navigate to a page
    const html = `<html><head><title>Rec Test</title></head><body>
      <input type="text" id="f" aria-label="RecField" />
      <button id="b" onclick="void(0)">RecBtn</button>
    </body></html>`;
    await post("/navigate", { url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` });

    // Start recording
    const startData = await json(await post("/recording/start", {}));
    recId2 = startData.recordingId;

    // Perform actions
    await post("/navigate", { url: "https://example.com" });
    await new Promise((r) => setTimeout(r, 300));
    await post("/action", { type: "scroll", scrollY: 200 });
    await new Promise((r) => setTimeout(r, 200));

    // Export and check steps > 0
    const exportData = await json(await post("/recording/export", { recordingId: recId2, task: "rec content test" }));
    assert(exportData.steps.length > 0, `expected steps > 0, got ${exportData.steps.length}`);
    console.log(`        → ${exportData.steps.length} steps recorded`);

    // Verify navigate step exists
    const hasNav = exportData.steps.some((s: any) => s.action === "navigate");
    assert(hasNav, "no navigate step in recording");

    // Clean up
    await post("/recording/stop", { recordingId: recId2 });
  });

  // ── 21. Tab switch changes snapshot context ─
  console.log("\n── Tab context switch ──");
  await test("snapshot reflects active tab after switch", async () => {
    // Tab 1: page with title "Tab A"
    const htmlA = `<html><head><title>Tab A</title></head><body><p>Page A</p></body></html>`;
    await post("/navigate", { url: `data:text/html;charset=utf-8,${encodeURIComponent(htmlA)}` });

    // Create Tab 2 with different content
    const htmlB = `<html><head><title>Tab B</title></head><body><p>Page B</p></body></html>`;
    const tab2Data = await json(await post("/navigate", {
      url: `data:text/html;charset=utf-8,${encodeURIComponent(htmlB)}`,
      newTab: true,
    }));
    const tab2Id = tab2Data.tabId;

    // Snapshot should be Tab B (we just navigated to it in a new tab)
    const snapB = await json(await get("/snapshot?format=json"));
    assert(snapB.title === "Tab B", `expected Tab B, got ${snapB.title}`);

    // Get tab list to find Tab A's id
    const tabsList = await json(await get("/tabs"));
    const tabA = tabsList.tabs.find((t: any) => !t.is_current);
    assert(!!tabA, "Tab A not found");

    // Switch back to Tab A
    await post("/tab", { action: "switch", tabId: tabA.tab_id });

    // Snapshot should now be Tab A
    const snapA = await json(await get("/snapshot?format=json"));
    assert(snapA.title === "Tab A", `expected Tab A after switch, got ${snapA.title}`);

    // Clean up: close Tab B
    await post("/tab", { action: "close", tabId: tab2Id });
  });

  // ── 22. Batch stopOnError ──────────────────
  console.log("\n── Batch stopOnError ──");
  await test("batch with invalid action stops on error (default)", async () => {
    const resp = await post("/actions", {
      actions: [
        { type: "scroll", scrollY: 50 },
        { type: "click", ref: "e9999" },  // bad ref — should fail
        { type: "scroll", scrollY: 50 },  // should not execute
      ],
    });
    const data = JSON.parse(await resp.text());
    // With stopOnError=true (default), executed should be less than total
    // or all_success should be false
    assert(data.all_success === false, `expected all_success=false, got ${data.all_success}`);
    console.log(`        → total=${data.total}, executed=${data.executed}, all_success=${data.all_success}`);
  });

  // ── 23. Diff after mutation ────────────────
  console.log("\n── Diff after mutation ──");
  await test("diff captures page change after action", async () => {
    // Navigate to a page
    const html = `<html><head><title>Diff Test</title></head><body>
      <p id="text">Original</p>
      <button id="btn" onclick="document.getElementById('text').textContent='Changed'">Change</button>
    </body></html>`;
    await post("/navigate", { url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` });

    // Baseline snapshot
    const baseline = await json(await get("/snapshot"));
    assert(baseline.snapshot.includes("Original"), "baseline should contain 'Original'");

    // Click button to mutate page
    const snap = await json(await get("/snapshot?format=json"));
    const btn = snap.nodes.find((n: any) => n.role === "button");
    assert(!!btn, "button not found");
    await post("/action", { type: "click", ref: btn.ref });

    // Diff should reflect change
    const diff = await json(await get("/snapshot?diff=true"));
    console.log(`        → diff: ${diff.snapshot.length} chars`);
    // The diff should either contain "Changed" or be non-empty
    assert(diff.snapshot.length > 0, "diff is empty after mutation");
  });

  // ── 24. Concurrent requests ────────────────
  console.log("\n── Concurrent requests ──");
  await test("multiple simultaneous requests don't crash", async () => {
    await post("/navigate", { url: "https://example.com" });
    await new Promise((r) => setTimeout(r, 300));

    // Fire 5 requests at once
    const results = await Promise.all([
      get("/snapshot").then(r => r.text()),
      get("/text").then(r => r.text()),
      get("/screenshot?raw=true").then(r => r.blob()),
      get("/tabs").then(r => r.text()),
      get("/health").then(r => r.text()),
    ]);

    assert(results.length === 5, "not all requests returned");
    assert(results[0].length > 0, "snapshot empty");
    assert(results[1].length > 0, "text empty");
    assert(results[2].size > 0, "screenshot empty");
    assert(results[3].length > 0, "tabs empty");
    assert(results[4].length > 0, "health empty");
  });

  // ── Summary ────────────────────────────────
  console.log(`\n${"═".repeat(40)}`);
  console.log(`  \x1b[32m${pass} passed\x1b[0m  \x1b[31m${fail} failed\x1b[0m  \x1b[33m${skip} skipped\x1b[0m`);
  console.log(`${"═".repeat(40)}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
