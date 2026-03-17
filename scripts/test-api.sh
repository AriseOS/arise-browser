#!/bin/bash
#
# AriseBrowser API smoke tests using curl.
#
# Usage:
#   1. Start server: node dist/bin/arise-browser.js --no-headless --port 16473
#   2. Run tests:    bash scripts/test-api.sh [base_url]
#

BASE="${1:-http://localhost:16473}"
PASS=0
FAIL=0

pass() { echo "  \033[32mPASS\033[0m  $1"; PASS=$((PASS + 1)); }
fail() { echo "  \033[31mFAIL\033[0m  $1"; echo "        $2"; FAIL=$((FAIL + 1)); }

check_json() {
  local name="$1" expected="$2" actual="$3"
  if echo "$actual" | grep -q "$expected"; then pass "$name"; else fail "$name" "expected '$expected' in: $(echo "$actual" | head -c 200)"; fi
}

check_status() {
  local name="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then pass "$name"; else fail "$name" "expected HTTP $expected, got $actual"; fi
}

echo "=== AriseBrowser API Tests (curl) ==="
echo "Base URL: $BASE"
echo ""

# ── Health ──
echo "── GET /health ──"
RESP=$(curl -s "$BASE/health")
check_json "status ok" '"status":"ok"' "$RESP"
check_json "version present" '"version"' "$RESP"

# ── Navigate ──
echo ""
echo "── POST /navigate ──"
RESP=$(curl -s -X POST "$BASE/navigate" -H "Content-Type: application/json" -d '{"url":"https://example.com"}')
check_json "url in response" '"url"' "$RESP"
check_json "title in response" '"title"' "$RESP"

STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/navigate" -H "Content-Type: application/json" -d '{}')
check_status "missing url returns 400" "400" "$STATUS"

# ── Snapshot: yaml ──
echo ""
echo "── GET /snapshot ──"
RESP=$(curl -s "$BASE/snapshot")
check_json "yaml: snapshot field" '"snapshot"' "$RESP"

# ── Snapshot: json ──
echo ""
echo "── GET /snapshot?format=json ──"
RESP=$(curl -s "$BASE/snapshot?format=json")
check_json "json: nodes" '"nodes"' "$RESP"
check_json "json: url" '"url"' "$RESP"
check_json "json: title" '"title"' "$RESP"
check_json "json: count" '"count"' "$RESP"

# ── Snapshot: compact ──
echo ""
echo "── GET /snapshot?format=compact ──"
CT=$(curl -s -o /dev/null -w '%{content_type}' "$BASE/snapshot?format=compact")
RESP=$(curl -s "$BASE/snapshot?format=compact")
check_json "compact: text/plain" 'text/plain' "$CT"
if echo "$RESP" | head -c 1 | grep -q '{'; then fail "compact not JSON" "starts with {"; else pass "compact not JSON"; fi

# ── Snapshot: text ──
echo ""
echo "── GET /snapshot?format=text ──"
CT=$(curl -s -o /dev/null -w '%{content_type}' "$BASE/snapshot?format=text")
check_json "text: text/plain" 'text/plain' "$CT"

# ── Snapshot: interactive filter ──
echo ""
echo "── GET /snapshot?filter=interactive ──"
RESP=$(curl -s "$BASE/snapshot?format=json&filter=interactive")
check_json "interactive: nodes" '"nodes"' "$RESP"

# ── Snapshot: diff mode ──
echo ""
echo "── GET /snapshot?diff=true ──"
RESP=$(curl -s "$BASE/snapshot?diff=true")
check_json "diff: snapshot field" '"snapshot"' "$RESP"

# ── Snapshot: viewport limit ──
echo ""
echo "── GET /snapshot?viewportLimit=true ──"
RESP=$(curl -s "$BASE/snapshot?format=json&viewportLimit=true")
check_json "viewportLimit: nodes" '"nodes"' "$RESP"

# ── Text ──
echo ""
echo "── GET /text ──"
RESP=$(curl -s "$BASE/text")
check_json "text field" '"text"' "$RESP"
check_json "url field" '"url"' "$RESP"
check_json "title field" '"title"' "$RESP"

# ── Screenshot ──
echo ""
echo "── GET /screenshot ──"
CT=$(curl -s -o /dev/null -w '%{content_type}' "$BASE/screenshot?raw=true")
check_json "raw: image/jpeg" 'image/jpeg' "$CT"
SIZE=$(curl -s -o /dev/null -w '%{size_download}' "$BASE/screenshot?raw=true")
if [ "$SIZE" -gt 1000 ]; then pass "screenshot size ${SIZE}B"; else fail "screenshot too small" "${SIZE}B"; fi

# ── Evaluate ──
echo ""
echo "── POST /evaluate ──"
RESP=$(curl -s -X POST "$BASE/evaluate" -H "Content-Type: application/json" -d '{"expression":"1+1"}')
check_json "expression: result" '"result":2' "$RESP"

RESP=$(curl -s -X POST "$BASE/evaluate" -H "Content-Type: application/json" -d '{"code":"document.title"}')
check_json "code (compat): result" '"result"' "$RESP"

# ── Action: scroll ──
echo ""
echo "── POST /action ──"
RESP=$(curl -s -X POST "$BASE/action" -H "Content-Type: application/json" -d '{"kind":"scroll","direction":"down","amount":300}')
check_json "scroll (kind): success" '"success"' "$RESP"

RESP=$(curl -s -X POST "$BASE/action" -H "Content-Type: application/json" -d '{"type":"scroll","scrollY":-300}')
check_json "scroll (type): success" '"success"' "$RESP"

# ── Action: missing type returns 400 ──
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/action" -H "Content-Type: application/json" -d '{}')
check_status "missing type returns 400" "400" "$STATUS"

# ── Navigate to form page for interaction tests ──
echo ""
echo "── Interaction tests (click, type, select) ──"
HTML='<html><head><title>Test Form</title></head><body><input id="name" aria-label="Name"/><button id="btn" onclick="document.title='"'"'clicked'"'"'">Click Me</button><select id="color" aria-label="Color"><option value="red">Red</option><option value="blue">Blue</option></select></body></html>'
ENCODED=$(python3 -c "import urllib.parse; print(urllib.parse.quote('''$HTML'''))")
curl -s -X POST "$BASE/navigate" -H "Content-Type: application/json" -d "{\"url\":\"data:text/html;charset=utf-8,$ENCODED\"}" > /dev/null

# Get refs from snapshot
SNAP=$(curl -s "$BASE/snapshot?format=json")
BTN_REF=$(echo "$SNAP" | python3 -c "import sys,json;d=json.load(sys.stdin);print(next((n['ref'] for n in d.get('nodes',[]) if n.get('role')=='button'),''))" 2>/dev/null)
INPUT_REF=$(echo "$SNAP" | python3 -c "import sys,json;d=json.load(sys.stdin);print(next((n['ref'] for n in d.get('nodes',[]) if n.get('role')=='textbox'),''))" 2>/dev/null)
SELECT_REF=$(echo "$SNAP" | python3 -c "import sys,json;d=json.load(sys.stdin);print(next((n['ref'] for n in d.get('nodes',[]) if n.get('role')=='combobox'),''))" 2>/dev/null)

if [ -n "$BTN_REF" ]; then
  RESP=$(curl -s -X POST "$BASE/action" -H "Content-Type: application/json" -d "{\"type\":\"click\",\"ref\":\"$BTN_REF\"}")
  check_json "click button" '"success"' "$RESP"
  RESP=$(curl -s -X POST "$BASE/evaluate" -H "Content-Type: application/json" -d '{"expression":"document.title"}')
  check_json "click verified" '"clicked"' "$RESP"
else
  fail "click button" "button ref not found"
fi

if [ -n "$INPUT_REF" ]; then
  RESP=$(curl -s -X POST "$BASE/action" -H "Content-Type: application/json" -d "{\"type\":\"type\",\"ref\":\"$INPUT_REF\",\"text\":\"Hello\"}")
  check_json "type into input" '"success"' "$RESP"
else
  fail "type into input" "input ref not found"
fi

if [ -n "$SELECT_REF" ]; then
  RESP=$(curl -s -X POST "$BASE/action" -H "Content-Type: application/json" -d "{\"type\":\"select\",\"ref\":\"$SELECT_REF\",\"value\":\"blue\"}")
  check_json "select option" '"success"' "$RESP"
else
  fail "select option" "select ref not found"
fi

# ── Batch actions ──
echo ""
echo "── POST /actions (batch) ──"
RESP=$(curl -s -X POST "$BASE/actions" -H "Content-Type: application/json" -d '{"actions":[{"type":"scroll","scrollY":100},{"type":"scroll","scrollY":-100}]}')
check_json "batch: all_success" '"all_success":true' "$RESP"
check_json "batch: total=2" '"total":2' "$RESP"

STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/actions" -H "Content-Type: application/json" -d '{"actions":[]}')
check_status "batch empty returns 400" "400" "$STATUS"

# ── Tabs ──
echo ""
echo "── Tabs ──"
RESP=$(curl -s "$BASE/tabs")
check_json "GET /tabs" '"tabs"' "$RESP"

RESP=$(curl -s -X POST "$BASE/tab" -H "Content-Type: application/json" -d '{"action":"create"}')
check_json "create tab" '"created"' "$RESP"
TAB_ID=$(echo "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('tabId',''))" 2>/dev/null)

if [ -n "$TAB_ID" ]; then
  RESP=$(curl -s -X POST "$BASE/tab" -H "Content-Type: application/json" -d "{\"action\":\"switch\",\"tabId\":\"$TAB_ID\"}")
  check_json "switch tab" '"switched"' "$RESP"
  RESP=$(curl -s -X POST "$BASE/tab" -H "Content-Type: application/json" -d "{\"action\":\"close\",\"tabId\":\"$TAB_ID\"}")
  check_json "close tab" '"closed"' "$RESP"
fi

# ── Tab locks ──
echo ""
echo "── Tab Locks ──"
TABS_RESP=$(curl -s "$BASE/tabs")
FIRST_TAB=$(echo "$TABS_RESP" | python3 -c "import sys,json;tabs=json.load(sys.stdin).get('tabs',[]);print(tabs[0].get('id',tabs[0].get('tabId','')))" 2>/dev/null)

if [ -n "$FIRST_TAB" ]; then
  RESP=$(curl -s -X POST "$BASE/tab/lock" -H "Content-Type: application/json" -d "{\"tabId\":\"$FIRST_TAB\",\"owner\":\"agent-1\",\"ttlMs\":30000}")
  check_json "lock tab" '"lock"' "$RESP"

  STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/tab/lock" -H "Content-Type: application/json" -d "{\"tabId\":\"$FIRST_TAB\",\"owner\":\"agent-2\"}")
  check_status "lock conflict 409" "409" "$STATUS"

  RESP=$(curl -s -X POST "$BASE/tab/unlock" -H "Content-Type: application/json" -d "{\"tabId\":\"$FIRST_TAB\",\"owner\":\"agent-1\"}")
  check_json "unlock tab" '"released":true' "$RESP"
fi

# ── Recording ──
echo ""
echo "── Recording ──"
RESP=$(curl -s -X POST "$BASE/recording/start" -H "Content-Type: application/json" -d '{}')
check_json "start recording" '"recordingId"' "$RESP"
REC_ID=$(echo "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('recordingId',''))" 2>/dev/null)

if [ -n "$REC_ID" ]; then
  RESP=$(curl -s "$BASE/recording/status?recordingId=$REC_ID")
  check_json "status: active" '"active":true' "$RESP"

  RESP=$(curl -s "$BASE/recording/status")
  check_json "status: list all" '"recordings"' "$RESP"

  # Perform action while recording
  curl -s -X POST "$BASE/navigate" -H "Content-Type: application/json" -d '{"url":"https://example.com"}' > /dev/null
  sleep 0.5

  RESP=$(curl -s -X POST "$BASE/recording/stop" -H "Content-Type: application/json" -d "{\"recordingId\":\"$REC_ID\"}")
  pass "stop recording"

  RESP=$(curl -s -X POST "$BASE/recording/export" -H "Content-Type: application/json" -d "{\"recordingId\":\"$REC_ID\",\"task\":\"Test nav\"}")
  check_json "export: type" '"browser_workflow"' "$RESP"
  check_json "export: source" '"arise-browser"' "$RESP"
  check_json "export: steps" '"steps"' "$RESP"
fi

STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/recording/stop" -H "Content-Type: application/json" -d '{}')
check_status "stop missing id 400" "400" "$STATUS"

STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/recording/stop" -H "Content-Type: application/json" -d '{"recordingId":"nonexistent"}')
check_status "stop unknown id 404" "404" "$STATUS"

# ── Cookies ──
echo ""
echo "── Cookies ──"
RESP=$(curl -s -X POST "$BASE/cookies" -H "Content-Type: application/json" -d '{"cookies":[{"name":"test_ck","value":"v1","url":"https://example.com"}]}')
check_json "set cookie" '"set":1' "$RESP"

RESP=$(curl -s "$BASE/cookies")
check_json "get cookies" '"cookies"' "$RESP"
check_json "cookie value" '"test_ck"' "$RESP"

# ── PDF ──
echo ""
echo "── GET /pdf ──"
CT=$(curl -s -o /dev/null -w '%{content_type}' "$BASE/pdf")
SIZE=$(curl -s -o /dev/null -w '%{size_download}' "$BASE/pdf")
if [ "$SIZE" -gt 100 ]; then pass "pdf size ${SIZE}B"; else fail "pdf too small" "${SIZE}B"; fi

# ── Summary ──
echo ""
echo "════════════════════════════════════════"
echo "  \033[32m$PASS passed\033[0m  \033[31m$FAIL failed\033[0m"
echo "════════════════════════════════════════"
exit $FAIL
