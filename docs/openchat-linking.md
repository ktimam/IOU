# Linking IOU to OpenChat (one tap)

IOU registers itself with OpenChat as an **AI app**: one manifest carrying the app name,
description, and its single action (the extraction prompt, response schema, confirm-card layout
and rules — the same definition `docs/openchat-registration.json` encodes). Once registered, a
chat owner enables the app per chat with a toggle; no JSON pasting anywhere, and — because the
manifest uses per-user delivery keys — no key material either.

The manifest sets **`per_user_keys=true`** (multi-user delivery): OpenChat delivers each user's
confirmed actions encrypted to **that user's own** registered key, not to a single app-level key.
Registering the app (this page) stays an **admin** task done once; each *user* additionally pairs
their own key once via a 6-digit code — see
[Per-user delivery keys](#per-user-delivery-keys-the-6-digit-pairing-code) below.

There are two ways to register — both share the exact same candid wire encoding
(`src/features/openchat/registerAiApp.ts`):

- **In-app button (primary):** one tap in the IOU app, no key copying.
- **CLI script (CI/deploy):** `pnpm register:openchat` — a zero-input post-deploy step for
  pipelines and headless environments (chained by `pnpm deploy:local`).

## Primary path: the "Link to OpenChat" button

1. In the IOU app open **Settings -> Action inbox**.
2. Tap **Link to OpenChat**.

That's it. The button builds the app manifest (carrying `per_user_keys=true`) and upserts it at
the OpenChat user_index's `register_ai_app`. No key is involved at all: with per-user keys the
app-level `consumer_public_key` is unused, so registration sends it empty (`""`) — OpenChat
accepts that for `per_user_keys=true` manifests. On success the button shows *"Linked to
OpenChat — now enable IOU in a chat's Apps settings."*; on rejection it shows the user_index's
validation error inline.

Configuration (Vite env vars, e.g. in `.env.local`):

```sh
VITE_OC_USER_INDEX_CANISTER_ID=<openchat user_index canister id>   # required
VITE_OC_IC_URL=http://127.0.0.1:8080                               # optional; this is the default
```

Note the OpenChat user_index runs on a **different replica** than IOU's own backend — that's why
it has its own host var (do not point it at IOU's `VITE_DFX_PORT` replica).

Identity: the button registers as the signed-in identity when you're signed in (keeping the
(owner, name) upsert key stable across taps), and falls back to anonymous when signed out — a
local OpenChat deployment runs the user_index in `test_mode`, which accepts either. Repeat taps
are safe: registration is an upsert by (owner, app name).

## CI/deploy path: the registration script

The script is a **zero-input** post-deploy step: because the manifest sets `per_user_keys=true`,
no delivery key is needed (it registers with an empty app-level `consumer_public_key`, exactly
like the button). The only required configuration is the user_index canister id:

```sh
export OC_USER_INDEX_CANISTER_ID=<openchat user_index canister id>   # required
export IC_URL=http://127.0.0.1:8080        # optional; this is the default

pnpm register:openchat
```

The script:

- keeps a persistent registrar identity at `.openchat-registrar.json` (gitignored — **keep it**:
  registrations upsert by owner + app name, so this identity owns the `"iou"` app and re-running
  the command updates the same registration instead of creating a duplicate);
- builds the app manifest from `src/features/openchat/actionManifest.ts` (prompt / schema /
  rules) plus `docs/openchat-registration.json` (action description, card, endpoint) — via the
  same shared module the button uses;
- calls the user_index `register_ai_app` endpoint over plain candid, then confirms via the
  `ai_apps` query that the app is listed.

Use `pnpm register:openchat -- --dry-run` to build and candid-encode the manifest without any
network access (no env vars needed at all).

On a local OpenChat deployment the user_index runs in `test_mode`, which accepts the script's
standalone principal; no OpenChat account is needed for the registrar.

### Deploy wiring

`pnpm deploy:local` chains the registration after the canister deploy:

```sh
dfx deploy iou_backend && pnpm build && dfx deploy iou_assets && pnpm register:openchat
```

Export `OC_USER_INDEX_CANISTER_ID` before running it (the final step fails with a usage message
otherwise). CI/deploy pipelines should do the same: invoke `pnpm register:openchat` as the
post-deploy step after the canisters are up — re-running is a safe upsert.

### Explicit app-level key (legacy)

An explicit key is only meaningful for `per_user_keys=false` manifests, where the app-level key
IS the delivery key. Both inputs are still accepted and validated:

```sh
export OC_CONSUMER_PUBLIC_KEY_PEM="$(cat consumer-key.pem)"   # SPKI PEM env var
# or
pnpm register:openchat -- --key-file consumer-key.pem
```

(The PEM is the one shown under **Settings -> Action inbox -> Copy public key**.)

## Enable the app in a chat

In OpenChat, a **group** owner or admin opens the chat's settings, finds the **Apps** section and
toggles **IOU** on (Phase A covers group chats only). From then on, members of that chat can tap a
message -> **Propose action**, review the confirm card, and on confirm an encrypted entry draft is
delivered to the IOU action inbox — pull it from **Settings -> Action inbox** in the IOU app.

## Per-user delivery keys: the 6-digit pairing code

With `per_user_keys=true`, every user gets their confirmed actions encrypted to **their own**
key — so each user pairs their IOU account with OpenChat **once, ever**:

1. In OpenChat, propose an action from a chat where IOU is enabled. If your key isn't paired yet,
   OpenChat shows a consent sheet with a **6-digit code** (single-use, valid for 10 minutes).
2. In the IOU app open **Settings -> Action inbox -> Connect to OpenChat**, enter the code and tap
   **Connect**. IOU pushes your account's public delivery key to OpenChat's user_index via
   `claim_ai_app_link_code` — the code itself is the authorization, so no OpenChat credentials are
   ever entered in IOU.
3. Back in OpenChat, tap **Check connection** on the consent sheet — the propose flow resumes
   automatically once the key is registered.

The keypair behind this is **canister-backed**: on first use IOU auto-generates it and stores the
private key on the IOU backend as an opaque blob, wrapped client-side via the same vetkd
mechanism the sheet keys use (`set_consumer_keypair` / `get_consumer_keypair` /
`vetkd_wrap_consumer_key`). Any of your devices can therefore recover it and decrypt older
drafts; the browser's localStorage is only a cache. No user action is needed for any of this —
only the one-time 6-digit code entry.

The admin registration paths above register the app manifest carrying `per_user_keys=true` with
an **empty** app-level key — with per-user delivery the app key is unused. A real app-level key
only matters for `per_user_keys=false` manifests (see
[Explicit app-level key (legacy)](#explicit-app-level-key-legacy)).

## Delivery provenance and the chat → sheet mapping

Since the v2 envelope format, every confirmed action OpenChat deposits carries **delivery
provenance** inside the encrypted plaintext: a `context` wrapper with the source chat
(`"group:<chat canister principal>"` or `"channel:<community principal>:<channel id>"`), the
message id, the confirming user's principal and the confirm timestamp, alongside the unchanged
draft `payload`. The provenance signature was hardened at the same time: OpenChat now signs
`ephemeral_public_key ‖ ciphertext ‖ created_at` (created_at as u64 little-endian), so the
deposit timestamp can no longer be forged. Two consequences:

- IOU shows *where* a pending draft came from (chat + confirming user) instead of a generic
  "action-inbox" badge, and tolerates older wrapper-less deposits (whole plaintext = payload,
  no provenance shown).
- Deposits made before the v2 change no longer pass signature verification and are dropped —
  acceptable for the local dev environments this ships in.

On top of the provenance IOU keeps a per-user **chat → sheet mapping**:

- The first time you import a draft from a chat that has no mapping yet, the review form shows a
  **"Remember: always import this chat's drafts into this sheet"** checkbox (ticked by default).
  Confirming the entry stores the mapping.
- Once a chat is mapped, its drafts only appear on the mapped sheet's page — other sheets hide
  them. Drafts from unmapped chats (or wrapper-less deposits) appear everywhere, as before.
- The mapping is **canister-backed and caller-keyed** (`set_chat_sheet_link` /
  `remove_chat_sheet_link` / `chat_sheet_links` on the IOU backend), so it follows you across
  devices; localStorage (`iou.openchat.chatSheetLinks.v1`) is only an optimistic cache. The chat
  key is opaque text to the canister; the sheet id travels as a `nat64` (IOU sheet ids are 16 hex
  chars, i.e. exactly 64 bits).

## App surfaces: the in-chat "link this chat" page

A **surface** is a page of the IOU app that OpenChat can open on the app's behalf. Surfaces are
part of the registered manifest (`AiAppManifest.surfaces`); each one carries:

- `kind` — what the surface is for. `"chat_link"` is the kind OpenChat knows today: it opens the
  surface after the **first confirmed action in a chat**, so the user can configure that chat
  inside the app. Kinds OpenChat does not recognise are ignored, so new kinds can ship in the
  manifest ahead of OpenChat support.
- `url` — a URL **template**. OpenChat substitutes `{chatKey}` (the canonical chat key, the same
  format the delivery provenance uses: `group:<principal>` / `channel:<principal>:<id>`) and
  `{appId}` before opening it.
- `display` — `"sheet"` (embedded in OpenChat as an iframe inside a bottom sheet) or
  `"external"` (opened in the system browser / a new tab).

IOU registers exactly one surface:

```
kind:    chat_link
url:     <app origin>/openchat/link-chat?chat={chatKey}
display: sheet
```

The target is the IOU route **`/openchat/link-chat`**: it requires sign-in, lists your active
sheets with their decrypted names, preselects the chat's current mapping if one exists, and on
save stores the mapping through the same canister-backed `set_chat_sheet_link` path described
above — so linking a chat from inside OpenChat and ticking "Remember" on an imported draft are
the same mapping. No new canister endpoints are involved.

### How the deploy step registers it

The surface URL must be **absolute at registration time** — OpenChat stores it verbatim (only
the placeholders are substituted later). The origin is resolved when the manifest is built
(`resolvePublicOrigin()` in `src/features/openchat/actionManifest.ts`):

- **CLI script** (`pnpm register:openchat`, runs under node): `OC_APP_PUBLIC_ORIGIN`, default
  `http://127.0.0.1:3000` (the dev-server origin — `vite.config.ts` sets `host: "127.0.0.1"`,
  `port: 3000`). Set it to the deployed IOU app origin before registering:

  ```sh
  export OC_APP_PUBLIC_ORIGIN=https://<iou assets canister>.icp0.io
  pnpm register:openchat
  ```

  > **The origin must be the EXACT one you browse IOU on** — scheme, host, *and* port. OpenChat
  > opens the chat-link page in the system browser, where it reuses your already-signed-in IOU
  > session; the browser scopes that session (II delegation / dev identity, and hence your
  > sheets) to the origin. `http://localhost:3000` and `http://127.0.0.1:3000` are **different
  > origins** — registering one while browsing the other makes the page open cross-origin, see no
  > session, and re-prompt sign-in as an empty (sheet-less) principal.

- **In-app button** ("Link to OpenChat"): `VITE_PUBLIC_ORIGIN`, baked in at build time (same
  default). Add it to `.env.local` / the build environment when the app is not served from
  `http://127.0.0.1:3000`.

`pnpm register:openchat -- --dry-run` prints each surface (`surface "chat_link": <url>`) along
with the candid-encoded size, so a pipeline can verify the origin before a live run. Because
registration is an upsert, re-running the script after changing the origin simply updates the
stored URL.

### Adding more surfaces later

Add an entry to `iouActionManifest.surfaces` in `src/features/openchat/actionManifest.ts` — the
wire mapping in `registerAiApp.ts` (`buildManifestWire` + the `AiAppSurface` IDL) passes every
entry through, so no other code changes are needed. Keep within OpenChat's validation limits: at
most **10 surfaces**, `kind` 1–64 chars, `url` 1–2000 chars and parseable once the placeholders
are substituted. Use `display: "external"` for pages that refuse framing or need a full browser;
note that unknown kinds are ignored by OpenChat rather than rejected, so shipping a
forward-looking surface is safe.

## Troubleshooting

- Button: `VITE_OC_USER_INDEX_CANISTER_ID is not set` — add the OpenChat user_index canister id
  to `.env.local` (printed by OpenChat's local deploy, or look it up in its `canister_ids.json`)
  and restart the dev server.
- Button: `OpenChat rejected the manifest: ...` / script:
  `register_ai_app rejected the manifest: ...` — the message is the user_index's validation
  error (name/description/key/actions limits); fix the offending field and retry.
- Script: `OC_USER_INDEX_CANISTER_ID is not set` — export the OpenChat user_index canister id
  (the script needs nothing else; the delivery key is per-user, not app-level).
- Script: `the consumer public key must be a SPKI PEM` — only relevant when passing an explicit
  key (env/`--key-file`); it must be a `-----BEGIN PUBLIC KEY-----` SPKI PEM. Drop the key
  entirely for the standard `per_user_keys=true` registration.
- The app registers but does not appear in a chat's Apps list — the toggle lives in **group**
  chats only in Phase A (no channels/communities/direct chats yet).
