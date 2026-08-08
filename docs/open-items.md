# Open items

Known-but-unfixed things, so they stop living in chat history. Each entry says what it is, how to
see it, and what "done" means — enough to pick up cold.

Last updated: 2026-08-08.

## Current card candidate — aggregate source green; rollout pending

This section supersedes older entries below that call **Load app card**, **Share private context**,
an in-frame Add button, or a second approval screen mandatory for an exact trusted card viewed by an
already-paired recipient. The older entries describe the previously deployed revision. They are
retained only as regression history.

- **Values-first trusted card:** after exact app/revision/action, release, URL, directory, and full
  content verification, OpenChat automatically renders the credentialless isolated app card with its
  authoritative IOU logo/name and fields. The only explanatory metadata on the normal trusted surface
  is the registered exact URL; the disclosure/protocol prose is gone.
  A durable non-empty per-user app key is the pairing/consent signal, so an actionable paired viewer
  gets private context once without another Load/Share gesture. Unpaired viewers remain public-only:
  there is no in-card Share action, and linking/pairing belongs in that chat's settings. Readonly
  views never auto-share.
- **Security boundary retained:** automatic rendering still requires every exact trust gate. The
  iframe has no credentials or referrer, is opaque `allow-scripts` without `allow-same-origin`, and
  remains nonce/window-source bound. Capabilities do not enter URLs. Failures remain visible and
  provide concise actionable diagnostics while confirmation stays disabled. The iframe owns the
  values, not the actions: OpenChat renders the sole **Add to IOU** and **Cancel** controls. One Add
  click creates a fresh frame/session/card-bound collection challenge, accepts only the exact current
  iframe response, consumes it before obtaining the exact-payload grant, and submits directly. There
  is no second approval summary/click; unsolicited, legacy, wrong, replayed, stale, timed-out, and
  malformed replies fail closed.
- **IOU disclosure removed:** generic applications may still register their own disclosure. IOU's
  prose added information but no authorization or integrity beyond the verified logo/name, action,
  and exact URL, so issue [#62](https://github.com/ktimam/IOU/issues/62) removes it.
- **Atomic batches:** OpenChat issue [#106](https://github.com/ktimam/open-chat/issues/106) replaces
  the fail-closed exact-payload-endpoint error with one combined host-rendered card backed by one
  app-attested, backend-stored exact JSON array. Public `Entry N` rows contain only labeled
  manifest-order summaries; no hidden payload row is published. One host confirmation posts the
  stored array, with 32-entry and title/row/16-KiB payload/64-KiB aggregate bounds. IOU issue
  [#63](https://github.com/ktimam/IOU/issues/63) adds the separate ledger atomicity boundary:
  `add_entry_batch` accepts 1..32 rows (including chat/relay singletons), preflights every row/quota,
  commits without an await, and stores a receipt keyed by sheet plus exact 32-byte import id. A retry
  returns the original ids even if later parsing/filtering/ciphertext differs; current membership and
  active-sheet checks still precede receipt lookup, and no client payload hash is trusted.
- **Type/Date:** IOU issue [#61](https://github.com/ktimam/IOU/issues/61) adds public transaction
  `Type` and `Date` to initial single- and multi-card fields. Private account template `Saved type`
  remains absent from the public manifest/card/message/URL/logs and automatically hydrates only from
  the sheet linked to that chat, without another Load/Share gesture. Only encrypted `template_ref`
  leaves the frame. Batch matching is row-local; route/context changes clear private state and
  discard late hydration from an old sheet. IOU [#64](https://github.com/ktimam/IOU/issues/64)
  makes saved-type id/display-name collisions fail closed.
- **Image-only identity:** the image journey sends an empty composer body, not a caption or duplicated
  text. It binds processed draft bytes to the uploaded HTTP(S) attachment by SHA-256, byte length,
  and normalized MIME type; selects only a fresh sender-owned image at stable message coordinates;
  and revalidates the bytes before Propose and Delete. A card becomes a cleanup target only after its
  verified iframe contains the run nonce, and deletion requires wrapper absence or a tombstone rather
  than a URL swap. The focused safety/policy set passes **40/40**.
- **Red-first evidence:** one-click card collection/submit is **103/103** focused in OpenChat;
  batch coverage began with **9 failures** alongside 173 passes and is now **182/182**. IOU first
  exposed **7** Type failures, then **5** row-local batch failures and **2** manifest/Date parity
  failures before correction. IOU's focused card/import/security set is **88/88**, its two
  TypeScript projects pass, and the complete Rust suite is **81/81** after receipt-cleanup isolation.
  The new live E2E is red against the old deployed module at its exact `inspect_message` whitelist
  rejection of `add_entry_batch`; candidate live green requires the pending in-place upgrade. Final
  aggregate gates pass: OpenChat **1,079/1,079** across 76 files with both TypeScript projects green;
  IOU **984/984** across 80 files, **20/20** real-browser card tests, both TypeScript projects, and
  the production frontend build.
- **Issue ledger:** OpenChat [#105](https://github.com/ktimam/open-chat/issues/105) owns trusted
  auto-load/one host confirmation and [#106](https://github.com/ktimam/open-chat/issues/106) owns
  one-card multi-entry confirmation. IOU #61/#62/#63/#64 own Type/private hydration, disclosure,
  atomic import receipts, and collision handling respectively. Existing IOU #60 owns image-only
  real-model acceptance and #52 owns the complete signed-in lifecycle; no new tracker is required.
- **Still open before completion:** state-preserving IOU backend upgrade, revised manifest
  registration and exact verifier binding, relinking all four accounts, controlled frontend restart,
  signed-in single- and multi-entry delivery/import/History/cleanup journeys, then commits and
  pushes. None of those rollout/live/commit steps is claimed complete by the focused tests above.

## Operational/QC status addendum — 2026-08-08

This historical checkpoint supplements the pushed-head history below. The newer card-candidate
section above is authoritative for current source and rollout status.

- **Resolved locally — Vite CPU:** IOU no longer watches `target`, browser profiles, `.dfx`,
  coverage, Android output, or OpenChat artifacts and now fails on a duplicate port. OpenChat uses
  one validated `OC_DEV_PORT` for listener and HMR. The focused failing-first policies pass; warm
  20-second samples measured each Vite process at about **0.08% of one CPU core**.
- **External diagnosis — GlassWire:** GlassWire 3.8.1061 x86 generated about **1.20 GiB**
  of logs, including **1,528,967** duplicate `Process already exists` records in one log. The evidence
  most strongly implicates GlassWire's process/resource tracking response to development-process
  churn, but does not prove the development workload was causally irrelevant. It remained
  stable after restart; narrower Vite watching only reduces trigger volume and is not claimed to
  repair GlassWire.
- **Resolved locally — reboot recovery:** the preserved PocketIC state was backed up, opened once
  with incomplete-state recovery, cleanly checkpointed, and then strictly reopened with
  `incomplete_state: null`. Four accounts, canister ids, versions, and the deployed commit remain
  intact; no backend upgrade was required.
- **Resolved locally — signed-in browser launch:** Windows had reserved every former CDP port.
  Tracked helpers centralize `19222`, `19231`, and `19241`–`19243` and bind-probe healer relaunches.
  Profile reuse and the DevTools-readiness wait are in local **untracked** `scripts/live/launch.ps1`.
  Its loose process/profile matching and HTTP-only readiness probe are unsafe for another four-account
  mutating journey until corrected; it describes this recovered machine, not behavior shipped by the commit.
- **Historical image lifecycle passed:** the old IOU prompt made Qwen3-VL emit competing
  `settlement`/`iou`
  objects for one visible amount; OpenChat refused the batch, and a same-model/image minimal-prompt
  comparison isolated prompt cardinality rather than duplicate image/text input. After the prompt
  and exact-target Delete retry fixes, the final run at revision `1786188022801` opened zero JSON
  prompts, returned one trusted 350 EGP credit card with exact evidence `PAID: 350 EGP`, and
  completed the then-current gated recipient flow → Add to IOU → routed Pending → Review & add →
  History → exact
  post-reload cleanup. That historical run used a visible neutral caption which was not supplied to
  inference; the current candidate instead sends the image as the entire message with no caption.
- **Historical compact-gate checkpoint:** PR 2 head
  `2ff6ad73b50f4aa8d73c9b56ca0e722c933ba8f0` reduced the old pre-load copy and was registered as
  revision `1786188022801`. It is superseded by the values-first source candidate above; its focused
  **62/62** (**66/66** combined) and frontend **1,053/1,053** results are retained as old-head evidence,
  not as the current UX or rollout status.
- **Historical IOU source gate:** **929/929 across 79 files**, both TypeScript projects, and diff check pass.
- **Issue ledger:** [IOU #57](https://github.com/ktimam/IOU/issues/57) and
  [#60](https://github.com/ktimam/IOU/issues/60) are fixed by this IOU commit;
  [#58](https://github.com/ktimam/IOU/issues/58) remains open for launcher-level simulations and
  [#59](https://github.com/ktimam/IOU/issues/59) for tracked crash-recovery lifecycle coverage.
  The pushed OpenChat PR 2 checkpoint fixed [#104](https://github.com/ktimam/open-chat/issues/104).
  Current card work is tracked by reopened [#105](https://github.com/ktimam/open-chat/issues/105),
  [#106](https://github.com/ktimam/open-chat/issues/106), IOU
  [#61](https://github.com/ktimam/IOU/issues/61), [#62](https://github.com/ktimam/IOU/issues/62),
  [#63](https://github.com/ktimam/IOU/issues/63), and [#64](https://github.com/ktimam/IOU/issues/64).

## Historical status checkpoint — 2026-08-07 (superseded above)

This section overrode the still-older hashes, deployment wording, and live-QC claims below. The
current card-candidate section at the top now takes precedence.

- OpenChat PR 1 is pushed at `f43d2a2d53f2c9f8a3086104a356d4d3a315858a`.
- OpenChat PR 2 is pushed at `2ff6ad73b50f4aa8d73c9b56ca0e722c933ba8f0`; exact frontend
  **1,053/1,053 across 76 files**, frontend typecheck, and the signed-in live journey pass. The prior
  backend/agent/ESLint/Prettier/`cargo fmt`/Linux gates cover paths unchanged by this frontend-only
  follow-up.
- Exact PR 2 artifacts are deployed on the recovered three-subnet PocketIC state: UserIndex
  `0.0.9`, LocalUserIndex `0.0.5`, four User children `0.0.3`, the private Group `0.0.4`, and the
  Community template `0.0.4`. There is no Community instance. GroupIndex was not deployed or
  upgraded in this rollout.
- The recreated-account-safe Father two-chat/two-sheet routing journey dynamically discovers the
  current distinct House and Family ids and passes **17/17**. The disposable account-scoped Type
  isolation journey passes **12/12**.
- The sender-state/identity defect exposed by the earlier **8/8** hydration run is fixed and pushed.
  The latest signed-in journey observed optimistic-to-verified reconciliation in place, auto-loaded
  only the exact fresh proposer card, used that checkpoint's recipient gate, and showed no stale
  untrusted-content warning.
- `scripts/live/journey-fanout.ts` now implements chat send → in-card **Add to IOU** → routed
  **Pending from chat**/**Review & add** → prefilled `EntryForm` → persisted **History** → exact
  nonce soft-delete cleanup. It passes against the current frontend; IOU #52 tracks hosted/CI
  placement, not a missing local journey.
- The live harness now treats Propose as a one-shot mutation: exactly one click, a 60-second
  observation window, and no mutation retry. The failing-first source policy and controlled image
  run close IOU #56. A stopped tool display is not assumed to have stopped its child process;
  tracked live runs are explicitly monitored through exit.
- Image proposal schema/attester alignment is pushed at the current PR 2 head: explicit `acceptsImage`,
  amount/string bounds, safe formats, valid calendar dates, ASCII-uppercase currency, NUL-free
  text, and the `0.005` half-minor-unit boundary. The current live app #1 advertises
  `accepts_image=true`; the one-shot manager→father image journey removed malformed currency/date,
  obtained exact attestation, auto-loaded only for the proposer, delivered only to father, rendered
  Pending, imported through Review & add, verified History, and cleaned back to baseline.
- The changed manifest is registered with the matching exact verifier/bindings in the current local
  environment. Manager and father passed the image lifecycle; hosted/four-profile automation remains
  IOU #52 rather than a missing product or local acceptance path.
- At the superseded 2026-08-07 checkpoint, IOU verification was unit **901/901 across 77 files**, Rust **68/68**, and live E2E
  **56/56** under split verification. The initial **52/55** exposed three obsolete registry
  expectations; **51**
  unaffected scenarios remained green, and the replacement read-only/ownership plus live
  owner-attestation registry suite passed **5/5**. Unit coverage is **71.49%** statements/lines,
  **84.85%** branches, and **86.9%** functions.
- Restart/recovery work must use the supported NNS + Internet Identity + System `FromPath` PocketIC
  state. The old normal six-subnet `dfx` flow must not be used.
- The safety-reviewed IOU-local `scripts/live/pocketic-recovered.ps1` wrapper completed two clean
  stop/checkpoint/strict-reopen/status cycles. Each reopen dynamically parsed its instance id,
  control port, and exact PID and revalidated the full three-subnet topology plus seven deployed
  canisters. Exact PR 2 `001a1e298` was healthy after cycle 2, with post-restart routing **17/17**,
  Type isolation **12/12**, and card hydration **8/8** retained.
- The optional extra cleanup gate was rejected. The obsolete six-subnet state and remaining WSL
  artifacts were **not** deleted and remain preserved. Earlier bounded debug/build cleanup recovered
  about **46.8 GiB**.

---

## 1. Cross-account type leak (privacy) — **resolved 2026-08-01**

**Resolution.** IOU no longer decrypts, aggregates, or supplies account templates to manifest
registration. The public rules, response schema, and card rows contain no private template fields;
matching now happens locally after import against only the linked account. Unit coverage and the
live registry E2E assert that even a deliberately supplied private roster is absent on read-back.

**Private display follow-up (source candidate green; rollout/live/commit pending).** Public `Type`
is now the transaction kind from the action payload and is visible with public `Date` from initial
single- or multi-card render. It is not the account-private roster. The private selector is named
`Saved type`: IOU decrypts only the type roster for the sheet linked to that chat, in iframe memory,
and returns the selection as an AES-GCM reference bound to sheet, chat, message, and row. Plaintext
saved-type ids, names, and keywords remain absent from the manifest, public rows, chat message, URL,
storage, and logs.

For an exact trusted actionable viewer with an existing app pairing, OpenChat automatically requests
that private context once; another per-card Load/Share gesture is not required. An unpaired viewer
remains public-only and must link the app from that chat's settings; there is no in-card Share action.
Readonly views never auto-share. Multi-entry matching uses row-local evidence rather than the shared
source message. A route/context change clears private selection, and a late response from the prior
sheet is ignored. Import fallback applies the same row-local containment.

The owner approved both narrowly scoped data flows: OpenChat may send the exact public card and
exact final confirmation bytes to UserIndex and the registered app canister for attestation, and
may deliver a short-lived one-time viewer/card/key-bound capability to the exact sandboxed iframe
only after durable pairing established from chat settings. IOU now implements both exact
app-canister attesters, independently recomputes
the portable card hash, rejects unknown/duplicate/plaintext Type fields, and accepts a Type only
as a structurally valid opaque encrypted `template_ref` tied to the current linked active sheet.
The OpenChat backend/frontend candidate implements the generic transport, pairing-gated capability
bridge, and one host-owned Add action that collects the exact current iframe values, obtains the
exact-payload grant, and submits directly without a second approval. Older live checkpoints proved account isolation **12/12**,
per-chat routing **17/17**, and card hydration **8/8**, including House `Rent` without Family
`Family expense`; those runs used the superseded gesture-based card flow. They are privacy evidence,
not acceptance for the new values-first candidate. Its focused one-click and IOU source gates pass;
the final aggregate gates, new single- and multi-entry signed-in journeys, backend/manifest rollout,
commit, and push remain open.
Production remains disabled.
Activation also requires the non-empty legacy-inbox
drain/export/reinstall decision, durable confirmation-saga recovery, snapshot-rollback key reseed,
a retired-key erasure threat model, strict generated-contract parity, Linux PocketIC coverage, a
disposable live backend upgrade, and the four-profile isolation matrix. The historical card result is
not a reason to republish the roster.

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

## 4. Live harnesses leave the `oc:manualExtract` seam ON -- **fixed, pushed, and live-verified; hosted gate pending**

**Root cause proved 2026-08-08.** OpenChat commit `1219b8a21` deliberately moved the manual-QC
prompt ahead of an available on-device model. Several IOU live scripts had meanwhile persisted
`localStorage["oc:manualExtract"] = "1"` in the real manager profile and some deleted that
profile's downloaded model without restoring it. A second defect made prompt **Cancel** return the
same `undefined` value as "QC seam disabled"; with a model available, Cancel therefore fell through
to inference and posted another card. The mobile tree also lacked the classic tree's in-flight
Propose guard.

The Claude-era tests were not deleted. Git history still contains
`scripts/live/verify-nomodel-guide.ts` (introduced by `f55f327`),
`test/ui/openchatCard.ui.spec.ts` (`2f55de4`), `test/ui/openchat.ui.spec.ts` (`c76acbf`),
and `scripts/live/journey-fanout.ts`. The coverage hole was structural: the live scripts are
standalone signed-in checks, IOU CI did not invoke `pnpm test:ui`, the IOU Playwright files do not
click OpenChat's real Propose menu, and `1219b8a21` replaced the OpenChat unit expectation that
would have rejected this precedence change.

**Pushed correction.** OpenChat now ignores the stale persistent flag and accepts the manual seam
only from the temporary tab's `?manualExtract=1` query. Cancel has a distinct sentinel and returns
before model inference or posting; malformed and wrong-shaped JSON abort; desktop has a real
multi-action chooser; and both desktop and mobile use one shared single-flight boundary with visible
progress. IOU live harnesses use disposable signed-in tabs, close them in `finally`,
and no longer clear/download/delete a user's model or mutate the persistent seam. The full Journey
harness also owns and deletes only its exact nonce-scoped source/card IDs.

**Evidence and remaining gate.** The manager profile was verified live with
`canInferOnDevice() === true`, no persistent flag, one isolated JSON prompt, and **zero cards**
after Cancel. Eight reviewed test/duplicate cards and ten anchored `Journey ...` sources were
removed through ordinary OpenChat Delete actions; `owe 200` and unrelated messages were retained.
The deterministic OpenChat spec is part of standard OpenChat PR CI. IOU CI now installs Chromium
and requires all 18 existing `openchatCard.ui.spec.ts` cases. The signed-in browser checks are now
named `pnpm test:live:openchat:propose` and `pnpm test:live:openchat:journey`, but a hosted
four-profile/live-canister job remains an explicit release gap under IOU #52.

OpenChat PR 2 commit `cb6bc72b6` contains the generic correction. Its focused tests pass
**77/77**, its full frontend suite passes **1,035/1,035 across 75 files**, and the complete local
manager-to-father journey passes through one attested card, **Add to IOU**, routed
**Pending from chat**, **Review & add**, and the exact 350 EGP **History** entry. Exact teardown and
post-reload absence checks pass.

> The reproduction and original done-when text below are retained as historical evidence; the
> persistent-state part is superseded by the query-only/disposable-tab design above.

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

## 5. PR 2 ActionCard sender/identity/content state — **values-first candidate source-green; rollout/live/commit pending**

**Current supersession.** Exact trusted cards now auto-render for supported viewers. The card uses
the authoritative directory logo/name, shows its fields immediately, and exposes only the registered
exact URL instead of a load wall or protocol explanation. An actionable paired viewer receives one
automatic private-context request; an unpaired viewer remains public-only and links from chat
settings, while a readonly viewer receives none. Exact app/revision/action/release/content verification,
credentialless/no-referrer opaque sandboxing, nonce/window-source binding, capability isolation,
and fail-closed diagnostics remain enforced. OpenChat owns the only Add/Cancel controls. One Add
click collects the exact current values through a fresh frame/session/card-bound challenge, consumes
that challenge before the exact-payload grant, and submits directly; there is no iframe action or
second approval screen.

This source candidate also restores atomic multi-action cards through one backend-attested stored
payload and one host-rendered card, so no app-specific exact-payload endpoint or hidden public payload
row is needed. IOU's public Type and Date are present in manifest-order rows; private Saved type is
linked-sheet-only, automatically hydrated for paired actionable viewers, and row-local for batches.
IOU then commits all 1..32 imported rows through one receipt-backed `add_entry_batch` update, including
chat/relay singletons. The focused red/green evidence is recorded at the top of this file; the final
aggregate gates pass. Live single/multi journeys, the IOU backend/manifest revision rollout,
and both repositories' commits/pushes are still pending.

**Historical checkpoints.** Earlier pushed heads fixed optimistic-to-canonical reconciliation,
reactive exact identity resolution, and false untrusted labels, then introduced an intermediate
gesture-gated recipient flow. Its manager-to-father and private hydration journeys remain useful
regression evidence, but they do not describe the current source candidate or prove its rollout.

**Historical expanded QC passed locally.** `scripts/live/journey-fanout.ts` continues past the two inbox-count
assertions: it resolves the confirmer's exact routed sheet, checks the nonce under **Pending from
chat**, presses **Review & add**, verifies/submits the prefilled `EntryForm`, confirms the entry in
**History**, and soft-deletes exactly that nonce. The prior-revision signed-in journey passed; it must
now be rerun for both one- and multi-entry cards after the pending rollout. Hosted four-profile CI
placement remains open under IOU #52.

**Historical observation.** The following describes the earlier frontend/flag state that motivated
the investigation; do not use it as the current reproduction.

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
> `/settings#openchat-routing/{chatLinkToken}`. IOU #51 now captures and scrubs the one-time
> token synchronously in the main entry point before dynamically loading authentication/bootstrap.
> It is then redeemed by the authenticated IOU backend against the caller's exact OpenChat app subject and
> creates a caller-private expiring pending route only after exact subject, subject-version,
> `app_user_key_version`, app/revision/canister, and handle checks. Legacy card-derived rows have
> no claim version and are hidden/non-actionable. Each successful token claim has an independently
> routable pending id; the page never receives or renders the app-scoped handle. The OpenChat
> one-hour digest receipt plus IOU's 30-second bounded call make exact-token retry safe after an
> ambiguous result, and the production page single-flights React StrictMode/remount claims.
>
> Final IOU gates after #51 are Cargo **68/68**, frontend **846/846 across 71 files**, typecheck,
> production Vite build, and routing Playwright **5/5** using the installed system Chrome. #51's
> after-async-auth scrub ordering failed first **1/1** and its focused correction passes **5/5**.
> The first Playwright invocation failed only because its bundled browser binary was absent; the
> supported `PLAYWRIGHT_EXECUTABLE_PATH` rerun passed **5/5**, with no code failure. The
> exact IOU hash, push, and deployment remain pending. Keep those IOU results distinct from
> OpenChat's gates. PR 1's final pushed head is
> `f43d2a2d53f2c9f8a3086104a356d4d3a315858a`, with #92 fixed and pushed. Five focused
> web/model/on-device files pass **145/145**, typecheck reports **0 errors**, and exact WSL
> `prod_test` completed in **10m36s**. Its emitted **7,656,521-byte** Wllama Wasm is
> byte-identical to source at SHA-256
> `4197ce6d3dc9240c42ee52b4197dc99638875a06b0083901f8a57767338a0cfa`, with zero
> unresolved Wllama references. PR 1 deployment remains pending.
>
> PR 2's exact pushed post-rebase head is
> `16080b0780ed97c3cd63d4187188ac04b19b3769`. At that head the frontend suite passes
> **958/958**, Svelte typecheck reports
> **0 errors and 565 warnings**, the agent typecheck is green, and #90's root-command proof passes
> **44/44**. The post-rebase backend tree is exact to the previously green tree. Recorded backend
> evidence is UserIndex **253/253**, token model
> **11/11**, LocalUserIndex **35/35**, Community **15/15**, Group **11/11**, User **19/19**,
> architecture **10/10**, and Candid golden **1/1**. Latest focused setup-token evidence is common
> admission **4/4**, GroupIndex cancellation **2/2**, Group **3/3**, and Community **3/3**; no
> aggregate GroupIndex total is claimed.
>
> The final exact-blob Linux `prod_test` exited **0**: Rollup completed in **11m46.9s** and the
> wrapper in **716s**. The bundle emits and references a byte-identical **7,656,521-byte** Wllama
> Wasm at SHA-256
> `4197ce6d3dc9240c42ee52b4197dc99638875a06b0083901f8a57767338a0cfa`, with zero
> unresolved Wllama references. The successful retry used the exact Git blob after an
> environment-only CRLF wrapper failure and supplied mandatory `OC_WEBSITE_VERSION=1.0.0`, the
> canonical CI value. Baseline unresolved `porto`/`accounts` notices and the known nonfatal
> public-key CRLF warning remain out of scope. PR 2 deployment remains pending.
>
> OpenChat #81–#86 record the fixed authorization, admission/lifecycle, diagnostic, pre-consent,
> async-snapshot, and navigation-binding defects; #89/#90 record the clean-gate fixes. Inherited
> wallet dependency issue #87 remains a separate maintenance item, unchanged by either PR. #91's
> generic desktop `open_url` fix is committed in the exact pushed PR 2 head, contains no
> Father/profile override, and retains its pre-rebase focused **2/2** plus plugin **17/17** evidence
> through exact tree equivalence. OpenChat #92 is fixed and pushed in the final PR 1 head.
>
> The local-only Father **Open setup** → **Open in browser** proof opened a distinct Father-profile
> window, scrubbed the fragment, reached the exact `/settings#openchat-routing` route signed in,
> and left the default browser unchanged. It is neither PR 2 nor deployment evidence and does not
> prove redemption or assignment. Deploy the pushed OpenChat producer before the IOU consumer.
> Preserved-state live redemption and the
> two-chat/two-sheet acceptance remain pending.

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

---

## 7. Image proposal schema and app-attester mismatch — **fixed and live-verified**

**What reproduced.** An image/model extraction could include malformed optional fields that passed
OpenChat's shallow schema post-pass but were rejected by IOU's exact app attester. The result was an
unavailable proposal or an untrusted/actionless card even though a valid amount was present.

**In-tree resolution.** Generic PR 2 now accepts image input only when the action explicitly sets
`acceptsImage: true` and enforces declared numeric bounds, Unicode code-point string bounds, valid
calendar dates, and deterministic allowlisted formats. IOU's manifest and generated registration
mirror the canister boundary: `0.005` minimum major amount, safe integer-derived maximum, exactly
three ASCII-uppercase currency characters, actual `YYYY-MM-DD` dates, and bounded NUL-free
note/message. Invalid optional OCR fields are removed before attestation; the canister still rejects
any invalid exact payload that reaches it.

**Historical verification.** OpenChat's focused image suites passed **89/89**; IOU's production schema suite
passes **4/4**, the related draft/parser matrix passes **20/20**, and the exact Rust malformed-image
attester case passes. The active manifest reports `accepts_image=true`. A controlled signed-in
image journey then passed one image/source → sanitized exact card → the then-current recipient gate
and confirmation → ActionInbox → routed Pending → Review & add → History, followed by
nonce-exact source/card/entry cleanup.

---

## 8. Manifest revision and four-user binding handoff — **prior revision verified; new revision pending**

**What.** The schema correction changes the registered manifest. Re-registration advances the app
revision, while IOU's verifier and each father/mother/child/property-manager connection are pinned to
an exact revision. Testing a new frontend/manifest against old bindings is expected to fail closed
and can be misdiagnosed as another card defect.

**Prior disposition.** The app #1 directory entry at revision `1786188022801`, app/inbox
canisters, per-user-key mode, and `accepts_image=true` were read back from UserIndex. All four
father/mother/child/property-manager accounts were relinked to that revision with authenticated
selectors, and the manager-to-father image journey passed there. Hosted four-profile automation
remains under IOU #52, and stale revisions continue to fail closed. The no-disclosure Type/Date candidate requires
a new registration, exact verifier binding, backend upgrade, four-account relink, and signed-in
journeys; none is yet claimed complete.

---

## 9. Local vision-model image journey — **prior revision passed; image-only candidate rerun pending**

**Current candidate harness.** The image is the complete chat message: no caption or duplicate text
is sent. Before Send, the harness records SHA-256, byte length, and normalized MIME type for the
processed preview bytes. It then waits for the new sender-owned uploaded HTTP(S) image, fetches it,
requires the exact digest/length/MIME tuple, and binds it to stable message coordinates. The same
content evidence is rechecked before Propose and Delete. The run nonce is added to the editable card
Note only after model extraction, and a card is eligible for cleanup only after its verified iframe
contains that nonce. Wrapper absence or a deletion tombstone must survive reload; an image URL swap
does not count as deletion. Focused source and cleanup policy coverage passes **40/40**.

**Prior-revision result.** An earlier ambiguous `CREDIT` fixture failed closed and exposed a detached
Delete-menu race. After the bounded exact-target retry fix, the final run at revision `1786188022801`
selected Qwen3-VL, opened **zero** manual JSON prompts, validated 350 EGP credit before editing, and
completed the then-current recipient gate → Add to IOU → routed Pending → Review & add → 350 EGP History → exact
entry/inbox/card/source cleanup after reload.

**Adjacent negative case retained.** With one visible amount, the old IOU prompt asked for competing
ledger interpretations and Qwen3-VL returned both `settlement` and `iou`. OpenChat refused that
batch, posted no card, and cleaned the source. The same model/adapter/image returned one object with
a minimal one-object prompt, so the duplication was prompt-induced rather than a duplicated image
or inference call. The fixed IOU prompt retains the fail-closed batch boundary while requiring one
object and exact visible amount/currency evidence for a single visible transaction.

**Reproduce.** Run `scripts/live/journey-fanout.ts --real-model --image <single-entry-receipt>` from
the manager→father environment. The script refuses `manualExtract`, waits for an image-capable model,
requires an image-only source with matching uploaded bytes, clicks Propose once, requires zero prompt
calls, and verifies the complete lifecycle and cleanup.
