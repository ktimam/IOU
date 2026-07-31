# Open items

Known-but-unfixed things, so they stop living in chat history. Each entry says what it is, how to
see it, and what "done" means — enough to pick up cold.

Last updated: 2026-07-31.

---

## 1. Cross-account type leak (privacy) — **highest priority**

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

**Done when** a type's name and keywords never leave the account that owns them. The candidate design
(IOU-only, no fork change) is to stop publishing the roster and do the routing locally at import
instead: drop the `template` keyword_map from the manifest, and have IOU match the note/message
against THIS account's types when the draft is imported. Same feature, no leak — the loss is the
Template row on the card at propose time, which the storage-partitioned card iframe cannot populate
anyway. Current behaviour is pinned in `actionManifest.test.ts` so the change is a deliberate edit,
not silent drift.

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

## 6. `test/ui/openchat.ui.spec.ts:61` — chat→sheet link

**What.** The Playwright spec covering link → "(current)" → unlink → per-user isolation fails. The
FEATURE works (linking a sheet to a chat behaves correctly in the app); the test does not.

**Reproduce.**

```bash
pnpm test:ui test/ui/openchat.ui.spec.ts --grep "chat.sheet link"
```

**Confirmed pre-existing** — fails identically with `src/features/entries/SheetPage.tsx` stashed, so
the `inboxFilter` / `resolveTemplateBase` extraction did not cause it. Prime suspect is a stale
assertion: `LinkChatPage.tsx` recently changed its subtitle to "shared with &lt;name&gt;" and added
"— this chat imports here" / "⚠ another chat already imports here".

**Done when** it passes and still catches a real regression in linking, unlinking, or cross-user
leakage — not when it has been weakened into passing.
