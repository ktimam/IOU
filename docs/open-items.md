# Open items

Known-but-unfixed things, so they stop living in chat history. Each entry says what it is, how to
see it, and what "done" means — enough to pick up cold.

Last updated: 2026-08-05.

---

## 1. Cross-account type leak (privacy) — **resolved 2026-08-01**

**Resolution.** IOU no longer decrypts, aggregates, or supplies account templates to manifest
registration. The public rules, response schema, and card rows contain no private template fields;
matching now happens locally after import against only the linked account. Unit coverage and the
live registry E2E assert that even a deliberately supplied private roster is absent on read-back.

**Private display follow-up (implemented and tested in IOU; OpenChat activation pending).** IOU now
supports the missing R1 path without reopening R2: after authorized private hydration, its
credentialless card iframe displays an `Account type` selector and the read-only card displays the
selected saved Type. It decrypts only the linked sheet's type roster in iframe memory and returns
the selection as an AES-GCM reference bound to sheet, chat, message and row. Before private hydration
it shows no Type. The signed-in IOU importer authenticates and decrypts that reference before
applying the account-local type. Plaintext type ids, names and keywords remain absent from the
manifest, public card rows, chat message, URL, storage and logs.

The owner approved both narrowly scoped data flows: OpenChat may send the exact public card and
exact final confirmation bytes to UserIndex and the registered app canister for attestation, and
may deliver a short-lived one-time viewer/card/key-bound capability to the explicitly clicked
sandboxed iframe. IOU now implements both exact app-canister attesters, independently recomputes
the portable card hash, rejects unknown/duplicate/plaintext Type fields, and accepts a Type only
as a structurally valid opaque encrypted `template_ref` tied to the current linked active sheet.
The OpenChat backend/frontend candidate implements the generic transport, final grant and click-only
capability bridge, but every runtime activation switch remains false. Activation still requires the
non-empty legacy-inbox drain/export/reinstall decision, durable confirmation-saga recovery,
snapshot-rollback key reseed, a retired-key erasure threat model, strict generated-contract parity,
Linux PocketIC coverage, a disposable live backend upgrade, and the four-profile isolation matrix.
The public leak is fixed, but the running card
cannot yet receive the private roster. This is not a reason to republish the roster.

The cross-repo ActionInbox wire is synchronized at the source level: authoritative UserIndex signs
the complete domain-separated v4 record with a dedicated staged/active/verify-only keyring, and
ActionInbox exposes membership and numeric locators through a replicated update. IOU remotely trusts
only one to three independently pinned key ids, verifies the full outer signature, decrypts the exact
lossless v4/base64url envelope, recomputes payload/card/delivery/ack commitments, deduplicates by the
signed full-width identity, and acknowledges one exact handled action. Exact loopback development
may discover the recreated local keyring without pins. Independent Rust/WebCrypto goldens and
negative/boundary suites pass locally; strict generated-contract CI and the complete replica-level
confirmation→deposit→import→ack matrix remain activation gates.

**What.** IOU registers ONE OpenChat manifest per user, and folds the transaction types of *every*
account into it (`loadAllSharedTemplates` walks `get_my_pairs()`). OpenChat's registration format has
no per-chat dimension, so that one keyword map runs in every chat. A type belonging to the House
account routes in the child's chat.

Two distinct harms:

1. **Wrong-chat display.** The routed type NAME is a declared card row, hydrated for every recipient
   (`message_content_internal.rs` `hydrate` ignores the viewer), so a name from one account appears
   on the other member's screen in a different account's chat — before anyone confirms.
2. **World-readable roster.** `ai_apps` on the user_index is an unguarded query. Verified with an
   anonymous agent (no identity):

   ```
   keyword_map field="template" mode=override
     TEMPLATE -> "Reservation" keywords=[reservation, Reservation]
   ```

   Every type name **and its trigger keywords** is readable by anyone who can reach the canister. The
   directory being public is reasonable for an app registry; publishing the user's private vocabulary
   into it is IOU's mistake, not OpenChat's.

**Not affected.** Import-side containment already works: `resolveTemplateBase` resolves against the
CURRENT account's types only, so a foreign name matches nothing and applies no fee/schedule/defaults.
Pinned in `src/features/entries/resolveTemplateBase.test.ts`. The reachable exception is a same-name
collision — two accounts each with a type called "Rent" and different terms — where the wrong one CAN
apply.

**Reproduce.** Propose in a chat linked to account A on a message mentioning a keyword belonging to a
type in account B; the card shows B's type. For the public read:
`pnpm exec tsx scripts/live/query-oc-manifest.ts --uix <user_index>`.

**Historical product target.** Both of these were requested on 2026-07-31, and they pull against each other —
this is the whole difficulty, so do not accept a design that quietly drops one:

- **R1.** When a card is created, the transaction is matched against the types of the sheet LINKED TO
  THAT CHAT, and the matched type is shown on the card. The Template row stays.
- **R2.** A type's name and its keywords are never visible outside the shared sheet that owns them —
  not to the public directory, and not in a chat linked to a different account.

Note that both members of a linked chat are, by construction, the two members of that sheet, so
showing the type inside THAT chat is fine. The harm is the public roster and the type surfacing in
some OTHER account's chat.

An earlier sketch — stop publishing the roster and match locally at IMPORT instead — satisfies R2 but
NOT R1: the match would land after the card, so the Template row would disappear. Recorded here so it
is not re-proposed as if it were free.

The tension is real: matching at card-creation time happens inside OpenChat, which only has what was
registered (public), while the types are readable only with an IOU session — and the card iframe is
storage-partitioned with no session (measured; see `cardCurrency.ts`). Current behaviour is pinned in
`actionManifest.test.ts` and `resolveTemplateBase.test.ts`, so whatever lands is a deliberate edit to
those tests rather than silent drift.

---

## 2. `frame-ancestors` for the WebView2 origin

**What.** OpenChat embeds IOU's card page (`/openchat/card`) in an iframe, so IOU's CSP must allow
that embedder via `frame-ancestors`. Local dev embeds from `localhost:5003`. The DESKTOP app embeds
from a **WebView2** origin, which is different. If production's header does not list it, the card
renders BLANK in the desktop app with nothing in the UI to explain why — a CSP refusal is silent to
the user and only visible in the console.

**Reproduce.** Open a confirmable card in the desktop app against a deployment whose asset canister
sends `frame-ancestors`; check the console for a refusal to frame.

**Done when** the production `.ic-assets.json5` header lists every origin that legitimately embeds the
card (local dev, the deployed OpenChat origin, and the desktop WebView2 origin), verified against a
real desktop build rather than reasoned about.

---

## 3. Stale committed Android bundle

**What.** A built web bundle for the Android wrapper is committed to the repo. It does not rebuild
with the app, so it ships whatever it contained when it was committed. Anyone testing on Android runs
old code, and the resulting bugs look like phantoms — they cannot be reproduced anywhere else.

**Done when** the bundle is either generated as part of the Android build (and gitignored) or deleted
outright if the wrapper is not being maintained. Either is fine; leaving a stale artifact that looks
current is not.

---

## 4. Live harnesses leave the `oc:manualExtract` seam ON

**What.** `scripts/live/verify-app-card-multi.ts` (:49, :54), `verify-app-card-edit.ts` (:39, :44)
and others set `localStorage["oc:manualExtract"] = "1"` in the OpenChat profile and never clear it.

**Why it matters — this already caused a real bug hunt.** With the seam left on, proposing shows a raw
JSON prompt instead of the no-model guidance, and (before the fix in open-chat-cycle `4ef294486`) a
dismissed prompt returned silently: the button did nothing and said nothing. The flag was the reason
the manager profile behaved differently from every other one.

**Done when** every harness that sets it restores the prior value on exit, success or failure, the way
`scripts/live/verify-nomodel-guide.ts` already does. Also check `journey-fanout.ts`,
`verify-default-currency.ts`, `verify-extraction-gate.ts`, `verify-multi-entry.ts`,
`journey-matrix.sh`.

---

## 5. Propose returns `unavailable` with the manual seam answered

**What.** On the local env, proposing in the manager profile (CDP 9241) returns `unavailable` and
posts NO card, even with `oc:manualExtract=1` and its JSON prompt answered with a valid extraction.
`.action-card` stays flat, all collapsed, zero iframes.

**Blocks** `scripts/live/verify-app-card-edit.ts` and `verify-app-card-multi.ts`, which look for
`.action-card:not(.collapsed):has(iframe)`.

**Ruled out.** Not the propose-handler changes (`0effa4a79` / `4ef294486`) — reverting
`ChatMessage.svelte` to `14f3a3802` reproduces the same no-card outcome, just silently. Not the IOU
card page (its own specs pass). Not auth: the only 401 is the video-call TURN endpoint, and messages
send fine.

**Open question.** `unavailable` originates in the on-device inference path
(`localAiCommand.ts:55`, from `inferOnDevice`), which a supplied `manualExtraction` should bypass
entirely. Trace `proposeAiActionForMessage` → `runDefinition` and find where the extraction is dropped
— or what else returns `unavailable`.

**Note when picking this up:** a propose harness must target the message by CONTENT. The chat list
renders newest-FIRST, so `.bubble-wrapper.last()` is the OLDEST message — this cost several wasted
runs proposing on "hi".

---

## 6. ~~`test/ui/openchat.ui.spec.ts:61` — chat→sheet link~~ — FIXED (`ee85f1b`)

> Superseded 2026-08-06: the raw `/openchat/link-chat?chat=...` surface remains removed
> and must not be restored. A raw-free **Open setup** surface now opens
> `/settings#openchat-routing`; an authenticated card request creates a caller-private,
> expiring pending route and the page never receives or renders the app-scoped handle.

Kept as a historical note because the *mistake* is reusable, not because the retired
surface remains supported.

The spec asserted on the literal "(current)", which `365d659` had renamed to "— this chat imports
here". The feature was never broken. It was diagnosed as "pre-existing, not us" on the strength of
re-running it with `SheetPage.tsx` stashed — but the breaking change was in `LinkChatPage.tsx`, from
a commit three hours earlier. **Stashing one file only rules out that file**; if a bisect is worth
doing, do it against a commit, not a guess.

The assertions are now structural (a checked `input[name="link-chat-sheet"]` on the named sheet's row,
an unlink control by role) rather than copy, so rewording cannot break it again — verified by renaming
the marker in the product and watching the test still pass.

Related trap, still true: **`pnpm exec tsc --noEmit` does not typecheck `test/ui`** — `tsconfig.json`
has `"include": ["src"]`. Playwright specs are unprotected by the repo typecheck; check them directly.
