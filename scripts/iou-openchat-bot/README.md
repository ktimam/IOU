# IOU ↔ OpenChat connector bot

The off-chain bridge between OpenChat's ActionCard confirm flow (OpenChat PR-B)
and IOU's key-blind relay. **All IOU-specific logic lives here / in the IOU
repo — nothing about IOU is in OpenChat** (the OpenChat side is the generic
ActionCard + on-device model + AI-action hook).

## How it works (the real contract, read from the fork)

On Confirm, OpenChat forwards the ActionCard event to the registered bot
endpoint via `notification_pusher`:

```
POST {bot-endpoint}/notify
  header  x-oc-signature: base64url ES256 signature over the raw body
  body    the MessageActionCardResponse event (action_id, response, responder, rows)
```

This bot:
1. **Verifies `x-oc-signature`** against OpenChat's P-256 public key — ES256, raw
   IEEE-P1363, exactly as `backend/libraries/jwt/src/lib.rs` produces and
   `notification_pusher/.../pusher.rs` sends (`ocVerify.ts`).
2. **Parses** the confirmed ActionCard (rows + `responded_by` + `action_id`).
3. **Maps rows → an IOU draft** (`rowsToDraft.ts`) — the inverse of the card
   layout IOU registers (Amount/Currency/Direction/Note).
4. **Forwards** it to the IOU relay `POST /v1/openchat/drafts`, routed by the
   pairing for `responded_by`. The relay stores it tagged `source:"openchat"`;
   the IOU app inbox → Accept → on-device encrypt → `add_entry` (unchanged).

Trust: OpenChat→bot is authenticated by OpenChat's ES256 key; bot→relay reuses
the relay's own provenance (the bot holds the relay signing key). The bot never
holds `K_sheet` or an IOU identity.

## Run

```
IOU_OPENCHAT_PUBKEY_FILE=<openchat P-256 public key PEM> \
IOU_RELAY_SIGNING_KEY_FILE=<relay Ed25519 private key PEM> \
IOU_RELAY_URL=http://127.0.0.1:8788 \
pnpm exec tsx scripts/iou-openchat-bot/server.ts
```

`pnpm run ocbot:selftest` verifies the trust + translation core (9/9) with real
P-256 keys.

## State / what's verified vs blocked (2026-06-24)

The OpenChat fork (`C:\Kiko\MyProjects\Blockchain\ICP\open-chat`) has **A** (on-device
model manager, branch `feat/on-device-model-manager`) and **~80% of B** (the
`ActionCard` variant + `respond_to_action_card` on group+community + renderer,
branch `feat/interactive-action-card`). **B is not finished** (candid regen,
mobile confirm button, community/user re-verify) and **C (the AI-action
registration/runner that auto-runs the model and posts the card) is NOT built**
— see the fork's `fork-notes/`.

- ✅ **Verified now:** ES256 `x-oc-signature` + JWT verification (matches the
  fork's exact format), rows→draft mapping, and the bot→relay forward (the relay
  path is green via `relay:selftest:openchat` 15/15 + the live e2e).
- 🔲 **Seam:** `/notify` decodes the event as JSON; the production body is
  OpenChat's msgpack/candid `BotEventPayload` for `MessageActionCardResponse` —
  decode it with the open-chat-bots SDK once PR-B's candid is regenerated.
- 🔲 **Needs the running OpenChat fork** (build B to completion + deploy) to
  register the bot, post ActionCards, and drive a real end-to-end. Until **C**
  lands, the image→on-device-model→card step isn't auto-orchestrated; the bot
  posts a card from data it's given.
