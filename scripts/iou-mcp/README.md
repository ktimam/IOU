# IOU MCP connector (chat → draft)

The chat-bridge **connector** (Milestone 1 of `docs/chat-agent.md`). The user's
own Claude (or ChatGPT) does the screenshot vision/extraction on their own
subscription — **no developer API key** — and calls the `prepare_iou_entry`
tool. The connector validates + normalizes the extracted fields into a canonical
IOU **draft** and hands it back; the **encrypted write happens later, on the
user's device, in the IOU app's confirm screen** (the M0 "✨ Import"
importer). 

**Key-blind by construction.** The connector never touches `K_sheet`, the IC
identity, or the canister — it only validates a draft. So it adds **no
key-custody trust surface**: it only ever sees the draft fields, which the user
already handed to their AI. It reuses `src/features/entries/draft.ts`, so the
connector and the app can't drift on validation or the idempotency `draft_id`.

## Files
- `draftResult.ts` — transport-agnostic core: `buildDraftResult(input)` →
  validated `CanonicalDraft` + `draft_id` + paste-JSON + deep link (reuses the
  app's `parseDraft`). No MCP/SDK/replica dependency.
- `server.ts` — a **local stdio** MCP server exposing `prepare_iou_entry`,
  wiring the SDK to `buildDraftResult`.
- `selftest.ts` — headless test of the core (no SDK, no replica, no Claude).

## Try it (local, desktop Claude)
```sh
# 1. Verify the core (no deps needed):
pnpm mcp:selftest            # → "16 passed, 0 failed"

# 2. Install the MCP SDK (declared in package.json devDependencies):
pnpm install                 # fetches @modelcontextprotocol/sdk

# 3a. Register with Claude Code:
claude mcp add --transport stdio iou -- pnpm exec tsx scripts/iou-mcp/server.ts
#  or 3b. Claude Desktop (claude_desktop_config.json):
#  "mcpServers": { "iou": { "command": "pnpm", "args": ["exec","tsx","scripts/iou-mcp/server.ts"], "cwd": "C:/Kiko/MyProjects/IOU" } }
```
Then in Claude: paste a transfer screenshot → *"add this to IOU."* Claude calls
`prepare_iou_entry`; you get a confirmed draft JSON to paste into the IOU app's
**✨ Import** importer (review → confirm → on-device encrypted write).

> ⚠️ Local stdio works on **desktop** Claude only. Phones can't run a local MCP
> (`docs/chat-agent.md`), so the mobile flow needs the **remote** deployment below.

## Mobile / remote deployment (NOT built — design to confirm first)
The owner's target is **mobile Claude**. The same `buildDraftResult` handler
moves behind a **remote Streamable-HTTP MCP transport**, plus the pieces from
the silent-bg-write design (`docs/chat-agent.md` → *Mobile bridge*):

1. **Remote MCP server** (public HTTPS; added once on claude.ai web, syncs to
   mobile). **OAuth 2.1 + PKCE** authenticates the Claude user and maps that
   subject → an IOU user record (device push token(s) + target sheet). Still
   key-blind.
2. **Wake-and-fetch relay** (co-hosted): stores the short-lived pending draft
   keyed by `draft_id`; the IOU app pulls it over TLS authenticated by the
   **on-device IC identity** (signed challenge). The push carries only an opaque
   pointer.
3. **Push backend** (FCM now; APNs later): a **visible "Add to IOU"
   notification** (the dependable trigger) and — Android only — an opportunistic
   silent data message.
4. **IOU app**: a "Pending from chat" **inbox** (drains on foreground) + a
   notification-tap handler, both feeding the existing M0 confirm→encrypt→
   `add_entry` seam. The on-device app is the only thing that holds `K_sheet`.

**Open security decisions to confirm before building 1–4** (they introduce a
server in the data path + identity mapping + device tokens):
- OAuth subject → IOU principal mapping (no guaranteed stable `sub`); how the
  app proves its IC identity to the relay to fetch its own drafts.
- Draft exposure: the relay/connector see the draft plaintext (same content the
  AI already saw). Confirm that's acceptable; never put `K_sheet`/secrets in a
  push or link.
- Hosting/trust of the relay (self-host vs developer-host) and token storage.

See `docs/chat-agent.md` for the full feasibility verdict (silent write is a
best-effort Android accelerator; the visible-tap notification + inbox is the
dependable mechanism; iOS silent is non-viable).
