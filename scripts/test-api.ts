#!/usr/bin/env -S node --import=tsx
/**
 * AmiPilot API test script (TypeScript).
 *
 * Usage:
 *   1. Start server: node dist/bin/amipilot.js --no-headless --port 9867
 *   2. Run: npx tsx scripts/test-api.ts [base_url]
 */

const BASE = process.argv[2] || "http://localhost:9867";

let pass = 0;
let fail = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  PASS: ${name}`);
    pass++;
  } catch (e: any) {
    console.log(`  FAIL: ${name}`);
    console.log(`    ${e.message}`);
    fail++;
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

async function main() {
  console.log("=== AmiPilot API Tests (TypeScript) ===");
  console.log(`Base URL: ${BASE}\n`);

  // 1. Health
  console.log("--- GET /health ---");
  await test("status ok", async () => {
    const resp = await fetch(`${BASE}/health`);
    assert(resp.ok, `HTTP ${resp.status}`);
    const data = await resp.json() as any;
    assert(data.status === "ok", `expected status=ok, got ${data.status}`);
    assert(typeof data.version === "string", "missing version");
  });

  // 2. Navigate
  console.log("--- POST /navigate ---");
  await test("navigate returns url and title", async () => {
    const resp = await fetch(`${BASE}/navigate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    assert(resp.ok, `HTTP ${resp.status}`);
    const data = await resp.json() as any;
    assert(typeof data.url === "string" && data.url.includes("example.com"), `unexpected url: ${data.url}`);
    assert("title" in data, "missing title field");
  });

  // 3. Snapshot (yaml — default)
  console.log("--- GET /snapshot ---");
  await test("snapshot returns JSON with snapshot field", async () => {
    const resp = await fetch(`${BASE}/snapshot`);
    assert(resp.ok, `HTTP ${resp.status}`);
    const data = await resp.json() as any;
    assert(typeof data.snapshot === "string", "missing snapshot field");
  });

  // 4. Snapshot JSON format
  console.log("--- GET /snapshot?format=json ---");
  await test("json snapshot returns nodes, url, title", async () => {
    const resp = await fetch(`${BASE}/snapshot?format=json`);
    assert(resp.ok, `HTTP ${resp.status}`);
    const data = await resp.json() as any;
    assert(Array.isArray(data.nodes), "nodes is not an array");
    assert(typeof data.url === "string", "missing url");
    assert(typeof data.title === "string", "missing title");
  });

  // 5. Snapshot compact format (plain text)
  console.log("--- GET /snapshot?format=compact ---");
  await test("compact returns text/plain", async () => {
    const resp = await fetch(`${BASE}/snapshot?format=compact`);
    assert(resp.ok, `HTTP ${resp.status}`);
    const ct = resp.headers.get("content-type") || "";
    assert(ct.includes("text/plain"), `expected text/plain, got ${ct}`);
    const text = await resp.text();
    assert(!text.startsWith("{"), "compact should not return JSON");
  });

  // 6. Snapshot text format (plain text)
  console.log("--- GET /snapshot?format=text ---");
  await test("text returns text/plain", async () => {
    const resp = await fetch(`${BASE}/snapshot?format=text`);
    assert(resp.ok, `HTTP ${resp.status}`);
    const ct = resp.headers.get("content-type") || "";
    assert(ct.includes("text/plain"), `expected text/plain, got ${ct}`);
  });

  // 7. Text extraction
  console.log("--- GET /text ---");
  await test("text returns text, url, title", async () => {
    const resp = await fetch(`${BASE}/text`);
    assert(resp.ok, `HTTP ${resp.status}`);
    const data = await resp.json() as any;
    assert(typeof data.text === "string", "missing text");
    assert(typeof data.url === "string", "missing url");
    assert(typeof data.title === "string", "missing title");
  });

  // 8. Action (scroll)
  console.log("--- POST /action (scroll) ---");
  await test("scroll action", async () => {
    const resp = await fetch(`${BASE}/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "scroll", direction: "down", amount: 300 }),
    });
    assert(resp.ok, `HTTP ${resp.status}`);
    const data = await resp.json() as any;
    assert("success" in data, "missing success field");
  });

  // 9. Evaluate with "code" field (Pinchtab compat)
  console.log("--- POST /evaluate (code field) ---");
  await test("evaluate with code field", async () => {
    const resp = await fetch(`${BASE}/evaluate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "document.title" }),
    });
    assert(resp.ok, `HTTP ${resp.status}`);
    const data = await resp.json() as any;
    assert("result" in data, "missing result field");
  });

  // 10. Evaluate with "expression" field (native)
  console.log("--- POST /evaluate (expression field) ---");
  await test("evaluate with expression field", async () => {
    const resp = await fetch(`${BASE}/evaluate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expression: "1 + 1" }),
    });
    assert(resp.ok, `HTTP ${resp.status}`);
    const data = await resp.json() as any;
    assert(data.result === 2, `expected 2, got ${data.result}`);
  });

  // 11. Screenshot (raw JPEG)
  console.log("--- GET /screenshot?raw=true ---");
  await test("raw screenshot returns image/jpeg", async () => {
    const resp = await fetch(`${BASE}/screenshot?raw=true`);
    assert(resp.ok, `HTTP ${resp.status}`);
    const ct = resp.headers.get("content-type") || "";
    assert(ct.includes("image/jpeg"), `expected image/jpeg, got ${ct}`);
    const blob = await resp.blob();
    assert(blob.size > 1000, `screenshot too small: ${blob.size} bytes`);
  });

  // 12. Snapshot with filter=interactive
  console.log("--- GET /snapshot?format=json&filter=interactive ---");
  await test("interactive filter returns nodes", async () => {
    const resp = await fetch(`${BASE}/snapshot?format=json&filter=interactive`);
    assert(resp.ok, `HTTP ${resp.status}`);
    const data = await resp.json() as any;
    assert(Array.isArray(data.nodes), "nodes is not an array");
    // Interactive-only should have fewer or equal nodes
    const allResp = await fetch(`${BASE}/snapshot?format=json`);
    const allData = await allResp.json() as any;
    assert(data.count <= allData.count, `interactive (${data.count}) > all (${allData.count})`);
  });

  console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
