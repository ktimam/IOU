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
