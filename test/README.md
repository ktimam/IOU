# IOU + OpenChat confirmable-action test suite

This suite covers **every feature added for the OpenChat "confirmable-action" work** — both the
IOU client logic and the generic OpenChat primitives IOU consumes — in preparation for upstreaming
the primitives to `open-chat-labs/open-chat`. It is organized as four layers so the fast,
deterministic parts run anywhere while the replica/model-dependent parts are clearly separated and
self-skipping.

| Layer | What | Where | Runner | Needs |
|------|------|-------|--------|-------|
| **1. Unit** | IOU client logic + crypto, exhaustive incl. negative/tamper/boundary | `src/features/**/*.test.ts` (this repo) | vitest (node) | nothing |
| **2. E2E** | Consumer-side black-box against the LIVE canisters, multi-identity | `test/e2e/**/*.e2e.test.ts` (this repo) | vitest (node) | local replica up |
| **2b. UI E2E** | The real app in a browser: multiple users, sheets, chat links | `test/ui/**/*.ui.spec.ts` (this repo) | Playwright | dev server + replica |
| **3. On-device model** | tauri-plugin-oc (Rust) + TS facade | `open-chat` repo (see below) | cargo / vitest | optional GGUF |
| **4. OpenChat canisters** | action_inbox, registry, link-codes, revoke/throttle, two-phase confirm, per-user-key isolation | `open-chat-cycle/backend/integration_tests` | pocket-ic (WSL) | prebuilt wasms + pocket-ic |

Layers 1–2 live in **this** repo and are green here. Layers 3–4 live in their canonical home repos
(the generic primitives are upstreamed from there); this file is the index + cross-reference.

### Verification status (all layers green)

| Layer | Result |
|---|---|
| 1 — IOU unit | **264 pass / 29 files**, `tsc --noEmit` clean |
| 2 — IOU E2E (live `:8080`) | **27 pass / 5 files** |
| 2b — IOU UI E2E (Playwright) | **green** — `multiUser` (3 users · 3 sheets · cross-user mirror · chat links) + `openchat` (settings/consumer-key, chat link/unlink/isolation, ✨ Import) + `closeAndName` (global-username eager-publish to an existing account · close-&-start carries balance forward in the correct direction · persists across reload) |
| 3a — TS facade (open-chat) | **25 pass / 2 files** (vitest, jsdom); + **38 pass** `aiAction.test.ts` (open-chat-cycle, incl. fan-out card fields) |
| 3b — tauri-plugin-oc (Rust) | **7 hermetic pass** on the default build; real-model smoke gated |
| 4 — OpenChat canisters | **20 pass** — compile-clean on Windows + run green under WSL pocket-ic (~95s); incl. **fan-out delivery** (`fan_out_delivery_tests.rs`: partner-confirm deposits to BOTH members' buckets with cross-key isolation; repeated-key dedupe; `ai_app_user_keys` lookup scoping) |

---

## Running

```bash
# Layer 1 — unit (deterministic, no replica). 264 tests across 29 files, ~2s.
pnpm test            # (= pnpm exec vitest run) OR: pnpm test:unit
pnpm exec tsc --noEmit   # type-check (must be clean)

# Layer 2 — E2E against the LIVE local replica. Self-skips with a message if the replica is down.
pnpm test:e2e        # (= vitest run --config vitest.e2e.config.ts). ~27 tests, ~130s (real round-trips).

# Layer 2b — UI E2E: drives the REAL app in a browser (needs `pnpm dev` on :3000, reused if running).
pnpm test:ui         # (= playwright test). Multiple users/sheets/chats via the UI, headless. ~55s.
HEADED=1 pnpm test:ui   # watch it drive.
pnpm ui:demo         # NOT a test: opens one persistent Chromium window PER USER (Alice/Bob/Carol),
                     # gives each user their own sheets + entries (+ Alice's chat links), and LEAVES
                     # the windows open to inspect. (Per-user setup, so it's robust; the shared-sheet
                     # cross-user view is the reliable `pnpm test:ui`.)
```

The unit config (`vitest.config.ts`) includes only `src/**/*.test.ts`; the E2E config
(`vitest.e2e.config.ts`) includes only `test/e2e/**/*.e2e.test.ts` and runs files serially with a
60s timeout. The two never overlap.

### Layer 2 prerequisites (local env)

The E2E layer drives the **already-deployed** local canisters. It **never hardcodes ids** — it reads
them from `.env.local` (IOU + OpenChat user_index + action_inbox) and the OpenChat dfx
`canister_ids.json` (local_user_index). Bring the environment up per the runbooks
(`docs/local-dev-runbook.md` here, `open-chat-cycle/LOCAL-DEV.md` there): an IC replica on `:8080`
with the IOU backend, OpenChat `user_index` / `local_user_index`, and the `action_inbox` canister
deployed. If it isn't up, `pnpm test:e2e` prints a clear skip message and exits green — it is safe to
run in CI without the env.

Override the OpenChat `canister_ids.json` path with `OC_CANISTER_IDS_JSON=/abs/path` if your
`open-chat-cycle` worktree isn't the sibling default.

### Layers 3–4 (other repos)

```bash
# Layer 3a — TS facade (open-chat repo, branch feat/on-device-model-manager). 25 tests.
cd <open-chat>/frontend/app && npx vitest run src/utils/onDeviceInference.spec.ts src/utils/modelCatalog.spec.ts

# Layer 3b — tauri-plugin-oc Rust: 7 pure fs/hash tests run on the DEFAULT (no-inference) build.
cargo test -p tauri-plugin-oc -- --nocapture
# real-model inference smoke (gated): set OC_TEST_MODEL_GGUF (+OC_TEST_MMPROJ_GGUF/OC_TEST_IMAGE),
# then: cargo test -p tauri-plugin-oc --features inference -- --nocapture   (Windows: needs cmake+MSVC+Ninja)

# Layer 4 — OpenChat canister integration tests (open-chat-cycle repo). 16 tests.
cargo test --package integration_tests --no-run          # compile gate (validates all types), Windows-ok
# pocket-ic is a Linux ELF → RUN under WSL, reusing the prebuilt binary + wasms/ (no network):
wsl -d Ubuntu bash -lc 'source ~/.cargo/env; \
  export POCKET_IC_BIN=/mnt/c/Kiko/MyProjects/Blockchain/ICP/open-chat-cycle/backend/integration_tests/pocket-ic; \
  cd /mnt/c/Kiko/MyProjects/Blockchain/ICP/open-chat-cycle; \
  CARGO_TARGET_DIR=$HOME/oc-linux-target cargo test --package integration_tests -- \
    ai_app_ per_user_key_isolation two_phase_confirm_idempotency fan_out_ action_card_inbox_routing --test-threads 4'
```

---

## Coverage matrix (feature → test)

### Layer 1 — IOU unit (this repo)

| Feature / module | Test file(s) | Key behaviors (incl. negative / boundary) |
|---|---|---|
| `balance.ts` — per-currency netting, `portionsOf`, `netAfterFee`, maturity buckets, `formatMinor` | `entries/balance.test.ts`, `entries/balance.more.test.ts` | settlement vs iou portions; percent split + rounding remainder to last; **same-currency fixed fee folds into net**; **cross-currency fixed fee = separate opposite-direction line, totalled per-currency, does NOT reduce the entry currency**; fee=gross and fee>gross **clamp to 0 (cascade, never negative)**; `computeBalancesAsOf`/`endOfPrevMonth` maturity + foreign-fee-line timing; multi-currency roll-up sorted by magnitude; zero nets drop out; `netAfterFee` rounding + clamps; `formatMinor` sign/precision |
| `draft.ts` (`parseDraft`, `extractTs`, `isDuplicateDraft`) | `entries/draft.test.ts`, `entries/draft.more.test.ts` | template base merge (type/amount/currency/note/schedule fallback, extracted overrides); **fee-currency carry-through** (template `fixed_currency` survives; same-ccy fee emits no key); loose-date recovery (`Month D`, `D Month`, ranges → start, `D/M[/Y]`, embedded ISO, en-dash); schedule percent boundaries (single→100, 99/1 ok, ≠100 rejected, out-of-range, malformed rows); string/decimal amounts; **`26k` rejected** (documents reliance on OpenChat normalize); `draftId` idempotency (provided trimmed, derived stable + differs on note/schedule); hostile input (arrays, `__proto__`, bad kind/fee, multi-error) |
| EntryForm net/convert/fee (extracted pure helper) | `entries/entryMath.ts` + `entries/entryMath.test.ts` | `buildEntryPayload` reproduces the exact submit math; percent-only/same-ccy/cross-ccy fees; conversion restates currency + applies fee to converted base; schedule validation; fee>gross clamp; kind mapping; `draft_id` carry-through. `EntryForm.tsx` now delegates to it |
| Template → entry defaults (`TxnTemplate`, incl. `fee_fixed_currency`, relative schedule) | `templates/templateBase.ts` + `templates/templateBase.test.ts` | `templateToInitial`: fee currency (foreign carries `fixed_currency`, same-ccy folds); **relative-schedule anchoring** — `offset_days`, `start_of_next_month` (December → next-year rollover), default-today. `SheetPage.tsx` delegates to it; feeds parseDraft's `base` |
| `currencies.ts` (`orderedCurrencies`, ISO list) | `settings/currencies.test.ts`, `settings/currencies.more.test.ts` | default-first then USD/EUR/GBP then alpha; dedupe; non-ISO default; `extra` upper/dedupe/blank-skip; ISO integrity (uppercase, no dups, covers COMMON) |
| `actionInboxCrypto.ts` — ECIES decrypt + provenance | `openchat/actionInboxCrypto.test.ts`, `openchat/actionInboxCrypto.negative.test.ts` | **Rust interop vector** decrypt + fingerprint; v2 preimage layout (binds `created_at`); **wrong recipient key**, **flipped ciphertext byte**, **corrupted ephemeral point**, **flipped signature**, **other-key signature**, **tampered created_at** all rejected; fingerprint == sha256(uncompressed SEC1 point) == `keyFingerprint(pem)` == `fingerprintPublicKey(key)` |
| `actionInboxClient.ts` — poll + config | `openchat/actionInboxClient.test.ts`, `openchat/actionInboxClient.poll.test.ts` | `parseInboxPlaintext` v2 wrapper split + tolerance; **`pollActionInbox` drops unsigned + not-addressed-to-us**, passes fingerprint/cursor/max_results, throws on missing PEM, drops tampered created_at; `getActionInboxConfig` manifest resolution + **cache memoize / in-flight dedup / TTL expiry / invalidate / env fallback / null** |
| `consumerKeypair.ts` — canister-backed keypair | `openchat/consumerKeypair.test.ts` | generate + device cache; **fingerprint = sha256(raw point)**; four sync branches (adopt+upload / recover-from-canister no-reupload / unwrappable→cache-no-overwrite / unwrappable+no-cache→regenerate+upload); `clearConsumerKeypair` deletes canister+cache; `signRevokeChallenge` proof-of-possession verifies + throws w/o key |
| `registerAiApp.ts` — manifest wire + registry client | `openchat/registerAiApp.test.ts`, `openchat/registerAiApp.outcomes.test.ts` | `buildManifestWire` (empty key for per-user, `app_canister_id`/**`inbox_canister_id` opt principal**, surfaces, IDL encode); `registerAiApp`/`claimAiAppLinkCode`/`revokeAiAppUserKey` outcome decode; **revoke challenge preimage** (domain‖canisterId‖pem‖ts LE, ts bound); `getRegisteredInboxCanisterId` (opt principal, null, tie-break) |
| `actionManifest.ts` — extraction manifest + template routing | `openchat/actionManifest.test.ts`, `openchat/actionManifest.caps.test.ts` | schema/prompt/surfaces; template routing by NAME; schema advertises `template` only when routable; **validator caps** (≤50 mappings, ≤50 keywords each, ≤1000-char roster w/ ellipsis, keyword-less excluded); static rules precede template rules; `resolvePublicOrigin` default + trailing-slash strip |
| `inboxDedupe.ts` — dedup + **deployment-scoped keys** | `openchat/inboxDedupe.test.ts`, `openchat/inboxDedupe.scope.test.ts` | `collapseByMessageId` (first-wins, undefined never collapsed), tolerant parse, capped serialize; **`deriveDeployTag`/`planScopedInboxKey`** — the restart-safe fix: a stale set from another `user_index` deployment is purged and a fresh deployment reads empty (would-regress the "never imports after a restart" bug). `SheetPage.tsx` delegates to these |
| `chatSheetLinks.ts` — chat→sheet mapping + **routing** | `openchat/chatSheetLinks.test.ts` | 16-hex ↔ nat64 loss-free, range/shape rejects, cache filter; **`draftBelongsOnSheet` routing** (the predicate `SheetPage`'s visible-inbox uses): one user · many chats/sheets → each chat's drafts land ONLY on their pinned sheet; mixed inbox partitions with none crossed / dropped / duplicated; an UNMAPPED chat + a wrapper-less draft (no chat key) show on every sheet |
| chat→ledger SCENARIOS (real `parseDraft` → stored payload → `computeBalances`/`orientPayload`) | `entries/chatToLedger.scenario.test.ts` | end-to-end confirmable-action → balance, numbers only ASSERTED (no hand-rolled math): S1 owner+manager share ONE sheet (owed = rent − expenses − transfers, exact mirror per viewer); S2 father keeps TWO independent SAR sheets (wife settled, child owes 50, ledgers never net together); **S3 routing** — one father, two chats, two sheets: a single mixed inbox is routed with the real `draftBelongsOnSheet`, each sheet gets only its chat's drafts, routed balances match the hand-partitioned S2, and a mis-pin structurally strips the other sheet |
| `publishUsernameToAllPairs` (global username eager-publish) | `flows/createSheet.test.ts` | real crypto + mocked actor/`unwrapFor`: publishes the **trimmed** name to every pair with an active sheet, each `set_member_name` encrypted under **that sheet's own key** (decrypts back under the right key, `""` under the wrong one, ciphertext never contains plaintext); skips pairs with no active sheet (opt `[]`/absent); empty/whitespace name publishes nothing (returns before unwrapping) but still reports `total`; **best-effort** — a pair whose key won't unwrap is skipped while the rest publish; zero pairs → `{published:0,total:0}` |
| `consumerKeypair`/crypto ECIES producer (shared test kit) | `openchat/ecTestKit.ts` | builds real signed+encrypted inbox envelopes matching the Rust wire format (used by crypto + poll specs) |
| `devVetkd.ts` / `prodVetkd.ts` | `crypto/devVetkd.test.ts`, `crypto/prod-path.test.ts` | sheet-key wrap/unwrap self-ECDH, name enc/dec (wrong key → ""); prod adapter gated off by default; transport key sizes |
| `mnemonic.ts` | `recovery/mnemonic.test.ts` | BIP-39 24-word gen/validate, deterministic seed |
| `inviteLink.ts` — invite-link build/parse + dev self-wrap | `flows/inviteLink.test.ts` | round-trips `code`+`sheetId`+`K_sheet` through the URL **fragment** (never sent to a server); omits the key for prod-style links; rejects a fragment missing `c`/`s`; strips trailing slash; url-safe base64; **dev accept-flow crypto** — the joiner self-wraps `K` from the link under their own key and it unwraps back to `K` (wrong key rejects) |
| `deepLink.ts` | `deeplinks/deepLink.test.ts` | host allowlist → route, **`invite` → `/pair/accept` preserving the fragment**, encode, reject unknown/bad |
| `csvExport.ts` | `entries/csvExport.test.ts` | header, net+gross+fee, cross-cell escaping, convert cells |

### Layer 2 — E2E, consumer perspective (this repo, `test/e2e/`)

| Area | Test file | Proves (against LIVE canisters, multi-identity) |
|---|---|---|
| Env gate | `env.ts` | reads ids from `.env.local` + `canister_ids.json`; reachability; `describeE2E` skips cleanly when down |
| IOU backend, two users | `iouBackend.e2e.test.ts` | pair→join→shared sheet; **A encrypts an entry, B unwraps the shared K_sheet and decrypts it** (E2E encryption); cross-currency fee → correct balance; **consumer keypair is caller-keyed + deletable in isolation** (+ canister guards: PEM/iv validation); chat→sheet links caller-scoped + loss-free round-trip; template blob round-trip; **import loop** (decrypted draft → parseDraft → encrypt → add_entry → lands in the linked sheet, draft_id survives) |
| Invite-link auto-join + lifecycle | `inviteLifecycle.e2e.test.ts` | **`accept_invite`: the invitee self-joins AND seals K_sheet to itself in one message — NO creator grant** (reads its wrapped copy, recovers the same K); the invite is **single-use** (2nd accept rejected); both members read/write; **`delete_pair` guards** (refused while 2 members, refused until archived); **`archive_pair`/`unarchive_pair`** flip `archived_at` (visible in `get_my_pairs`); **`leave_pair`** — the partner leaves → locked out, the creator retains the account solo; **`delete_pair`** erases a solo, archived account (pair + sheets gone) |
| Invite reissue + re-seal (stale-invite fix) | `inviteReissue.e2e.test.ts` | reproduces the **"invalid or already-consumed invite code"** trap and proves the repairs: **`issue_invite` mints a FRESH code and retires the previous one** (the stored `pair.invite_code` goes stale on consume); **re-invite after a partner LEAVES** works (old code was consumed on join); a **legacy "joined but not granted" pair self-heals** — an already-member caller re-accepts a fresh link and gets their sheet key sealed (fixes "no wrapped key"); a **stranger still can't take a filled slot** even with a fresh code |
| Registry | `registry.e2e.test.ts` + `registryIdl.ts` | live `iou` inbox read-back (non-destructive); throwaway app **register/upsert/read-back/explore/delete**; claim bad code → CodeNotFound; **revoke unpaired key → KeyNotFound after on-chain proof-of-possession verify**; **per-caller throttle** after repeated failed claims |
| Action inbox | `actionInbox.e2e.test.ts` | `openchat_public_key` PEM; `actions(fingerprint, since_id)` empty for a fresh key (exact-match, no error on miss); `pollActionInbox` full verify+decrypt path; two fingerprints isolated |

**Cross-reference:** the full *deposit* half of the loop (a real OpenChat group confirm →
`respond_to_action_card` two-phase → `c2c_deposit_action_confirmed` → `action_inbox`) is exercised
authoritatively by **Layer 4** on these same canisters (it needs the OpenChat group/user client +
msgpack transport). Layer 2 proves the **consumer** half end-to-end: registration/read-back, the live
inbox query + decrypt path, and the IOU import into the linked sheet.

### Layer 2b — UI E2E (this repo, `test/ui/`, Playwright)

Drives the real app in a browser with **up to three distinct users** (isolated browser contexts =
distinct dev identities via the `Sign in (dev)` button). Shared flow helpers (`flows.ts`) navigate bounce-safely
(guarded pages redirect during auth-loading, so all navigation lands on `/pairs` and reaches deep pages
via in-app clicks).

| Test | Proves (real clicks against the live app) |
|---|---|
| `multiUser.ui.spec.ts` | 3 users sign in; **3 pairs/sheets** created + partner joins via **invite LINK → Accept (no grant step)** (Alice↔Bob, Alice↔Carol, Bob↔Carol; each user in 2); entries added through the real `EntryForm` (settlement + IOU, multiple currencies); the creator's balance reflects them; **cross-user shared view** — the accepted partner opens the SAME sheet and decrypts the same net, and sees the **per-viewer mirror** (Alice "…owes you", Bob "you owe…" — fix #2); a fresh **deep-link/refresh** of a guarded page renders instead of bouncing (fix #1); **2 chat→sheet links** |
| `membership.ui.spec.ts` | The v1.10.0 membership lifecycle end-to-end (2 users): the creator hits **🔗 Invite** on the sheet, the invitee opens the LINK and clicks **Accept** → lands on the SAME shared sheet **immediately, no grant**; both read/write (invitee writes, creator decrypts); **Archive** moves the account to the "📦 Archived" section, **Unarchive** brings it back; the partner **Leaves** → is locked out while the creator keeps the account solo; the creator **Archives** then **Deletes forever** (typed `DELETE` confirm) the solo account → it's gone |
| `openchat.ui.spec.ts` | The IOU-app side of the OpenChat confirmable-action feature, multi-user: the **action-inbox settings card** (per-user consumer key + distinct fingerprints, auto-derived inbox `<id> @ <host>`, connect-code validation incl. a live-`user_index` `CodeNotFound`); **chat→sheet link / (current) / unlink / per-user isolation**; and the **✨ Import** chat-draft flow (paste JSON → parseDraft → EntryForm → written). SAFE-BY-DESIGN: never clicks "Link to OpenChat" (that upsert would clobber the shared live "iou" registration — the full loop is the api-e2e + Rust integration tests) |
| `flows.ts` | reusable actions: dev sign-in, create account, **read the sheet's invite link**, **accept an invite link**, **leave / archive / unarchive / delete** an account, open sheet, add entry, link/unlink chat, import draft, open settings, read consumer fingerprint, connect-with-code, read balances |

`scripts/ui-multiuser-demo.ts` (`pnpm ui:demo`) reuses the same flows to open **one persistent Chromium
window per user** (Alice/Bob/Carol), gives each their own accounts/sheets/entries (+ Alice's chat
links), and leaves the windows open for manual inspection (profiles under `.pw-profiles/`, gitignored).
It uses per-user solo sheets (no cross-user grant), so it stays robust regardless of machine load; the
shared-sheet / cross-user decryption path is exercised by the spec above.

The balance is oriented **per viewer** (direction is stored author-relative, then flipped for the
partner), so Alice sees "… owes you 30.00 USD" and Bob sees the mirror "you owe … 30.00 USD" — the
test asserts both. (See `balance.orientDirection`/`orientPayload` + `balance.orient.test.ts`.)

### Layer 3 — on-device model (`open-chat` repo, branch `feat/on-device-model-manager`)

| Area | Test file | Proves |
|---|---|---|
| TS facade `onDeviceInference.ts` | `frontend/app/src/utils/onDeviceInference.spec.ts` | unavailable (not-native / no model / not-downloaded) **vs** error (native reject) mapping; exact `invoke("plugin:oc\|infer",{payload})` shape (image→number[], responseSchema→JSON.stringify); `onDeviceInferenceCapability` |
| Model catalog `modelCatalog.ts` | `frontend/app/src/utils/modelCatalog.spec.ts` | `defaultModelCatalog` integrity (runtime, modalities, per-file sha256+bytes) |
| Plugin `tauri-plugin-oc` | inline `#[cfg(test)]` in `model_manager.rs` (+ existing `inference.rs`) | `verify_sha256` match/mismatch, `sanitize` path derivation, model.json cycle; the "no-inference build → specific Err" contract; real-model text/vision smoke stays **gated** (skips without `OC_TEST_MODEL_GGUF`/`OC_TEST_MMPROJ_GGUF`/`OC_TEST_IMAGE`) |

**Intentionally gated:** a live GGUF (~4 GB) is impractical in CI, so the inference smoke tests skip
cleanly when the model env vars are absent — but the *plumbing* (command shape, unavailable-vs-error
mapping, hash/verify/list/delete) is always asserted. The Windows `inference` feature build needs
cmake + MSVC + Ninja (see the repo notes).

### Layer 4 — OpenChat canister primitives (`open-chat-cycle/backend/integration_tests`)

| Primitive | Test file | Proves |
|---|---|---|
| Deposit pipeline routing | `action_card_inbox_routing_tests.rs` *(existing)* | propose→confirm→deposit routes to the per-app inbox by fingerprint |
| enabled_ai_apps import | `communities/enabled_ai_apps_import_tests.rs` *(existing)* | per-channel enablement carried over on group→community import |
| Registry | `ai_app_registry_tests.rs` | register upsert-by-name, test_mode re-own, `InvalidRequest` (empty key / >20 actions), `explore_ai_apps` (TermTooShort/Success), `delete_ai_app` + NotFound |
| 6-digit link codes | `ai_app_link_code_tests.rs` | create→claim Success + `my_ai_app_keys`; single-use (CodeNotFound on re-claim); CodeExpired after TTL; set/remove_my_ai_app_key |
| Revoke + throttle | `ai_app_revoke_throttle_tests.rs` | proof-of-possession revoke (`jwt::sign_bytes` over the canonical preimage) Success → KeyNotFound; bad sig → `Error(InvalidSignature)`; stale ts → `Error(Expired)`; per-caller throttle: 10 failed claims → CodeNotFound, 11th → `Error(Throttled)` |
| Per-user key isolation | `per_user_key_isolation_tests.rs` | A/B confirm to their OWN keys into one inbox; each fingerprint bucket holds exactly its owner's deposit; ECIES decrypt succeeds only with the matching sk (cross-user fails); `confirmedBy` attribution in the v2 envelope |
| Two-phase confirm + idempotency | `two_phase_confirm_idempotency_tests.rs` | misconfigured inbox → `Error(C2CError "NotConfigured")`, card stays **Pending**, a retry after configuring succeeds; double-confirm/retry dedupes to exactly ONE inbox entry (idempotency_id = sha256(plaintext‖message_id)); a redundant confirm of a Confirmed card deposits nothing |
| Client-side AI action pipeline | `frontend/openchat-shared/src/domain/aiAction.test.ts` *(existing)* | extraction parse, card build, rules post-pass, `chatKeyFor` byte-match with the Rust envelope |

**Layer 3/4 support changes** (minimal, documented): (a) `tauri-plugin-oc/src/model_manager.rs` extracts the
no-inference error literal into a `#[cfg(not(feature="inference"))]` const so the "compiled without the
runtime" contract is CI-testable without a Tauri `AppHandle` (no dead code either way). (b) `integration_tests`
gains a `p256` **dev-dependency** so the isolation test can generate recipient keypairs and ECIES-decrypt
exactly as the production consumer does. Running Layer 4 uses `POCKET_IC_BIN` + the present `wasms/` directly
(bypasses `run-integration-tests.sh`'s network steps); the "misconfigured inbox" test uses a fresh env because
the LUI global inbox setting is canister-wide.

---

## What is intentionally NOT duplicated

- **The propose→confirm→deposit loop** is proven once, authoritatively, in Layer 4 (Rust, real
  canisters). Layer 2 covers the consumer half rather than re-implementing OpenChat's group/confirm
  flow in TypeScript.
- **msgpack-only registry endpoints** (`create_ai_app_link_code`, `set_my_ai_app_key`,
  `my_ai_app_keys`, `publish_ai_app`) are exercised in Layer 4 (which speaks msgpack); Layer 2 covers
  the candid-exposed surface (`register_ai_app`, `ai_apps`, `explore_ai_apps`, `delete_ai_app`,
  `claim_ai_app_link_code`, `revoke_ai_app_user_key`) plus the negatives.
- **Live GGUF inference** (Layer 3) is gated behind env vars; the surrounding plumbing is always tested.

Every feature has at least one assertion that would fail if the feature regressed.
