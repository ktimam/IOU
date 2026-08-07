# Linking IOU to OpenChat (one tap)

IOU registers itself with OpenChat as an **AI app**: one manifest carrying the app name,
description, and its single action (the extraction prompt, response schema, confirm-card layout
and rules — the same definition `docs/openchat-registration.json` encodes). Once registered, a
chat owner enables the app per chat with a toggle; no JSON pasting anywhere, and — because the
manifest uses per-user delivery keys — no key material either.

The manifest sets **`per_user_keys=true`** (multi-user delivery): OpenChat delivers each user's
confirmed actions encrypted to **that user's own** registered key, not to a single app-level key.
Registering the app (this page) stays an **admin** task done once; each *user* additionally pairs
their own key once via a high-entropy claim token — see
[Per-user delivery keys](#per-user-delivery-keys-the-claim-token) below.

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

## Per-user delivery keys: the claim token

With `per_user_keys=true`, every user gets their confirmed actions encrypted to **their own**
key — so each user pairs their IOU account with OpenChat **once, ever**:

1. In OpenChat, propose an action from a chat where IOU is enabled. If your key isn't paired yet,
   OpenChat shows a **64-character, 256-bit claim token** (single-use, valid for 10 minutes).
2. In the IOU app open **Settings -> Action inbox -> Connect to OpenChat**, paste the token and tap
   **Connect**. The signed-in IOU frontend sends the token and public key to `iou_backend`, which
   calls OpenChat's app-authenticated `c2c_claim_ai_app_link_code`. The token proves the OpenChat
   user's consent while the exact IOU canister caller proves the registered app; no OpenChat
   credentials are ever entered in IOU and a browser cannot claim a token directly.
3. Back in OpenChat, tap **Check connection** on the consent sheet — the propose flow resumes
   automatically once the key is registered.

### Coordinated disconnect (V2)

**Disconnect from OpenChat** is also browser → IOU backend → OpenChat C2C; the browser never calls
the UserIndex revoke method directly. IOU first returns the signed-in caller's authoritative
`OpenChatBinding`. While the private key still exists, the browser signs exactly:

`oc-revoke-ai-app-user-key-v2\0 || UserIndex raw || OpenChat user raw || app_id u32 LE || key_version u64 LE || exact PEM || timestamp u64 LE`.

The IOU canister reconstructs the user/app/key-version tuple from its stored revision-bound
binding and calls the pinned UserIndex's `revoke_ai_app_user_key` as the registered app canister.
After the await it rechecks the UserIndex pin, exact binding, consumer-key epoch, and PEM. It removes
the binding only for OpenChat `Success` or `KeyNotFound`; only then does the UI delete the wrapped
private key. Remote errors, stale bindings, and concurrent key/link changes retain the key by
default so the user can retry.

The raw `delete_consumer_keypair` method remains an explicit availability escape hatch if
OpenChat is unreachable. It erases only this caller's IOU key and binding, immediately closing
private-card access, but may leave an unusable/orphan public key in OpenChat. The normal UI never
silently falls back to that emergency behavior.

The keypair behind this is **canister-backed**: on first use IOU auto-generates it and stores the
private key on the IOU backend as an opaque blob, wrapped client-side via the same vetkd
mechanism the sheet keys use (`set_consumer_keypair` / `get_consumer_keypair` /
`vetkd_wrap_consumer_key`). Any authenticated device can therefore recover it and decrypt older
drafts. Production web keeps the plaintext key only in session memory and recovers it again after
reload; native production may cache it in platform secure storage. Plaintext localStorage is
reserved for the explicit local-development adapter and for a one-time migration that deletes the
legacy record only after the wrapped canister copy is secured. No user action is needed for any of
this — only the one-time claim-token entry.

Consumer-key writes are compare-and-swap operations. `get_consumer_keypair` returns the key plus a
canister-owned `mutation_epoch`; `set_consumer_keypair` and `delete_consumer_keypair` must present
that epoch, and every accepted mutation advances it. Delete removes the opaque key but retains the
new epoch in stable MemoryId 25 as a tombstone. Consequently an upload prepared before disconnect
cannot arrive afterwards and resurrect the key, even from another browser, device, or process whose
in-memory request registry was lost. Existing pre-v1.14 key records lazily start at epoch 0. A
reconnect must first observe the tombstone epoch, so value cycles cannot create an ABA bypass.

This is an intentionally breaking Candid revision: the two mutation methods gained an expected
`nat64` and a result, while the read now returns `{ mutation_epoch; keypair }`. Upgrade the backend
before publishing the matching web/Android assets. A pre-v1.14 cached client then fails closed on
argument/result decoding and must reload; it cannot perform an unversioned write against the new
canister. Stable key bytes are not rewritten during this API rollout.

The admin registration paths above register the app manifest carrying `per_user_keys=true` with
an **empty** app-level key — with per-user delivery the app key is unused. A real app-level key
only matters for `per_user_keys=false` manifests (see
[Explicit app-level key (legacy)](#explicit-app-level-key-legacy)).

## Pinning OpenChat's action-signing keyring

An OpenChat deployment outside the local machine must configure one to three independently
authenticated v4 action-signing key ids in the IOU web build:

```sh
VITE_OPENCHAT_HOST=https://<openchat replica origin>
VITE_OPENCHAT_ACTION_SIGNING_KEY_IDS=<64 hex key id>[,<64 hex overlap key id>...]
```

Each id is SHA-256 over the action-signing-key-id purpose domain followed by the key's canonical
65-byte uncompressed P-256 point (`0x04 || X || Y`) decoded from its SPKI PEM. It is not a digest
of the PEM text or SPKI wrapper. IOU accepts upper- or lowercase hexadecimal input and canonicalizes
it to lowercase; prefixes, separators other than commas, duplicates, surrounding whitespace, more
than three ids, and every non-64-character item fail closed.

Provision the allowlist from OpenChat governance/release material over a channel independent of the
UserIndex response. The public `action_signing_keys` query is discovery and health metadata, not
the remote trust root: IOU derives each returned PEM's id, requires it in the configured allowlist,
requires v4 purpose `action_inbox_deposit`, and accepts only `Active` or currently unexpired
`VerifyOnly` keys. A `VerifyOnly` signature is accepted only when its signed `created_at` is at
or before that key's `verify_until`; the key disappears from the usable set when the overlap
expires. A substituted query response therefore fails closed unless it contains the private-key
counterpart of an independently pinned id.

IOU validates `VITE_OPENCHAT_HOST` as an exact HTTP(S) origin with no credentials, path, query, or
fragment, and every non-loopback origin must use HTTPS. Exact loopback hosts (`localhost`,
`127.0.0.1`, and `[::1]`) may leave the allowlist empty. That is an intentional local-development
exception so recreated canisters and the four durable browser accounts continue working across
runs: IOU trusts the currently active/unexpired key returned by that local UserIndex. Lookalike
domains never receive the exception. A supplied loopback allowlist is still enforced.

Rotation is two-step and operator controlled. Stage the new key in UserIndex, distribute and add its
id to every remote consumer allowlist, then activate that exact key in a separate governance action.
Activation moves the prior key to `VerifyOnly`, removes its private DER from logical serialized
state, and retains its public entry for the 30-day overlap. Physical zeroization of all transient
heap copies and old upgrade-memory bytes is a separate OpenChat hardening gate. Remove the retired
id from consumer builds after the overlap; never
bridge rotation by temporarily accepting an unpinned remote key.

## Delivery provenance and the chat → sheet mapping

The v4 envelope makes every confirmed action carry **delivery provenance** inside the encrypted
plaintext: the source chat (`"group:<chat canister principal>"` or
`"channel:<community principal>:<channel id>"`), message/thread identity, confirming user and
timestamp, exact app/action revision and content hash, and confirmation-lease generation. The
original final payload is preserved as canonical unpadded base64url bytes, together with a
recipient-only acknowledgement secret. OpenChat's dedicated UserIndex key signs the complete v4
outer record. The domain-separated preimage binds signature version and purpose, signing-key id,
UserIndex and ActionInbox principals, app id and revision, action id, card-context commitment,
recipient fingerprint, full-width delivery identity, payload hash, acknowledgement-secret hash,
ECIES point/ciphertext, and `created_at`. IOU verifies that signature before decrypting, then
recomputes every public commitment from the strict inner envelope.

Two consequences:

- IOU shows *where* a pending draft came from (chat + confirming user) instead of a generic
  "action-inbox" badge.
- On-chain delivery requires the exact v4 wrapper and signature. Pre-v4 signatures, wrapper-less
  deposits, malformed canonical values, unknown fields, and commitment mismatches are rejected.
  Wrapper-less JSON remains only as a local parser compatibility case and is never accepted by
  `pollActionInbox`.

`actions` is a replicated update, so page membership, ordering, numeric ids, and boundaries come
from consensus. IOU nevertheless treats the signed 32-byte delivery identity as the durable dedupe
key, always re-reads from `since_id = 0`, and uses a numeric id only as the exact storage locator
paired with that action's decrypted 32-byte acknowledgement secret. Acknowledgements delete at most
that one handled action; there is no range or prefix deletion.

On top of the provenance IOU keeps a per-user **app-scoped chat handle → sheet mapping**:

- The first time you import a draft from a chat that has no mapping yet, the review form shows a
  **"Remember: always import this chat's drafts into this sheet"** checkbox (ticked by default).
  Confirming the entry stores the mapping.
- Once a handle is mapped, its drafts only appear on the mapped sheet's page — other sheets hide
  them. Drafts from unmapped chats (or wrapper-less deposits) appear everywhere, as before.
- The mapping is **canister-backed and caller-keyed** (`set_chat_sheet_link` /
  `remove_chat_sheet_link` / `chat_sheet_links` on the IOU backend), so it follows you across
  devices; localStorage (`iou.openchat.chatSheetLinks.v2`) is only an optimistic cache. The released
  Candid field is still named `chat_key`, but its value must be a canonical unpadded base64url
  encoding of exactly 32 bytes. Raw OpenChat chat/user/message coordinates are rejected. The sheet
  id travels as a `nat64` (IOU sheet ids are 16 hex chars, i.e. exactly 64 bits).

The old `/openchat/link-chat?chat={chatKey}` surface remains removed. A URL is a public correlation
and referrer channel, so it must not carry either a raw OpenChat chat coordinate or the private
app-scoped handle. Two safe mapping flows are supported:

- From the individual chat's settings page, use AI apps → **Open setup**. OpenChat mints a one-time
  32-byte token and substitutes its canonical 43-character unpadded base64url spelling into
  `/settings#openchat-routing/{chatLinkToken}`. IOU's synchronous main entry captures and
  removes that fragment from browser history before dynamically loading authentication/application
  bootstrap, a network call, or routing render. It keeps the token only in the page instance's
  module memory, and its
  authenticated backend redeems it through the pinned UserIndex with the caller's exact current
  app subject. A default browser signed in as the wrong IOU account gets a non-consuming mismatch,
  so the user can sign out and into the matching account without leaking or burning the link.
- Only a successful redemption creates a caller-private pending route with
  `claim_version = 1`. Card attestation and private-context requests never create one: proposing
  or viewing a card is not routing consent. Stable rows from the superseded card-derived design
  decode without that version and are hidden and non-actionable. Settings exposes only a
  principal-scoped SHA-256 pending id—not the app-scoped handle—under **Chat routing**.
  The user selects one of their own active account/sheets, and can later reassign or remove the
  saved route—even if its former sheet was later closed or access was revoked. Pending rows expire
  after 24 hours, are capped at 32 per principal and 4096 globally, and stale rows are reclaimed.
  Every authenticated token has its own pending id, so two chats can independently route to two
  different sheets; a newer launch does not invalidate an older live row.
- A grant must match the exact app subject and subject version, `app_user_key_version`, app id,
  manifest revision, app canister, and v1 handle version. IOU rechecks the complete binding,
  consumer-key trust, and active-sheet access after the await. OpenChat keeps a digest-only
  successful-redemption receipt for one hour, bound to the exact caller and subject; IOU uses a
  30-second bounded call, and an ambiguous result can safely retry the exact token. The production
  component also single-flights React StrictMode/remount claims and keeps the token for **Refresh**
  after `RemoteError`; it clears the token only after the exact success row reloads and focuses.
- The first verified v4 draft import can still store the same mapping through the default-on
  **Remember** checkbox.

The OpenChat **Open setup** surface carries only a short-lived one-time token in the fragment. It
never carries a chat, user, message, app-scoped handle, or pending id, and the fragment is scrubbed
before IOU makes a network call or renders routing state.

[IOU #51](https://github.com/ktimam/IOU/issues/51) records why the entry-point ordering is part of
the security contract: the former component scrub ran only after asynchronous authentication
initialization. Its regression failed first **1/1**; synchronous main capture plus dynamic
bootstrap now passes focused **5/5**. Final IOU gates pass Cargo **68/68**, frontend **846/846
across 71 files**, typecheck, production Vite build, and routing Playwright **5/5** using the
installed system Chrome. The initial Playwright invocation found no bundled browser binary; the
supported `PLAYWRIGHT_EXECUTABLE_PATH` rerun passed with no code failure. The exact candidate
hash, push, and deployment remain pending.

OpenChat mints a token only for a current authorized chat member and repeats membership checks
after awaits. Group invitees who have not joined and suspended/lapsed members fail closed.
Community-channel minting also enforces current community membership and the target channel's
visibility/membership rule, including exact private-channel membership. In this contract,
\"verified member\" describes current membership state, not KYC or identity verification.

The reviewed source status is exact as of 2026-08-07. PR 1's final pushed head is
`f43d2a2d53f2c9f8a3086104a356d4d3a315858a`. OpenChat #92 is fixed and pushed. Five
focused web/model/on-device files pass **145/145**, typecheck reports **0 errors**, and the exact
WSL `prod_test` completed in **10m36s**. The emitted Wllama Wasm is byte-identical to its source
at **7,656,521 bytes**, SHA-256
`4197ce6d3dc9240c42ee52b4197dc99638875a06b0083901f8a57767338a0cfa`, and the production
output has **zero unresolved Wllama references**. PR 1 deployment remains pending.

PR 2's exact pushed post-rebase head is
`16080b0780ed97c3cd63d4187188ac04b19b3769`. It includes the #81–#86 setup-token security
fixes, #89/#90 clean-gate fixes, and #91's generic desktop bridge. At that pushed head the frontend
suite passes **958/958**, Svelte typecheck reports **0 errors and 565 warnings**, the agent
typecheck is green, and #90's root-command source-inspection proof passes **44/44**. Focused
frontend evidence is #83 **3/3**, #84 **3/3**, the #85 surface resolver file **32/32**, and #86
**3/3**.

The final exact-blob Linux `prod_test` exited **0**: Rollup completed in **11m46.9s** and the
wrapper completed in **716s**. The bundle emits and references a **7,656,521-byte** Wllama Wasm
that is byte-identical to source at SHA-256
`4197ce6d3dc9240c42ee52b4197dc99638875a06b0083901f8a57767338a0cfa`, with zero
unresolved Wllama references. The successful retry used the exact Git blob to avoid an
environment-only CRLF wrapper failure and supplied mandatory `OC_WEBSITE_VERSION=1.0.0`, the
canonical CI value. Baseline unresolved `porto`/`accounts` notices and the known nonfatal
public-key CRLF warning remain out of scope. PR 2 deployment remains pending.

The post-rebase backend tree is exact to the previously green backend tree. Its recorded evidence is
UserIndex **253/253**, token model **11/11**,
LocalUserIndex **35/35**, Community **15/15**, Group **11/11**, User **19/19**, architecture
**10/10**, and Candid golden **1/1**. The latest focused token runs are common admission **4/4**,
GroupIndex exact cancellation **2/2**, Group **3/3**, and Community **3/3**; no aggregate
GroupIndex total is claimed. Inherited wallet dependency issue #87 is unchanged by PR 1/PR 2 and
requires a separate maintenance PR.

OpenChat #91 records the generic desktop bridge gap. Its repair is committed in exact pushed PR 2
head `16080b0780ed97c3cd63d4187188ac04b19b3769` and delegates the exact external URL to
the operating-system opener. Before the rebase it
passed focused **2/2**, full plugin **17/17**, and format/diff checks after failing first with Rust
`E0425`; exact post-rebase tree equivalence preserves that evidence. It changes only
`Cargo.lock`, `frontend/tauri-plugin-oc/Cargo.toml`, and
`frontend/tauri-plugin-oc/src/desktop.rs` and contains no Father/profile override. Deployment and
live acceptance remain release gates.

The local-only Father **Open setup** → **Open in browser** handoff was also proved: it opened a
distinct Father-profile window, scrubbed the opaque fragment, reached the exact
`/settings#openchat-routing` route signed in, and left the default browser unchanged. The
one-off debug profile override is excluded from PR 2. This is neither PR 2 nor deployment evidence
and does not prove token redemption or sheet assignment.

The checked-in IOU Candid service must include `claim_openchat_chat_route`. Repository-policy
coverage compares `src/iou_backend.did`, the Rust export, and TypeScript declaration. Deploy the
token-producing OpenChat backend before the IOU consumer because the successful grant includes the
non-optional `app_user_key_version`. As of 2026-08-07, both matching preserved-state upgrades,
IOU #51's exact hash/push/deployment, live redemption/pending-row assignment, and the two-chat/
two-sheet acceptance remain pending.

## App surfaces: raw-free external and embedded pages

A **surface** is a page of the IOU app that OpenChat can open on the app's behalf. Surfaces are
part of the registered manifest (`AiAppManifest.surfaces`); each one carries:

- `kind` — what the surface is for. Kinds OpenChat does not recognise are ignored.
- `url` — an HTTPS URL template. Generic public surfaces may use `{appId}`; `chat_link` may also
  use the one-time `{chatLinkToken}`. Loopback HTTP is accepted only while OpenChat is explicitly
  in local test mode.
- `display` — `"sheet"` (embedded in OpenChat as an iframe inside a bottom sheet) or
  `"external"` (opened in the system browser / a new tab).

IOU registers four raw-free surfaces:

```
kind: connect   url: <app origin>/settings#openchat-connect   display: external
kind: chat_link url: <app origin>/settings#openchat-routing/{chatLinkToken} display: external
kind: home      url: <app origin>/                             display: sheet
kind: card      url: <app origin>/openchat/card                display: sheet
```

The card renderer has no IOU browser session. OpenChat supplies only an opaque public-ready signal
over the generic bridge, then IOU redeems a short-lived, viewer/card/content-bound capability for
the private app-scoped context. Account type names remain encrypted; the selected type returns as
an encrypted reference bound to that context.

### How the deploy step registers it

Every surface URL must be **absolute at registration time** — OpenChat stores it verbatim. The
origin is resolved when the manifest is built
(`resolvePublicOrigin()` in `src/features/openchat/actionManifest.ts`):

- **CLI script** (`pnpm register:openchat`, runs under node): `OC_APP_PUBLIC_ORIGIN`, default
  `http://127.0.0.1:3000` (the dev-server origin — `vite.config.ts` sets `host: "127.0.0.1"`,
  `port: 3000`). Set it to the deployed IOU app origin before registering:

  ```sh
  export OC_APP_PUBLIC_ORIGIN=https://<iou assets canister>.icp0.io
  pnpm register:openchat
  ```

  > **The origin must be the exact one you browse IOU on** — scheme, host, and port. The external
  > connect surface reuses that origin's signed-in IOU session. `http://localhost:3000` and
  > `http://127.0.0.1:3000` are different origins.

- **In-app button** ("Link to OpenChat"): `VITE_PUBLIC_ORIGIN`, baked in at build time (same
  default). Add it to `.env.local` / the build environment when the app is not served from
  `http://127.0.0.1:3000`.

`pnpm register:openchat -- --dry-run` prints each surface along
with the candid-encoded size, so a pipeline can verify the origin before a live run. Because
registration is an upsert, re-running the script after changing the origin simply updates the
stored URL.

### Adding more surfaces later

Add an entry to `iouActionManifest.surfaces` in `src/features/openchat/actionManifest.ts` — the
wire mapping in `registerAiApp.ts` (`buildManifestWire` + the `AiAppSurface` IDL) passes every
entry through, so no other code changes are needed. Keep within OpenChat's validation limits: at
most **10 surfaces**, `kind` 1–64 chars, `url` 1–2000 chars, credential-free HTTPS (or loopback HTTP
in explicit test mode), and parseable after replacing `{appId}`. Any other placeholder is rejected.
Use `display: "external"` for pages that need a first-party browser session; unknown kinds are
ignored by OpenChat rather than rejected.

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
