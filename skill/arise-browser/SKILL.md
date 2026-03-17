---
name: arise-browser
description: >
  Browser automation for AI agents — control Chrome via HTTP API with persistent element refs,
  YAML accessibility snapshots, and WebRTC live streaming via Neko. Install once, navigate/snapshot/act loop.
homepage: https://github.com/AriseOS/arise-browser
metadata:
  openclaw:
    emoji: "🌐"
    requires:
      bins: ["npx", "docker"]
---

# AriseBrowser

You are controlling a **real Chrome browser**, like a human sitting in front of a screen. You see the page through snapshots, and you interact by clicking, typing, and selecting — not by writing JavaScript or constructing URLs.

## MANDATORY RULES

**You MUST follow these rules. No exceptions.**

1. **Wait for ready.** Do NOT call any endpoint until `/health` returns `{"connected":true}`.
2. **Snapshot is your eyes.** After every navigate or significant action, call `/snapshot` to see what's on the page. Read the snapshot to find element refs (e0, e5, e12...) and understand the page structure.
3. **Act through refs.** To click a button, select a dropdown, or type in a field — use `/action` with the ref from your snapshot. Do NOT construct URLs with query parameters to change page state. Use `select`, `click`, and `type` actions instead.
4. **NEVER use `/evaluate` to extract data.** The snapshot already contains all visible text, links, buttons, and form elements in a structured format. `/evaluate` is only for rare edge cases where data is hidden from the accessibility tree.
5. **NEVER use `/text` as your primary data source.** `/text` returns unstructured plain text that is hard to parse. Use `/snapshot` — it gives you structured elements with refs, roles, names, and links.
6. **Refs are persistent.** Do NOT re-snapshot just to reuse a ref. Only re-snapshot when the page content changes.

## How to Think

You are a person using a browser. Snapshot is your eyes, action is your hands.

- **To sort results** → find the sort dropdown in the snapshot → use `select` action on its ref
- **To search** → find the search box ref → `type` your query → `press_key` Enter
- **To go to next page** → find the "Next" button ref → `click` it
- **To read product info** → it's already in the snapshot (names, prices, ratings are all there as text)

### Example: Sort Amazon results by Best Sellers

```bash
# 1. Navigate
curl -X POST /navigate -d '{"url": "https://amazon.com/s?k=laptop"}'

# 2. Snapshot — see the page
curl /snapshot
# → combobox "Sort by:" [ref=e187] with options including "Best Sellers"
# → link "Product Name" [ref=e226], generic "4.4" [ref=e231], link "$599" [ref=e246]

# 3. Select from dropdown using ref
curl -X POST /action -d '{"type": "select", "ref": "e187", "value": "exact-aware-popularity-rank"}'

# 4. Snapshot again — results are now sorted
curl /snapshot
# → Read product names, prices, ratings directly from snapshot text
```

## Step 1: Start the Server

Requires Docker and Node.js. If arise-browser is not installed:
```bash
npm install -g arise-browser
```

Start:
```bash
npx arise-browser --virtual-display --port 9867 &
```

**Wait for ready (MANDATORY):**
```bash
until curl -s http://localhost:9867/health 2>/dev/null | grep -q '"connected":true'; do sleep 2; done
```

First run takes ~2 minutes (Docker pulls Neko Chrome image ~700MB).

### Tell the user

After installation succeeds, inform the user:

1. **Watch the browser**: Open `http://localhost:6090` in your browser, password: `neko`
2. **Remote access**: Add `--host 0.0.0.0` and `ARISE_BROWSER_TOKEN=<secret>` to the start command, then open ports `9867/tcp`, `6090/tcp`, `52000-52100/udp` in your firewall.
3. **Passwords**: Change default Neko passwords via `--neko-password` and `--neko-admin-password` flags.

## Step 2: Core Loop

Base URL: `http://localhost:9867`

### Navigate to a URL

```bash
curl -X POST http://localhost:9867/navigate \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'
```

### Snapshot — see the page

Returns a YAML accessibility tree. Every interactive element has a ref you can act on.

```bash
curl http://localhost:9867/snapshot
```

What you'll see in a snapshot:
```yaml
- combobox "Sort by:" [ref=e187]        ← dropdown, use select action
- link "Product Name" [ref=e226]         ← clickable link
- textbox "Search" [ref=e14]             ← input field, use type action
- button "Add to cart" [ref=e281]        ← button, use click action
- generic "4.4" [ref=e231]              ← text content (rating)
- generic "$599.99" [ref=e246]          ← text content (price)
```

Use `?diff=true` after the first snapshot to only see changes (saves tokens).

### Act — interact with elements

Use the ref from your snapshot:

```bash
# Click a link or button
curl -X POST http://localhost:9867/action -H "Content-Type: application/json" \
  -d '{"type": "click", "ref": "e226"}'

# Type in a text field
curl -X POST http://localhost:9867/action -H "Content-Type: application/json" \
  -d '{"type": "type", "ref": "e14", "text": "search query"}'

# Press a key (Enter, Tab, Escape, etc.)
curl -X POST http://localhost:9867/action -H "Content-Type: application/json" \
  -d '{"type": "press_key", "key": "Enter"}'

# Select from a dropdown
curl -X POST http://localhost:9867/action -H "Content-Type: application/json" \
  -d '{"type": "select", "ref": "e187", "value": "option-value"}'

# Scroll down
curl -X POST http://localhost:9867/action -H "Content-Type: application/json" \
  -d '{"type": "scroll", "direction": "down", "amount": 500}'
```

### Repeat

After each action that changes the page, snapshot again to see the result. Then act on the new refs.

## Step 3: Stop

```bash
kill $(pgrep -f "arise-browser")
```

The Docker container is automatically stopped and cleaned up.

## Tips

- **Read the snapshot carefully.** Product names, prices, ratings, links — they're all there. No need for JavaScript or regex.
- Use `?diff=true` after the first snapshot to save tokens.
- Batch actions: `POST /actions` with `{"actions": [...], "stopOnError": true}`.
- Tabs: `GET /tabs`, `POST /tab` with `{"action": "create|switch|close"}`.
- Screenshot (`GET /screenshot`) is useful to show the user what you see.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| First run slow | Docker pulling Neko image (~700MB), wait ~2 min |
| Health returns `connected: false` | Chrome crashed — restart arise-browser |
| Neko UI loads but no video | Open UDP 52000-52100 in firewall/security group |
| Action returns error | Snapshot first to get valid refs, then act on them |
| Can't find an element | Scroll down and snapshot again — element may be below the fold |
