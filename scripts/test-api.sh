#!/bin/bash
#
# AriseBrowser API smoke tests using curl.
#
# Usage:
#   1. Start server: node dist/bin/arise-browser.js --no-headless --port 9867
#   2. Run tests:    bash scripts/test-api.sh [base_url]
#

BASE="${1:-http://localhost:9867}"
PASS=0
FAIL=0

check() {
  local name="$1"
  local expected="$2"
  local actual="$3"

  if echo "$actual" | grep -q "$expected"; then
    echo "  PASS: $name"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $name"
    echo "    expected to contain: $expected"
    echo "    got: $(echo "$actual" | head -c 200)"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== AriseBrowser API Tests ==="
echo "Base URL: $BASE"
echo ""

# 1. Health check
echo "--- GET /health ---"
RESP=$(curl -s "$BASE/health")
check "status ok" '"status":"ok"' "$RESP"
check "version present" '"version"' "$RESP"

# 2. Navigate to example.com
echo "--- POST /navigate ---"
RESP=$(curl -s -X POST "$BASE/navigate" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}')
check "url in response" '"url"' "$RESP"
check "title in response" '"title"' "$RESP"

# 3. Snapshot (default yaml format — returns JSON wrapper)
echo "--- GET /snapshot ---"
RESP=$(curl -s "$BASE/snapshot")
check "snapshot field" '"snapshot"' "$RESP"

# 4. Snapshot JSON format
echo "--- GET /snapshot?format=json ---"
RESP=$(curl -s "$BASE/snapshot?format=json")
check "nodes array" '"nodes"' "$RESP"
check "url field" '"url"' "$RESP"
check "title field" '"title"' "$RESP"

# 5. Snapshot compact format (plain text)
echo "--- GET /snapshot?format=compact ---"
CT=$(curl -s -o /dev/null -w '%{content_type}' "$BASE/snapshot?format=compact")
RESP=$(curl -s "$BASE/snapshot?format=compact")
check "content-type text" 'text/plain' "$CT"
# Compact response should NOT be JSON-wrapped
if echo "$RESP" | head -c 1 | grep -q '{'; then
  echo "  FAIL: compact returned JSON instead of plain text"
  FAIL=$((FAIL + 1))
else
  echo "  PASS: compact returns plain text"
  PASS=$((PASS + 1))
fi

# 6. Snapshot text format (plain text)
echo "--- GET /snapshot?format=text ---"
CT=$(curl -s -o /dev/null -w '%{content_type}' "$BASE/snapshot?format=text")
check "content-type text" 'text/plain' "$CT"

# 7. Text extraction
echo "--- GET /text ---"
RESP=$(curl -s "$BASE/text")
check "text field" '"text"' "$RESP"
check "url field" '"url"' "$RESP"
check "title field" '"title"' "$RESP"

# 8. Action (scroll)
echo "--- POST /action (scroll) ---"
RESP=$(curl -s -X POST "$BASE/action" \
  -H "Content-Type: application/json" \
  -d '{"kind":"scroll","direction":"down","amount":300}')
check "action result" '"success"' "$RESP"

# 9. Evaluate with "code" field (Pinchtab compat)
echo "--- POST /evaluate (code field) ---"
RESP=$(curl -s -X POST "$BASE/evaluate" \
  -H "Content-Type: application/json" \
  -d '{"code":"document.title"}')
check "result field" '"result"' "$RESP"

# 10. Evaluate with "expression" field (native)
echo "--- POST /evaluate (expression field) ---"
RESP=$(curl -s -X POST "$BASE/evaluate" \
  -H "Content-Type: application/json" \
  -d '{"expression":"document.title"}')
check "result field" '"result"' "$RESP"

# 11. Screenshot raw
echo "--- GET /screenshot?raw=true ---"
CT=$(curl -s -o /dev/null -w '%{content_type}' "$BASE/screenshot?raw=true")
check "content-type jpeg" 'image/jpeg' "$CT"
SIZE=$(curl -s -o /dev/null -w '%{size_download}' "$BASE/screenshot?raw=true")
if [ "$SIZE" -gt 1000 ]; then
  echo "  PASS: screenshot size ${SIZE} bytes"
  PASS=$((PASS + 1))
else
  echo "  FAIL: screenshot too small (${SIZE} bytes)"
  FAIL=$((FAIL + 1))
fi

# 12. Snapshot with filter=interactive
echo "--- GET /snapshot?format=json&filter=interactive ---"
RESP=$(curl -s "$BASE/snapshot?format=json&filter=interactive")
check "nodes array" '"nodes"' "$RESP"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
exit $FAIL
