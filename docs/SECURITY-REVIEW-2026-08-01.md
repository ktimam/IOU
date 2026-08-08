# IOU and OpenChat fork security review — 2026-08-01

## Operational and card-QC addendum — 2026-08-08

This addendum records the post-reboot stability work and the latest image-card acceptance evidence.
It does not change the two-PR boundary: local-model work remains PR 1, while every OpenChat change
described here is generic external-app/card interface work in PR 2. The latest PR 2 frontend change
is pushed at `2ff6ad73b50f4aa8d73c9b56ca0e722c933ba8f0`; upstream review/merge and production rollout
remain pending.

### Vite CPU and external GlassWire diagnosis

The sustained local Vite load was a development watcher-scope defect, not model inference. IOU's
Vite process could watch the repository's rebuildable `target` tree (about **4.1 GiB / 9,933
files**), the in-repository Chromium profiles (about **195 MiB / 3,011 files**), `.dfx`, coverage,
Android output, and OpenChat artifacts. `vite.config.ts` now excludes those trees, keeps native
filesystem events rather than polling, and uses `strictPort` so a duplicate server cannot silently
move to another port. The failing-first repository policy is in
`src/security/repositoryPolicy.test.ts`. OpenChat's PR 2 development config has the corresponding
port/HMR regression coverage in `bootstrapSecurity.spec.ts` and derives both listener and HMR ports
from one validated `OC_DEV_PORT` value.

After warm browser compilation, a 20-second sample measured the IOU Vite process at about **0.08%
of one CPU core** and the OpenChat Vite process at about **0.08% of one core**. The focused IOU
policy and typecheck pass; the pushed OpenChat PR 2 head `2ff6ad73b50f4aa8d73c9b56ca0e722c933ba8f0`
passes **1,053/1,053 across 76 files** and reports zero typecheck errors. These measurements demonstrate that the former continuous CPU
loop is gone; they are not a general memory ceiling for a warm Svelte module graph.

The separate memory-growth evidence most strongly implicates **GlassWire 3.8.1061 x86 running on
x64 Windows**; it does not prove that IOU/OpenChat development-process churn was causally irrelevant.
Local GlassWire logs consumed about **1.20 GiB**; one 142 MiB log
contained **1,528,967** `Process already exists` records—about **99.95%** of its events and roughly
17.7 duplicates per second for a day. That evidence points to GlassWire's process/hardware-resource
tracking looping over browser/Node process churn. Restarting GlassWire cleared the live growth, and
the processes remained stable after reboot. Narrower Vite watching reduces the trigger volume but
is not presented as a fix for the third-party leak; operational mitigations are to avoid GlassWire's
Hardware Resources view/detailed logging, use its per-application Incognito mode for development
processes, and update when the applicable GlassWire release is acceptable.

### Compact PR 2 recipient gate without weaker boundaries

The pushed OpenChat PR 2 head now hides all explanatory description text in the trusted recipient's
pre-load card. The visible gate contains only the existing app/title headers, the initially closed
**Security details** disclosure, and **Load app card**. Destination/origin, IP exposure,
card/chat/message and direct-chat participant identifiers, exact app/revision/action URL, sandbox
properties, and the continued exclusion of private context remain available inside that closed
disclosure. A later private-context step likewise keeps its protocol explanation inside a separate
closed disclosure before the explicit share action.

This is copy/layout work only. Backend content attestation, the recipient's explicit **Load app
card** action, credentialless/no-referrer navigation, the opaque `allow-scripts` sandbox without
`allow-same-origin`, window-source/session-nonce binding, and the rule that capabilities never
enter the card URL are unchanged. Trust-failure warnings remain prominent and actionable controls
remain disabled for unattested content. The focused presentation gate passes **62/62** and the
combined related gate passes **66/66**; the full OpenChat result above includes the candidate. It is
pushed at `2ff6ad73b50f4aa8d73c9b56ca0e722c933ba8f0`, registered locally as app revision
`1786188022801`, and all four local accounts are relinked. Hosted review/CI and production rollout remain pending.

### Forced-reboot recovery and browser-profile harness

The forced reboot left the recovered PocketIC topology timestamp older than its completed
checkpoints, so a strict reopen correctly refused it. Before mutation, the exact state was copied to
`/home/kiko/openchat-cycle-abrupt-20260808-original` (**767 MiB**). A one-time
`incomplete_state: "Enabled"` recovery opened the state, after which a clean shutdown/checkpoint and
an `incomplete_state: null` strict reopen succeeded. All four accounts and canister identities were
preserved: UserIndex `0.0.9`, LocalUserIndex `0.0.5`, User children `0.0.3`, and Group `0.0.4`, with
the expected deployed commit still present. No IOU or OpenChat backend upgrade was needed for this
recovery, and the obsolete normal `dfx start` path remains prohibited for this preserved state.

The signed-in browser profiles had a separate Windows networking failure: the former CDP ports
`9222`, `9231`, and `9241`–`9243` fell inside excluded ranges `9189`–`9288` and `9289`–`9388`.
Tracked IOU helpers now centralize the selected ports (`19222`, `19231`, `19241`–`19243`) in
`scripts/live/cdp-ports.json` and bind-probe before a tracked healer relaunch. The profile-reuse and
DevTools-version readiness behavior used for this recovery lives in the local, deliberately
**untracked** `scripts/live/launch.ps1`; its loose process/profile matching and HTTP-only readiness
probe are unsafe for further four-account mutating journeys until corrected. It is historical
operational evidence, not a capability delivered by this commit. `src/security/cdpHarness.test.ts`
covers unique configured ports, occupied/free binds,
and a bounded stalled probe, and the father, mother, child, and manager sessions were restored in
their intended browser profiles.

### Image journey: deterministic and hardened real-model paths pass

The deterministic image journey now passes the complete manager-to-father boundary with real image
bytes: exactly one source and card, in-place optimistic-to-attested reconciliation, automatic
proposer load, explicit recipient load consent, **Add to IOU**, confirmer-only delivery, per-chat sheet routing,
**Pending from chat**, **Review & add**, a verified 350 EGP History entry, and exact cleanup of the
entry, source, card, and inbox counts after reload. This remains the reproducible schema,
attestation, transport, routing, and teardown gate.

Before the IOU prompt correction, one receipt with one visible amount caused Qwen3-VL to emit two
competing ledger interpretations (`settlement` and `iou`). OpenChat correctly refused the
multi-action result and posted no card. The same model, adapter, and image returned one object with
a minimal one-object prompt, isolating the duplication to the IOU prompt rather than duplicated
image/text input or duplicate inference calls. The corrected prompt requires one object for one
visible transaction and requires the model's `message` field to retain the shortest exact visible
amount/currency evidence.

An earlier hardened run then failed closed on an ambiguous `CREDIT` fixture and exposed a detached
Delete-menu render race. The source now retries only that recognized churn after revalidating the
same stable message, exact evidence, and sender ownership. The later final run, against registered
revision `1786188022801`, selected Qwen3-VL, opened **zero** manual JSON prompts, and produced one
trusted sender-owned card with `settlement`, `350`, `EGP`, `credit`, and exact visible evidence
`PAID: 350 EGP`. The neutral chat caption was used only to identify/clean the test artifact and was
not supplied to image inference. The journey completed recipient Load → **Add to IOU** →
father-only delivery → routed **Pending from chat** → **Review & add** → 350 EGP **History** plus
exact entry/inbox/card/source cleanup after reload.

The final IOU unit gate passes **929/929 across 79 files**. The focused behavior/policy suites, both
TypeScript projects, and `git diff --check` pass. The exact pushed OpenChat PR 2 head passes
**1,053/1,053 across 76 files** and Svelte typecheck reports zero
errors (baseline warnings remain).

The reproducible defects and remaining operations work are tracked in
[IOU #57](https://github.com/ktimam/IOU/issues/57) (Vite watcher CPU),
[IOU #58](https://github.com/ktimam/IOU/issues/58) (reserved CDP ports),
[IOU #59](https://github.com/ktimam/IOU/issues/59) (abrupt PocketIC recovery),
[IOU #60](https://github.com/ktimam/IOU/issues/60) (real vision-model acceptance),
[OpenChat #104](https://github.com/ktimam/open-chat/issues/104) (listener/HMR port drift), and
[OpenChat #105](https://github.com/ktimam/open-chat/issues/105) (mixed-phase consent density).
The fixes for #57/#60 are in this IOU commit, and the pushed PR 2 head contains the fixes for
#104/#105. Issue #58 retains the unsafe untracked launcher and remaining legacy live-utility
migration/simulation follow-up; #59 retains tracked recovery-wrapper/lifecycle tests. Upstream PR 2
review/merge remains pending.

## Current-state supersession -- 2026-08-08

This addendum supersedes the 2026-08-07 statements for the manual extraction seam, Propose/Cancel
behavior, live-harness profile safety, and browser-artifact cleanup. The older sections remain
dated audit history.

Browser QC reproduced a generic PR 2 regression: a real user with an installed model could receive
the internal raw-JSON QC prompt, and pressing **Cancel** could continue into inference and post one
or more cards. The defect required both product and harness failures. OpenChat commit `1219b8a21`
gave the manual prompt precedence over an available model; IOU live scripts had persisted
`oc:manualExtract=1` in the manager's real profile; and Cancel used the same `undefined` result as
"seam disabled." The mobile tree also lacked a one-at-a-time Propose boundary.

The pushed OpenChat correction is generic card/interface work and belongs only to PR 2. It is
commit `cb6bc72b6` on [PR 2 #73](https://github.com/ktimam/open-chat/pull/73), superseding the
older PR 2 frontend heads recorded in the dated sections below:

- persistent storage no longer enables manual extraction; only an explicit query on a temporary QC
  tab can do so;
- Cancel has a distinct result and exits before inference or card posting; malformed and
  wrong-shaped JSON also abort;
- desktop and mobile share a behavior-tested single-flight boundary, desktop has a real generic
  multi-action chooser, and both surfaces expose in-flight progress;
- focused logic tests live beside `aiActionRunner.ts` and `singleFlight.ts`, which standard
  OpenChat PR CI executes. The focused gate passes **77/77**, the full frontend gate passes
  **1,035/1,035 across 75 files**, and typecheck is green.

The IOU correction is harness-only. Signed-in checks clone the authenticated context into disposable
tabs, close them in `finally`, and do not mutate the normal tab, persistent seam, downloaded model,
or model IndexedDB. The complete Journey harness captures exact source/card message IDs, deletes its
card before its source through ordinary OpenChat UI, and verifies cleanup after reload. Named release
commands are `pnpm test:live:openchat:propose` and `pnpm test:live:openchat:journey`.

The refreshed dependency gate also identified
[GHSA-2v37-7h3g-55p8](https://github.com/advisories/GHSA-2v37-7h3g-55p8) in transitive
`nanoid@3.3.16` (via PostCSS/Vite). IOU now pins the patched 3.x release `3.3.17` through the
pnpm workspace override; the lockfile resolves only that version and `pnpm audit:deps` is green.

Live acceptance on the manager profile proved the reported boundary with the model available:
`canInferOnDevice() === true`, no persistent flag, one query-isolated prompt, Cancel, and zero new
cards after twelve seconds. The unique check message was removed and the normal tab restored. A
reviewed exact-ID cleanup separately removed eight duplicate/Journey cards and ten anchored Journey
sources while preserving `owe 200` and all unrelated messages.

The complete signed-in manager-to-father journey also passes against the running local environment:
one exact source, one JSON extraction prompt in the disposable QC tab, one backend-attested card on
both sides, in-place optimistic-to-verified reconciliation without reload, **Add to IOU**, a
one-envelope increase only for the confirmer, the exact routed **Pending from chat** draft,
prefilled **Review & add**, and the exact 350 EGP entry in **History**. Teardown then soft-deletes
only that nonce-scoped IOU entry and its two OpenChat messages, restores both inbox counts, reloads
both chat views, and proves the test artifacts remain absent.

The Claude-era tests were not deleted. The failure escaped because the signed-in scripts were
outside standard IOU CI, IOU Playwright covered the consumer iframe/import rather than OpenChat's
message-menu Propose path, and `1219b8a21` changed the OpenChat unit expectation to accept the
regression. IOU CI now requires that existing 18-case card/iframe Playwright suite; the signed-in
four-profile gate remains local. The detailed path/commit/CI audit is in
`docs/test-coverage-gaps.md`. A hosted
four-profile/live-canister gate remains open under IOU #52; deterministic cancellation and
single-flight behavior must remain required OpenChat PR CI.

The first hosted attempt exposed a command-selection bug rather than a card failure:
`pnpm test:ui -- <file>` expanded to the entire replica-dependent UI directory on Linux. The
intended 18 card cases all passed during that run, but unrelated replica tests retried until the
run was stopped. CI now invokes Playwright directly with the exact file and `--retries=0`; a policy
test rejects the ambiguous command form.

At this checkpoint IOU passes **901/901 tests across 77 files**; coverage is **71.56%** statements
and lines, **84.85%** branches, and **86.9%** functions. Typecheck, production build, and
`pnpm audit:deps` are green. The existing 18-case card/iframe Playwright suite and 69 Rust tests
also pass.

## Current-state supersession — 2026-08-07

This section is the authoritative status for hashes, tests, deployment, local topology, and live
acceptance. Any older passage below that calls itself "current", says PR 2 is at `16080b078`, says
the setup-token backend is undeployed, or describes the former six-subnet local replica is retained
only as dated audit history and must not be used operationally.

The OpenChat contribution remains exactly two generic pull requests:

| Pull request | Scope | Exact pushed head | Current evidence |
|---|---|---|---|
| [PR 1 #9132](https://github.com/open-chat-labs/open-chat/pull/9132) | Optional local inference and reusable local-model management | `f43d2a2d53f2c9f8a3086104a356d4d3a315858a` | Five focused files **145/145**, typecheck green, and exact WSL `prod_test` green |
| [PR 2 #73](https://github.com/ktimam/open-chat/pull/73) | Generic in-chat cards and external-app/chat interfaces | `2ff6ad73b50f4aa8d73c9b56ca0e722c933ba8f0` | Frontend **1,053/1,053 across 76 files**, focused presentation **62/62** (**66/66** combined), frontend typecheck (0 errors), and signed-in text plus image lifecycle journeys pass; prior backend/agent/ESLint/Prettier/`cargo fmt`/Linux gates cover paths unchanged by this frontend-only follow-up |

### Post-deployment PR 2 regression correction — 2026-08-07

The earlier deployed PR 2 head passed its recorded gates, but subsequent browser QC exposed four
generic card/interface regressions. Their fixes and failing-first coverage are now committed and
pushed at `2ff6ad73b50f4aa8d73c9b56ca0e722c933ba8f0`; local combined gates and live acceptance pass.
Hosted review/CI and any production rollout remain pending.

- A sender's optimistic ActionCard could remain unverified and actionless even after the backend
  accepted the provenance-backed send. Reloading replaced it with the canonical event and made the
  card usable, but that workaround is not acceptable product behavior. The PR 2 candidate now
  reconciles a successful, provenance-backed send into the authoritative verified card state while
  stripping send-only provenance, confirmation payload, recipient keys, and inbox routing material
  from the local event/cache. Forged or send-only RTC card data remains a fail-closed placeholder.
- The card component did not reliably bind or re-resolve the authoritative app identity when an
  optimistic card transitioned to its backend-attested state, and session resets could discard the
  identity. The candidate re-runs exact app resolution when the primitive verification identity
  changes and preserves that binding across iframe-session reset. It also corrects stale copy:
  `Directory binding only; card content is untrusted` and `Untrusted card text` now remain only for
  genuinely unattested content; a content-attested card no longer carries those labels. Unattested
  cards still have their actions disabled.
- Image proposals could carry model/OCR fields that passed OpenChat's shallow post-pass but failed
  IOU's stricter app attester, producing an unavailable or untrusted/actionless card. The candidate
  requires explicit `acceptsImage: true` for image input and applies declared numeric bounds,
  Unicode code-point string bounds, real calendar-date validation, and a small allowlist of safe
  formats. IOU's manifest now mirrors its attester: amount `0.005` is the lowest value that rounds
  to one minor unit, the upper bound remains safe after multiplying by 100, currency is exactly
  three ASCII uppercase characters, dates are valid `YYYY-MM-DD` calendar dates, and note/message
  are bounded and NUL-free. Invalid optional OCR fields are dropped before attestation; IOU's
  canister attester remains the final fail-closed boundary.
- A freshly proposed, fully attested card unnecessarily stopped at a second **Load app card** privacy
  gate, while its loaded iframe was labeled **Untrusted app content** even though the binding and full
  content attestation had succeeded. The proposer’s successful Propose action now acts as load
  consent only for that exact live sender event. Recipient, history, reload, readonly, unattested,
  unsupported-browser, and bounded-capacity cases remain explicitly gated or fail closed. A late
  sender payload cannot reset an iframe that the user already loaded manually. The sandbox remains
  `allow-scripts` without `allow-same-origin`; the neutral label is **External app content
  (isolated)**, while all genuine trust-failure warnings remain.

The local `scripts/live/journey-fanout.ts` now covers the continuous user journey rather than
stopping at encrypted inbox counts: send a nonce-scoped chat message, require proposer auto-load and
the recipient's explicit Load gate, press the iframe's **Add to IOU**, assert delivery, resolve the
authenticated confirmer's exact app-scoped chat route, find the draft under the routed sheet's
**Pending from chat**, press
**Review & add**, verify the prefilled `EntryForm`, submit **Add entry**, verify the nonce in
**History**, then soft-delete only that exact entry. The cleanup deliberately leaves the encrypted
audit tombstone while removing the entry from ordinary history/balances. This expanded journey is
green against the pushed head: sender optimistic→verified transition happened in place with no
navigation, no second Load click, and no stale untrusted warning; the recipient required Load,
confirmation delivered only to the father's bucket, the IOU History entry was verified, and all
nonce-scoped artifacts were cleaned. At the final pushed PR 2 head, focused presentation coverage
passes **62/62** (**66/66** combined), the complete frontend passes **1,053/1,053**, and
Svelte/TypeScript typecheck reports zero errors.

The image variant uploads real image bytes while using the isolated deterministic extraction seam
to inject representative malformed OCR/model fields (`$$$` currency and an impossible date).
The same production image capability gate, schema post-pass, exact app attestation, card, delivery,
and IOU import path then runs. At the current active app #1 registration
(`accepts_image=true`), the controlled manager→father run created exactly one source and one card,
removed both invalid optional fields before attestation, auto-loaded only the manager's fresh card,
required father to load and confirm, delivered only to father's ActionInbox bucket, rendered the
routed Pending row using father's account default currency, imported it through Review & add,
verified the nonce in History, and cleaned the entry/source/card back to baseline. The harness now
hard-caps Propose at one click and waits 60 seconds rather than retrying a mutation (IOU #56).

PR 2's exact artifacts are deployed to the recovered local PocketIC state in producer-before-
consumer order: UserIndex `0.0.9`, LocalUserIndex `0.0.5`, all four User canisters `0.0.3`, the
private Group instance `0.0.4`, and the Community child template `0.0.4`. There is no Community
instance in this fixture, so only its template was published. GroupIndex was not upgraded or
deployed as part of this rollout and must not be reported as such. The exact rollout completed with
clear queues and no failed upgrades.

The recoverable state is now a supported three-subnet PocketIC topology restored with
`SubnetStateConfig::FromPath` for NNS, Internet Identity, and System state. It passed clean deletion,
checkpoint, and strict reopen with `incomplete_state: null` while preserving canister ids and user
state. The former six-subnet snapshot cannot be reopened consistently because its saved cross-subnet
counters disagree; normal `dfx start`, `dfx stop`, and the old six-subnet `local-up.sh` flow must not
be used against this state.

The IOU-local `scripts/live/pocketic-recovered.ps1` wrapper was safety-reviewed and then completed
two full clean stop/checkpoint/strict-reopen/status cycles. Every reopen dynamically parsed its new
instance id, control port, and exact PID, then revalidated the complete three-subnet topology and
all seven deployed canisters. After cycle 2, exact PR 2 head `001a1e298` remained healthy and the
restarted live checks still passed routing **17/17**, Type isolation **12/12**, and card hydration
**8/8**. The rejected extra cleanup gate was not run: the obsolete six-subnet state and remaining
WSL artifacts remain preserved. Earlier bounded removal of rebuildable debug/build output recovered
about **46.8 GiB**.

Current live acceptance is deliberately split by boundary:

- the disposable account-scoped Type isolation journey passes **12/12** assertions, including
  partner visibility, author cross-account isolation, unrelated-user denial, removal propagation,
  and cleanup;
- the recreated-account-safe Father per-chat routing journey passes **17/17** assertions. It
  dynamically discovers the current distinct House and Family sheet ids, routes Father–manager to
  House and Father–mother to Family, scrubs both distinct one-time setup URLs, and preserves the
  existing connection;
- exact-PR-2 authorized private card hydration passes **8/8** live assertions after reloading the
  sender to replace its stale optimistic echo with the canonical event. That remains useful proof
  of canonical-event hydration and private-context isolation, but the required reload is now a
  reproduced sender-lifecycle regression, not an accepted workflow. Before consent the Type selector
  contains only `None`; explicit **Share private context** exposes House `Rent`, excludes Family
  `Family expense`, auto-selects `Rent`, and does not ask the Father account to reconnect;
- the extended chat → card → routed IOU draft → persisted History journey is implemented in
  `scripts/live/journey-fanout.ts`, including nonce-exact soft-delete cleanup; both the text journey
  and the deterministic malformed-image journey pass against the updated runtime.

The current IOU unit suite passes **901/901 across 77 files** and Rust passes **68/68**. Unit
coverage is **71.49%** for statements and lines, **84.85%** for branches, and **86.9%** for
functions. The live E2E suite is **56/56** under split verification: its initial **52/55** run
exposed three obsolete registry
expectations; **51** unaffected scenarios remained green, and the replacement read-only/ownership
plus live owner-attestation registry suite passed **5/5**.

Neither PR contains IOU-specific runtime behavior, identifiers, prompts, URLs, fixtures, Wasm, or
documentation. The sender optimistic-state/identity/content-label and image-schema defects are
generic PR 2 card/interface regressions; the corresponding manifest/attester alignment is IOU-owned.
IOU #52 now covers hosted/CI automation and a green live run of the expanded full lifecycle, rather
than a missing local script. Hosted OpenChat review and CI also remain release gates.

## Historical executive result (status superseded by 2026-08-07 section above)

The findings and remediation descriptions below remain audit evidence. Their hashes, test totals,
deployment state, and readiness wording are point-in-time records unless repeated in the current
supersession section.

The complete application-owned IOU codebase and documentation were reviewed, together
with only the changes authored by `ktimam` in the two local OpenChat forks and the
related Claude chat history. Upstream OpenChat code was followed only where a
fork-authored change altered its trust boundary.

The review found critical key-lifecycle defects, authorization and storage-exhaustion
risks, browser-session data separation defects, relay and mobile trust-boundary issues,
and test gates that could report false success. Every directly remediable IOU source
finding listed below has a fix and failing-first plus adjacent regression coverage. The
reviewed IOU changes through #49 are committed and pushed on `main`; #50 and #51 remain
source candidates pending their exact commit and push. Cross-process consumer-key mutation
ordering is guarded by a canister-owned stable epoch/tombstone (#39). Issues
remain open where hosted CI, production rollout, upgrade/recovery drills, or cross-project
acceptance evidence is still required.

OpenChat must be upstreamed as exactly two independent, generic pull requests:

1. optional on-device inference and local-model management; and
2. generic in-chat cards and the interface between chats and external applications.

PR 1 is the clean generic draft [upstream PR #9132](https://github.com/open-chat-labs/open-chat/pull/9132)
at final pushed head `f43d2a2d53f2c9f8a3086104a356d4d3a315858a`.
[OpenChat #92](https://github.com/ktimam/open-chat/issues/92) is fixed and pushed. Five focused
web/model/on-device files pass **145/145**, typecheck reports **0 errors**, and exact WSL
`prod_test` completed in **10m36s**. Its emitted **7,656,521-byte** Wllama Wasm is byte-identical
to source at SHA-256
`4197ce6d3dc9240c42ee52b4197dc99638875a06b0083901f8a57767338a0cfa`, with zero
unresolved Wllama references. PR 1 deployment remains pending.

PR 2 remains the single generic stacked draft
[fork PR #73](https://github.com/ktimam/open-chat/pull/73), based on the final PR 1 head. Its final
post-rebase pushed head is `16080b0780ed97c3cd63d4187188ac04b19b3769`. Its final
exact-blob Linux `prod_test` exited **0**: Rollup completed in **11m46.9s** and the wrapper in
**716s**. The bundle emits and references a byte-identical **7,656,521-byte** Wllama Wasm at
SHA-256 `4197ce6d3dc9240c42ee52b4197dc99638875a06b0083901f8a57767338a0cfa`,
with zero unresolved Wllama references. The successful retry used the exact Git blob after an
environment-only CRLF wrapper failure and supplied mandatory `OC_WEBSITE_VERSION=1.0.0`, the
canonical CI value. Baseline unresolved `porto`/`accounts` notices and the known nonfatal
public-key CRLF warning remain out of scope. PR 2 deployment remains pending. Older PR 2 hashes and
deployed-Wasm provenance later in this dated report are
historical evidence only; they do not include the current setup-token backend.

The following local deployment paragraph describes the earlier private-card checkpoint, not the
2026-08-07 setup-token backend. Those backend paths approved for PR 2 are enabled only when the
persisted child-canister
`test_mode` flag is true (#77); production and non-test children fail closed. All four frontend
development switches are enabled. Generic issue #78's bounded bootstrap retry and #79's
structured-clone-safe private-context handoff are committed and pushed in both PR 2 source lines.
IOU issues #47 through #49 fixed three IOU-only consumer failures: IOU now verifies OpenChat's exact
domain-separated, length-prefixed confirmation-payload hash, and `SheetPage` restarts polling when
the authenticated actor becomes ready. The IOU backend also binds each new OpenChat link to the
authoritative caller-owned consumer public key and rejects stale connect continuations or later
key replacement while the binding exists. After a fresh IOU reload, the already-confirmed setup action
was imported without a new OpenChat confirmation. The final local `Rent` smoke also passed: the
card offered exactly `[None, Rent]`, selected `Rent` through the private account-local identifier,
passed edited final-payload approval, and deposited/routed the resulting draft only to House. That
draft was intentionally left `Pending` for user review; it was not imported or acknowledged.
IOU backend `lqy7q-dh777-77777-aaaaq-cai` was then upgraded in place to module
SHA-256 `bd43debf7f0864ae3a395c09ff3c0c7221ac53457db4e0518aa5aa8c9efa3119` while the
replica and all user state were preserved. The matching frontend was rebuilt and remains served at
the registered loopback card URL. Father, mother, child, and property manager each completed a
fresh claim and the OpenChat directory reports all four connected. After that migration, House
still showed the original pending `rent card smoke 0951728` draft, and a non-confirming card load
redeemed private context with options exactly `[None, Rent]`.
This local pass does not by itself make PR 2 production-ready.
IOU independently attests the exact displayed card and final confirmation payload
for OpenChat #48, and the product owner approved that narrow attestation flow plus #54's one-time
private-context capability. The private Type display is a required acceptance criterion, not
permission to republish Type metadata; it may appear only inside the authorized app iframe and
leaves it only as an opaque encrypted reference. Additional open architecture and release
findings remain tracked in GitHub.
Neither PR may include IOU-specific runtime behavior, fixtures, prompts, URLs, identifiers,
canister WASM, or documentation.

This is a source and local-verification review, not a proof that no other vulnerability
exists.

## Historical per-chat token-routing correction — earlier 2026-08-07 checkpoint

This was the authoritative correction at the time it was written. The current-state supersession at
the top of this report now overrides its PR 2 hash, deployment, live-QC, and remaining-work claims.
PR 1/local-model scope is
unchanged. PR 2 is still exactly the generic cards/external-app/chat-interface PR; the
current setup-token changes are not a third PR and contain no IOU-specific runtime behavior.

[IOU #50](https://github.com/ktimam/IOU/issues/50) records a regression introduced when
`/openchat/link-chat?chat=...` was removed to close a raw chat-coordinate URL leak: the raw
route correctly stayed retired, but its only first-use routing UI was removed with it. The
manifest also stopped publishing a `chat_link` surface. A user could therefore connect the
app but could not discover a safe page for assigning the current chat to an IOU account/sheet.
The earlier live journey pre-seeded the chat mapping and exercised only **Check connection**,
so it never tested an unmapped chat opened through OpenChat. That was the QC gap; the previous
coverage claim was too broad.

The failing-first IOU regression was concrete: `actionManifest.test.ts` ran **22 tests with
1 failure** because the `chat_link` surface was absent. The first static raw-free remediation was
still insufficient because every chat opened the same default-browser page. The revised generic
surface is `/settings#openchat-routing/{chatLinkToken}`. Each invocation from the individual
chat's settings page creates a different canonical 43-character unpadded base64url encoding of a
one-time 32-byte token.

[IOU #51](https://github.com/ktimam/IOU/issues/51) found that the component-level scrub still ran
after asynchronous authentication initialization, leaving the bearer in browser history longer
than the security contract allowed. Its failing-first regression was **1/1 red**. The fix moves
capture and scrub into the synchronous main entry point, then dynamically bootstraps the
authentication/application modules; the exact token remains only in the current page instance's
module memory. The focused correction passes **5/5**, and IOU typecheck plus production build are
green. The final source gate now also passes Cargo **68/68**, frontend **846/846 across 71 files**,
and routing Playwright **5/5** using the installed system Chrome. The first Playwright invocation
failed only because its bundled browser binary was absent; the supported
`PLAYWRIGHT_EXECUTABLE_PATH` rerun passed with no code failure. The exact candidate hash,
push, and deployment remain pending.

The signed-in IOU backend redeems that token through its pinned UserIndex with the caller's exact
app subject. A successful grant must match the subject and subject version, the exact
`app_user_key_version` stored in the IOU binding, app id, manifest revision, app canister,
and v1 chat-handle version. IOU rechecks its pin, complete binding, key trust, and sheet access
after the cross-canister await. OpenChat retains only a digest-bound successful-redemption receipt
for one hour, scoped to the exact caller and subject, so an ambiguous response can be retried with
the same token without minting a second route. IOU uses a 30-second bounded wait for that call.

Only a successful setup-token redemption writes a pending row with `claim_version = 1`.
Historical rows created by card attestation/private-context activity decode with no claim version
and are deliberately hidden by `pending_chat_routes` and rejected by assignment, unlink, and
dismiss operations. Merely viewing or proposing a card is not consent to route a private sheet.
Every authenticated token has an independent caller-scoped opaque pending id, so different chats
can route to different active sheets without a newest-only race. Rows expire after 24 hours, are
bounded per principal and globally, are cleared by disconnect/rebinding or trust changes, and never
expose the app-scoped chat handle.

The production routing component coalesces React StrictMode/remount duplication into one in-flight
claim. A wrong-account result does not consume the token, and an ambiguous `RemoteError` leaves
the exact in-memory token available to **Refresh**. A successful retry reloads and focuses the exact
returned row before clearing the token. Unmount cleanup does not cancel or burn it. The checked-in
`src/iou_backend.did` now publishes `claim_openchat_chat_route`, and the repository-policy
regression compares that service surface with the Rust export and TypeScript declaration so a
shadow/stale DID cannot silently omit the method again.

OpenChat issues #81 through #86 record the authorization, lifecycle, diagnostic, pre-consent,
async-snapshot, and navigation-binding defects found in the setup-token revision. The exact pushed
PR 2 commit closes each source defect. Group minting requires a current joined member and
repeats that check after awaits.
Community-channel minting requires a current community member plus the target channel's visibility/
membership authorization, including exact private-channel membership; invited-but-not-joined,
suspended, and lapsed users fail closed even if they know the group or channel id. Here
\"verified member\" means present and not suspended/lapsed, not KYC or identity verification.
Admission limits run before consuming the one-time GroupIndex authority and again before insertion.
If a child or LocalUserIndex post-await revalidation fails after issuance, an exact issuer/user/
chat/app/revision/token cancellation is attempted; cleanup failure never exposes the bearer, which
still expires under its existing ten-minute TTL. The affected Group, Community, User,
LocalUserIndex, UserIndex token-model, architecture, and Candid-golden backend gates plus focused
format/check are green. Exact recorded backend results are UserIndex **253/253** plus token model
**11/11**, LocalUserIndex **35/35**, Community **15/15**, Group **11/11**, User **19/19**,
architecture **10/10**, and Candid golden **1/1**. The latest narrower admission/cancellation
rerun is common admission **4/4**, GroupIndex cancellation **2/2**, Group **3/3**, and Community
**3/3**; no aggregate GroupIndex count is claimed. The exact head is pushed; deployment remains
pending. Its final exact-blob Linux `prod_test` exited **0** (Rollup **11m46.9s**, wrapper
**716s**) and emitted and referenced the byte-identical **7,656,521-byte** Wllama Wasm at SHA-256
`4197ce6d3dc9240c42ee52b4197dc99638875a06b0083901f8a57767338a0cfa`, with zero
unresolved Wllama references. The environment-only retry used the exact Git blob plus canonical CI
`OC_WEBSITE_VERSION=1.0.0`; baseline `porto`/`accounts` notices and the known nonfatal
public-key CRLF warning remain out of scope.

The local-only preserved Windows Father handoff was proved without claiming token redemption. The
actual current-chat settings chain **Open setup** → **Open in browser** opened a distinct
Father-profile window, scrubbed the opaque fragment, reached the exact
`/settings#openchat-routing` route signed in, and left the default browser unchanged. The
temporary profile override remains debug-only and excluded from PR 2. This is neither PR 2 nor
deployment evidence and does **not** prove backend redemption or sheet assignment.

[OpenChat #91](https://github.com/ktimam/open-chat/issues/91) records the separate generic desktop
bridge gap, which is fixed and committed in exact pushed PR 2 head
`16080b0780ed97c3cd63d4187188ac04b19b3769`: desktop
`open_url` now delegates the exact URL to the operating-system opener instead of being
unimplemented. Its failing compile evidence was Rust `E0425`; before the rebase the focused bridge
tests passed **2/2**, the full plugin suite passed **17/17**, and formatting/diff checks passed.
Exact post-rebase tree equivalence preserves that evidence. The change touches only `Cargo.lock`,
`frontend/tauri-plugin-oc/Cargo.toml`, and `frontend/tauri-plugin-oc/src/desktop.rs`, and
contains no Father/profile override. Deployment and live acceptance remain pending.

[OpenChat #80](https://github.com/ktimam/open-chat/issues/80) is the separate generic PR 2
consent-lifecycle defect. Closing or backing out of the link-consent sheet called the installed-
key removal path, so a normal dismissal disconnected an already connected external app and the
next proposal asked the user to connect again. Its failing-first frontend regression was **3/3
failed**: no exact pending-token cancellation was sent and the installed key was removed. The
generic PR 2 candidate exposes caller-bound, exact-token, idempotent cancellation for an unclaimed
link code; the desktop/mobile consent UI best-effort cancels only that returned token and always
dismisses, while explicit **Disconnect** remains the sole installed-key removal action. This is
reusable external-app/card interface code. It does not change inherited OpenChat features, contain
IOU-specific behavior, or belong to the local-model PR.

Final IOU source verification after #51 is green: Cargo **68/68**, full frontend **846/846 across
71 files**, TypeScript typecheck, production Vite build, and the full routing Playwright file
**5/5** using the installed system Chrome. The first Playwright invocation failed only because the
bundled browser binary was absent; rerunning through the supported `PLAYWRIGHT_EXECUTABLE_PATH`
passed **5/5**, so no code failure is attributed to that environment miss. The browser file includes
the production StrictMode single-flight, ambiguous-result exact-token retry, two independent routes,
exact scrub/focus, and live caller-isolation cases. #51's narrower regression is **5/5**. The exact
IOU candidate hash, push, and deployment remain pending.

At exact pushed post-rebase PR 2 head
`16080b0780ed97c3cd63d4187188ac04b19b3769`, the full frontend suite passes **958/958**,
Svelte typecheck reports **0 errors and 565 warnings**, and the agent typecheck is green. This
includes #90's root-command source-inspection correction (targeted proof **44/44**) and #89's
removal of stale flattened-package imports. #83's sensitive-transport regression passes **3/3**,
#84's mounted redaction/sink regression **3/3**, #85's full surface resolver file **32/32**, and
#86's canonical pending-chat state regression **3/3**. The post-rebase backend tree is exact to the
previously green backend tree and therefore retains the recorded backend evidence above. The final
exact-blob Linux `prod_test` exited **0**: Rollup completed in **11m46.9s**, the wrapper in
**716s**, and the bundle emitted and referenced a source-identical **7,656,521-byte** Wllama Wasm
at SHA-256 `4197ce6d3dc9240c42ee52b4197dc99638875a06b0083901f8a57767338a0cfa`
with zero unresolved Wllama references. The environment-only retry used the exact Git blob and
canonical CI `OC_WEBSITE_VERSION=1.0.0`; inherited unresolved `porto`/`accounts` notices and
the known nonfatal public-key CRLF warning remain out of scope. PR 2 deployment remains pending.

PR 1 final pushed head `f43d2a2d53f2c9f8a3086104a356d4d3a315858a` fixes #92. Five
focused web/model/on-device files pass **145/145**, typecheck reports **0 errors**, and exact WSL
`prod_test` completed in **10m36s** with a byte-identical **7,656,521-byte** Wllama Wasm at
SHA-256 `4197ce6d3dc9240c42ee52b4197dc99638875a06b0083901f8a57767338a0cfa`
and zero unresolved Wllama references. PR 1 deployment remains pending.

Issue #87 remains an inherited, separate maintenance baseline rather than either feature PR's
debt: a clean production install reports one high and one moderate advisory, with
`@coinbase/cdp-sdk@1.52.0` pinning vulnerable `axios@1.16.0`, while
`@base-org/account@2.4.0` is invalid against `@wagmi/connectors@8.0.22`'s `^2.5.1` request. No
dependency override or wallet behavior change belongs in PR 1 or PR 2; remediation and wallet
reachability tests require a separate upstream-maintenance PR.

The token-enabled OpenChat producer and matching IOU consumer backend have not yet been deployed
to the preserved replica. The older local private-Type/card smoke and the Father handoff proof are
useful evidence, but neither proves setup-token redemption, sheet assignment, or the complete
two-chat/two-sheet journey.

## Historical readiness and preserved local deployment snapshot — 2026-08-06

This section records the state before the 2026-08-07 setup-token revision. The current section
above supersedes its PR 2 head, routing, test-count, and deployment-readiness statements. Its
preserved-state, lifecycle, private-card, and historical artifact evidence remains valid. The
security boundary was and remains exactly two generic OpenChat pull requests:

1. **PR 1 — local models:** optional on-device inference and reusable local-model
   management only. The upstream draft is
   [open-chat-labs/open-chat#9132](https://github.com/open-chat-labs/open-chat/pull/9132)
   at `f7825b347b5f8449053778450b934110e0ee3537`; this continuation did not modify it.
2. **PR 2 — cards and external-app/chat interfaces:** generic in-chat cards, private
   context, app-scoped linking, authenticated delivery, inbox lifecycle, signing-key
   lifecycle, and the reusable interface between chats and external applications. The
   clean fork draft is [ktimam/open-chat#73](https://github.com/ktimam/open-chat/pull/73)
   at `68aadfd35d93b3bbb25d352edb81c83790160c0c`. It contains no IOU-specific runtime
   behavior, identifiers, prompts, URLs, fixtures, Wasm, or documentation.

The dependency-compatible preserved-replica source checkpoint is
`790bb76d00240ca5a8a4c124db4535dd7795f96b` on
`origin/codex/review-checkpoint-pr2`. It differs from the clean submission only where the
older deployment dependency set requires legacy task spawning; the clean PR uses
`ic_cdk::futures::spawn_migratory` in both entropy initialization and durable outbox work.
The equivalent generic late fixes are clean `f93bffe0a` / checkpoint `4eed022b8` for #78
and clean `68aadfd35` / checkpoint `790bb76d0` for #79. They are frontend-only. The deployed
Group and Community `0.0.2` Wasms therefore correctly retain provenance `8ae34cf38`, while
the deployed index Wasms retain provenance `7c997f4b1`; neither artifact class claims the
later source head.
All untracked OpenChat helpers, generated artifacts, and the two-PR promotion plan are
inventoried in [ktimam/open-chat#3](https://github.com/ktimam/open-chat/issues/3). They are
deliberately not committed. Issue #3 remains open as the release inventory. The completed
lifecycle and harness findings #51, #72, #74, #75, and #76 have final evidence comments and
were closed on 2026-08-06.

### Lifecycle and rollback result

The former PR 2 lifecycle blocker is resolved at the architecture level, in generic
OpenChat card/model-adjacent infrastructure rather than original OpenChat behavior.
`UserIndex`, `LocalUserIndex`, and `GroupIndex` now persist a
`LifecycleId { generation, version_salt }`. The canister version is sampled only at
initialization and post-upgrade. The lifecycle id, rather than a live version value that
can drift during snapshot recovery, binds entropy readiness, tickets, watchdogs, KDFs,
delivery authorities, and route/provenance authorities. Advancing the lifecycle clears
short-lived UserIndex link bearers and GroupIndex authorities, while intentionally
preserving the action-signing keyring, per-user delivery keys, and durable outbox.

Snapshot recovery is now fail-closed and operationally explicit: **stop → load snapshot →
upgrade the same Wasm while still stopped → start**. A bare snapshot load is not treated as
a complete recovery. The old live failure was not a failed `raw_rand` call: entropy had
arrived, but comparing against a live `canister_version` invalidated it after the recovery
transition. The corrected lifecycle and test harness resolve that diagnosis.

### Verification evidence

The recorded focused source and exact-artifact gates passed:

- lifecycle state-machine suite: **23/23**;
- clean affected OpenChat package suites: **276 tests**;
- dependency-compatible checkpoint affected package suites: **268 tests**;
- neutral verifier: **4/4**;
- clean `cargo test -p integration_tests --no-run`: passed;
- checkpoint integration modules: fan-out **6/6**, routing **3/3**,
  link/lifecycle **9/9**, revoke/throttle **6/6**, inbox lifecycle **5/5**,
  per-user isolation **1/1**, and two-phase idempotency **3/3**;
- the separate 3,200-ingress capacity stress is explicitly ignored in the routine suite;
  the bounded count/byte admission behavior is covered by adjacent tests;
- exact `7c997f4b1` Wasm tests passed:
  `restored_user_index_snapshot_never_reissues_a_link_bearer`,
  `restored_pending_entropy_timer_is_recreated_by_the_recovery_upgrade`, and
  `confirm_uses_manifest_inbox_and_confirmer_key_not_card_routing`.
- issue #77's persisted-`test_mode` backend gate passed **89/89** focused tests in each
  worktree: chat events **67/67**, Group **9/9**, and Community **13/13**. Focused
  formatting and compilation checks also passed in both the clean PR and checkpoint.
- the final focused PR 2 card-bridge rerun at clean head `68aadfd35` passed **68/68**;
- IOU #47's ActionInbox cryptography and polling suites passed **42/42**, including the
  hard-coded OpenChat/Rust confirmation-payload hash vector and rejection of the former
  self-consistent raw-SHA fixture contract;
- the IOU repository-policy suite passed **12/12**, including #48's explicit authenticated-
  actor polling dependency and the #45/#46 card-asset/configuration guards;
- IOU #49 passed the independent Rust suite **53/53**, the focused consumer-key/Candid suites
  **17/17**, and both TypeScript typechecks. The final exact-head frontend coverage run passed
  **68 files / 830 tests** at **87.11% statements/lines**, **85.96% branches**, and
  **90.75% functions**;
- after those IOU-only fixes, a fresh IOU reload imported the already-stored setup action
  without a second OpenChat confirmation;
- the final local `Rent` smoke passed with options exactly `[None, Rent]`, private account-local
  `Rent` selection, edited final-payload approval, and deposit/routing only to House. The draft
  remains intentionally `Pending` for user review, so this evidence does not claim import or
  acknowledgement of that draft;
- the #49 IOU backend was upgraded in place to module hash
  `bd43debf7f0864ae3a395c09ff3c0c7221ac53457db4e0518aa5aa8c9efa3119`.
  Configuration and app registration survived, all four account bindings were relinked and report
  connected, the pending Rent draft survived, and a post-upgrade private-context redemption again
  returned exactly `[None, Rent]` without confirming another action.

Do not count the current whole-workspace `svelte-check` as a green or authoritative gate. Its
environment is mislinked to the deployment repository and fails on missing `marked` and
`svelte-easy-crop` dependencies plus inherited `VideoCallsReleased` parser errors. The focused
**68/68** clean-head rerun is the applicable latest PR 2 frontend evidence.

The index Wasm SHA-256 values used for the preserved deployment are below. These exact
index artifacts were built from `7c997f4b1ef10f8217d526e82f8016b7e05d0486`; the index
canisters were not subsequently upgraded to `8ae34cf38`.

| Canister | SHA-256 |
|---|---|
| UserIndex | `ed4adbf8dab4dd919b9bcf1f941c9ce02de0521e34b0c3fbdd437d87604be870` |
| LocalUserIndex | `f277a4f767d4dd0f03e8d4c3d08969b6be909fe44533f9ad1a8fb47564bec5aa` |
| GroupIndex | `26624f9ca927a89593fb6c3eb2f2a3b1bb5258b08b409159028cf598f02e6b2e` |
| neutral verifier | `108d5afc27c236c5cc9f947069022a41a9b313ec4c30f22ea6925fbf1c90c31f` |

Group and Community child Wasms were built from the newer checkpoint
`8ae34cf38cb633abc4d1143ba3e1b7feef9a793a` and published through GroupIndex as
version `0.0.2`:

| Child Wasm | Compressed SHA-256 | Module SHA-256 |
|---|---|---|
| Group | `9388c354dd02ade409fa17d4dfff816a08819551bb03d39e10d798b18dde6967` | `00edafdd7339377252381dcbb55693d43a523fe9a4ef1eca33de532e0fe8c618` |
| Community | `d8a27022f6363c4e26704cfae8ca2826293928f51cb0ed4d19e340ef8486292c` | `6c85c3c99f7655852a9a437c53c865d639e0b884bf63a2c80155db7a08b71451` |

### Preserved local environment

The existing replica was upgraded in place—never cleaned, reinstalled, or recreated. The
controller chain was verified before mutation. UserIndex
`vg3po-ix777-77774-qaafa-cai` is at `0.0.5`, LocalUserIndex
`xad5d-bh777-77774-qaaia-cai` is at `0.0.3`, and GroupIndex
`uxrrr-q7777-77774-qaaaq-cai` is at `0.0.3`; their installed module hashes match the table
above and all report embedded git SHA `7c997f4b1ef10f8217d526e82f8016b7e05d0486`.
Post-upgrade metrics report zero upgrade failures, six global users, four local users, and
the published IOU app registration (app id `1`, revision `1785968455520`, app canister
`lqy7q-dh777-77777-aaaaq-cai`, inbox `ll5dv-z7777-77777-aaaca-cai`) intact.
The IOU backend itself was subsequently upgraded explicitly by canister id, not through IOU's
stale historical `.dfx/local` name, to module hash
`bd43debf7f0864ae3a395c09ff3c0c7221ac53457db4e0518aa5aa8c9efa3119`. Its controller and
configuration were verified before and after. The frontend production build passed and the matching
Vite source remains live on the registered loopback URL. All four legacy bindings were relinked;
the directory shows `Disconnect`/`Reconnect` for father, mother, child, and property manager.

Group and Community `0.0.2` are both registered with no pending, in-progress, or failed
rollouts. The private group `weosr-yh777-77774-qaaoa-cai` (`IOU local 094847`) runs Group
`0.0.2`; father, mother, child, and property manager are all members, the property manager
is owner, and IOU app id `1` is enabled. All four users are independently paired to app id
`1`; each profile shows `iou` as connected. This child deployment is where persisted
`state.data.test_mode = true` authorizes the generic private-context and final-confirmation
paths. A production/non-test child remains fail-closed even if a frontend flag is set.

The dedicated `action_inbox_deposit` v4 signing key
`8101944ff165ad36af3b6ed50f34c570154bb7d80c1fd6994206a0cb0984805c`
was staged, pinned in the ignored local IOU environment, activated through the local
governance identity, and verified `Active`. All four PR 2 local switches are enabled in the
served OpenChat build. IOU is listening on `127.0.0.1:3000`, OpenChat on
`127.0.0.1:5003`, and the father, mother, child, and property-manager profiles remain signed
in in separate browser profiles. Each IOU identity can still query its private backend
state. These development identities and local keys remain reproducible across intentional
fresh runs; normal restarts use the preserved path below so they are not needlessly
recreated.

### Type privacy (#13)

The original cross-account Type disclosure remains resolved. Type ids, names, keywords,
and account-specific Type values are not published in the public OpenChat app manifest or
generic chat state. Live IOU account checks show `Rent` only on the House account: father
sees `Rent`, and property manager sees `Rent · partner`. Father and mother see no Type on
their separate FatherMother account; father and child see no Type on FatherChild. A temporary
test Type was removed and stayed absent while `Rent` remained. These checks prove the IOU
account boundary independently of the card bridge.

The approved card requirement is narrower and implemented: after authorization and explicit
card loading, the IOU card may receive a nonce-bound, single-use encrypted private context and
display that user's Type inside the card. OpenChat transports generic opaque context and has no
IOU-specific Type knowledge. Public users, other accounts, unopened cards, and generic app
discovery do not receive the value. Source, unit, tamper, exact-Wasm, and account-boundary tests
pass. The pre-existing setup action was imported after a fresh IOU reload, proving the corrected
payload-hash and actor-readiness consumer path for that action. The separate live `Rent` smoke
passed through private selection, edited approval, and House-only deposit. The resulting draft is
intentionally still `Pending` for user review, so no import or acknowledgement is claimed for it.

### Late live findings and fixes: IOU #45–#49 and generic PR 2 #78/#79

- **IOU #45:** OpenChat intentionally embeds the card as `sandbox="allow-scripts"` plus
  `credentialless`, giving it opaque origin `null`. Without CORS response headers the public
  Vite/production modules are blocked and the otherwise loaded card cannot handshake. The IOU-only
  fix adds wildcard ACAO for public frontend assets while retaining the narrow
  `frame-ancestors` allowlist and credentialless sandbox. Repository-policy regression coverage
  checks both Vite and both asset-canister header rules.
- **IOU #46:** an ignored emitted `vite.config.js` shadowed tracked `vite.config.ts`, so the
  running server silently used stale security headers. The stale local file was removed and an
  IOU repository-policy regression now fails whenever that shadow file exists.
- **IOU #47:** OpenChat correctly signs
  `SHA-256(openchat.ai-app-card-confirm-payload.v1\0 || u32_be(length) || payload)`.
  IOU incorrectly checked raw `SHA-256(payload)`, and its local producer fixture repeated the
  same mistake. The IOU-only fix implements the exact versioned contract in both polling and the
  test producer. No OpenChat source or canister change is required.
- **IOU #48:** `SheetPage` could mount while its authenticated backend actor was still undefined.
  Because the polling effect omitted `actor` from its dependency list, later actor readiness did
  not start polling. The IOU-only fix makes actor readiness an explicit lifecycle dependency and
  preserves cancellation/interval/ack-queue cleanup.
- **IOU #49:** `connect_openchat` accepted a browser-supplied delivery PEM without proving it was
  the caller's authoritative canister-backed consumer key, did not recheck the key epoch after its
  UserIndex await, and `set_consumer_keypair` could replace the key while an OpenChat binding
  remained. IOU now checks exact PEM plus epoch before and after the claim, persists the link-time
  PEM in the caller-private stable binding (schema v16), and permits only a same-PEM wrapped-key refresh while
  linked. A different or missing key returns the dedicated
  `OpenChatBindingKeyMismatch` error. Pre-upgrade bindings decode safely but have no persisted
  key pin; they remain visible to their owner for coordinated recovery and fail closed for
  card/attestation authorization or key replacement until disconnected and relinked. Raw
  `delete_consumer_keypair` remains an explicit availability escape hatch: it advances the
  tombstone epoch and removes the IOU binding as well as the wrapped key, although it cannot revoke
  an already-stored remote OpenChat key. This is entirely an IOU fix; no OpenChat source or canister
  change is required.
- **OpenChat #78:** the generic host sent `oc:card:bootstrap` only once from iframe `load`.
  Framework mounting could install the app listener afterward, leaving a rendered but permanently
  uninitialized card. The PR 2 fix retries only the same nonce-bound bootstrap during
  the bounded handshake and cancels on ready, frame reset, timeout, or teardown. Focused late-listener,
  cleanup, and stale-session tests are included in clean `f93bffe0a` and checkpoint `4eed022b8`.
- **OpenChat #79:** Svelte deep-proxied the returned private-context capability, and passing that
  proxy to `postMessage` raised `DataCloneError`. The generic bridge now copies nested initialization
  data into structured-clone-safe values before crossing the iframe boundary, in clean
  `68aadfd35` and checkpoint `790bb76d0`.

The IOU ActionInbox crypto/poll suites are **42/42** and repository-policy tests are **12/12**.
For #49, Rust is **53/53**, the focused frontend/Candid regressions are **17/17**, TypeScript
typecheck passes, and the final exact-head frontend coverage run is **68 files / 830 tests**
(**87.11% statements/lines**, **85.96% branches**, **90.75% functions**).
After a fresh reload, the existing setup action was imported without reconfirmation. The separate
live `Rent` smoke passed with exactly `[None, Rent]`, private account-local selection, edited
final-payload approval, and House-only deposit; the draft was deliberately left `Pending` for
user review and was not imported or acknowledged.

### Remaining release work

The preserved environment is ready for continued interactive evaluation, but PR 2 is not a
production-ready claim. The IOU-only #45–#49 fixes are committed and pushed, the #49 backend is
upgraded locally, the matching frontend is rebuilt/live, and all four pre-#49 bindings are relinked.
The pending `Rent` draft remains available for user review before any import/exact acknowledgement.
Keep the OpenChat source/artifact provenance split explicit: the local smoke passed against the
pushed #77/#78/#79 source heads, while the deployed index and child Wasms retain their documented
older build provenance. No OpenChat canister upgrade was required for #49.

Remaining work is hosted Linux CI for the exact clean PR heads, review/merge of the two drafts in order,
run the deliberately slow capacity stress in its CI lane, and perform a production key
ceremony/rollout using production pins. No production deployment was performed by this review.

## Continuation update — 2026-08-05

This section supersedes older v3, single-key, uncertified-read, cursor, test-count, and
PR2-blocker wording later in the dated report where the two conflict.

The approved scope remains exactly two generic OpenChat pull requests. PR 1 contains only
on-device/local-model work; this late PR 2 continuation did not change that code, and PR 1's separate
#71 cache remediation is reported below. PR 2 contains generic
in-chat cards and reusable external-application/chat interfaces; it contains no IOU-specific
runtime behavior. The only changes made in OpenChat during this continuation belong to PR 2:
route authority, confirmer-bound delivery, the dedicated action-signing keyring, ActionInbox
storage/read/acknowledgement, and app/capability lifecycle.

The private-Type leak in IOU issue #13 remains resolved: type ids, names, and keywords are absent
from public manifests and generic OpenChat state. The approved visibility requirement is separately
implemented: the authorized, explicitly loaded IOU card can receive an encrypted one-time private
context and display the linked account's Type. At the 2026-08-05 checkpoint every OpenChat
activation switch was still false. The current 2026-08-06 state is different: all four local
frontend switches are on, while the backend authorizes the new paths only from persisted child
`test_mode`; production/non-test children still fail closed.

The current PR2 source contract is v4:

- GroupIndex issues a short-lived one-use authority bound to the exact group/channel, child
  canister, message/thread, confirmer, app/revision/action, card and payload commitments, lease
  generation, and timestamp. UserIndex revalidates and consumes that authority before delivery;
  direct-chat delivery remains unsupported and fails closed.
- LocalUserIndex creates the recipient ECIES envelope; authoritative UserIndex re-derives the
  current app route and recipient binding, then signs the complete outer record with a dedicated
  purpose-scoped P-256 key. The legacy OpenChat key is not reused.
- UserIndex holds at most three `Staged`, `Active`, or `VerifyOnly` action keys. Rotation requires
  separate governance stage and activate operations; the old private DER is removed from the
  logical serialized keyring at activation and its public key remains verify-only for the 30-day
  overlap. Physical zeroization of heap copies and stale upgrade-memory bytes is not yet proven.
- Remote IOU builds require one to three independently provisioned key-id pins and HTTPS. The
  `action_signing_keys` query is discovery/health metadata, not the remote trust root. Exact
  loopback development alone may trust the recreated local UserIndex keyring without pins so the
  father, mother, child, and property-manager browser accounts remain reproducible across runs.
- `actions` is a replicated update. IOU always reads from `since_id = 0`, verifies the v4 outer
  signature before decryption, recomputes all inner commitments, deduplicates by the signed
  full-width delivery identity, and treats the numeric id only as the exact locator paired with
  that action's secret. Acknowledgement deletes at most that one handled action.
- IOU enforces the key creation boundary and, for `VerifyOnly`, requires signed `created_at` to be
  no later than `verify_until`; expiry at the current time makes the key unusable. Independent Rust hash/signature
  goldens and adjacent tamper, replay, route-change, cache-race, rotation, and cutoff cases pass.

Issue #58's source-level correlation boundary is now implemented. Pairing claim and selector lookup
are app-authenticated C2C operations; the public browser claim fails closed. UserIndex derives a
per-app subject and queue selector with a secret HMAC domain, so neither a public key nor a raw
OpenChat user id is a cross-app correlator. OpenChat exposes only app-scoped opaque chat/message
handles to external cards. IOU accepts only canonical 32-byte base64url handles, ignores legacy raw
mapping rows, and removes the old `/openchat/link-chat?chat=...` public URL surface. Raw coordinates
remain in tests only as rejection cases. The GitHub issue remains open until Linux PocketIC and a
disposable live upgrade prove the compiled contract at runtime.

Issues #49 and #69 now have a source-level durable delivery boundary. UserIndex persists the exact
semantic request and authoritative destination before awaiting an app-associated ActionInbox, admits
only one live dispatch for that attempt, reuses the exact encoded bytes for retries, and rejects a
different actor, payload, route, or app revision. Calls have a ten-second timeout, bounded leases and
per-app/global count-and-byte caps; late success and the 30-day retry cutoff converge without opening a
second semantic delivery. The source state machine and adjacent timeout/retry/cap tests pass, but an
actual stopped-inbox restart/upgrade drill remains a release gate.

Issue #51's 2026-08-05 source gate used a live canister-version comparison around a
purpose-separated entropy root. That checkpoint failed PocketIC acceptance: the keyring remained
`NotInitialised`, the snapshot drills used the wrong UserIndex controller, and their tick loop did
not advance the watchdog clock. Those historical failures produced #72, #74, #75, and #76. The
current implementation replaces that unstable comparison with persisted
`LifecycleId { generation, version_salt }`, uses migratory tasks where supported, and passes the
corrected lifecycle and exact-Wasm gates. Those four issues and #51 are closed; the current recovery
procedure and remaining production-like drills are recorded in the top handoff.

This continuation also found an upgrade-compatibility release gate during the final audit:
the exact committed pre-PR2 heap schema is now decoded, empty state upgrades while preserving
`next_id`, and non-empty actions/replay state traps with an explicit migration-required error
instead of being dropped or fabricated. Those records lack the fields needed to construct valid v4
records, so deployment requires a reviewed export/reinstall decision rather than a guessed
conversion. Older stable records now default a missing additive acknowledgement hash to empty and
remain readable but cannot authorize deletion or pass current v4 verification. The source outbox,
reseed and correlation mechanisms were implemented, but the missing real
confirmation→deposit→replicated-read→IOU import→exact-ack, snapshot-load, stopped-canister, and
upgrade runtime chains kept PR 2 and every feature switch blocked at that dated checkpoint.

That statement described the 2026-08-05 checkpoint. The preserved local deployment was
subsequently upgraded as recorded in the 2026-08-06 snapshot below. It is useful local
state-preserving upgrade evidence, but it does not replace Linux PocketIC, hosted CI, or a
disposable production-like rollout.

## Historical implementation and local deployment snapshot — 2026-08-06

This section supersedes older statements elsewhere in this dated report that describe the
IOU fixes as uncommitted, the OpenChat PRs as unreconstructed, or the backend as not deployed.

### Committed branches and exact PR boundary

- The prior reviewed IOU baseline is pushed through `e1ba688`. The security/integration fix is
  `db7db41`; exact
  compressed ActionInbox WASM hash verification is `b110060faad76e53d004ee9823b6865f95d21184`;
  rejection of unsupported manifest regex `pattern` fields is
  `271c00f8b3eefb80a911c506bdc3e9ed155c616f`; and the v2 browser-card coverage repair is
  `1457aa1`.
- PR 1 is the clean generic branch `codex/pr1-local-models`, commit
  `f7825b347b5f8449053778450b934110e0ee3537`, based on upstream `3c49a7302` and pushed.
  It is open as draft [upstream PR #9132](https://github.com/open-chat-labs/open-chat/pull/9132).
  Its preservation checkpoint is `codex/review-checkpoint-pr1` at `2222706e2`. It contains
  only reusable local/on-device model functionality.
- PR 2 is the clean branch `codex/pr2-app-chat-interfaces`, currently
  `68aadfd35d93b3bbb25d352edb81c83790160c0c`, stacked on the exact PR 1 head and open as
  draft [fork PR #73](https://github.com/ktimam/open-chat/pull/73). It is the only PR for
  generic in-chat cards and external-app/chat interfaces; it contains no IOU product
  behavior and no local-model implementation delta. The pushed non-submission preservation/
  deployment branch `codex/review-checkpoint-pr2` is
  `790bb76d00240ca5a8a4c124db4535dd7795f96b`. Both heads contain the resolved persisted
  lifecycle and #77's persisted-`test_mode` backend gate, #78's bounded bootstrap retry, and
  #79's structured-clone-safe private-context bridge. The deployed indexes remain from
  `7c997f4b1`, and the deployed Group/Community child Wasms remain from `8ae34cf38`; #78/#79
  are frontend-only and did not rebuild those artifacts.

### Current verification evidence

- The latest IOU unit run passed **824/824**; `pnpm typecheck` passed; the focused affected
  unit set passed **34/34**.
- The repaired Playwright card suite passed **18/18**, including **10/10** focused v2 and
  D8 security cases. It now uses the host-first v2 bootstrap, a valid 32-byte frame nonce,
  and required app context. Version 1, missing/wrong nonces, and a rotated-nonce replay all
  fail closed. The configuration can opt into an already installed browser using
  `PLAYWRIGHT_EXECUTABLE_PATH`, avoiding an unnecessary browser download.
- PR 1's clean candidate passed **178 frontend tests**, zero TypeScript errors, **15/15**
  native tests and **16/16** catalog tests. Registry, integration and shipping feature
  builds compile, and its security, secret, license and formatting audits pass.
- PR 2's clean branch passed the focused entropy set **21/21**, the relevant shared-types/
  UserIndex/LocalUserIndex/GroupIndex suites **318/318**, and three `wasm32` checks. The
  dependency-compatible checkpoint passed the same focused set **21/21**, its corresponding
  suites **309/309**, and three `wasm32` checks. Later lifecycle verification passed **23/23**,
  and #77's backend activation gate passed **89/89** in each worktree with focused format/check.
  The local-only frontend gate passed
  **22/22** focused security tests, TypeScript validation, and targeted Svelte validation
  with zero errors or warnings. This was a targeted gate, not a whole-workspace result. The
  current whole-workspace `svelte-check` is non-authoritative/non-green because dependencies are
  mislinked, `marked` and `svelte-easy-crop` are missing, and inherited `VideoCallsReleased`
  parser failures remain; none is attributed to these fork changes.
- The later IOU #47 crypto/poll suites pass **42/42**, and the repository-policy suite covering
  #45/#46/#48 passes **12/12**. A fresh IOU reload imported the already-stored setup action. The
  separate local `Rent` smoke passed through edited approval and House-only deposit; its draft
  intentionally remains `Pending` for user review and is not claimed as imported or acknowledged.

### Preserved local canister deployment and registration

The local ICP replica and the father, mother, child, and property-manager browser/account
state were preserved; no clean replica start or reinstall was used. State-preserving upgrades
deployed the reviewed checkpoint as follows:

- UserIndex `vg3po-ix777-77774-qaafa-cai` is version `0.0.5`; its deployed compressed-module
  SHA-256 is `ed4adbf8dab4dd919b9bcf1f941c9ce02de0521e34b0c3fbdd437d87604be870`.
- LocalUserIndex `xad5d-bh777-77774-qaaia-cai` is version `0.0.3`; its deployed
  compressed-module SHA-256 is
  `f277a4f767d4dd0f03e8d4c3d08969b6be909fe44533f9ad1a8fb47564bec5aa`, and it remains
  bound to ActionInbox.
- GroupIndex `uxrrr-q7777-77774-qaaaq-cai` is version `0.0.3`; its deployed compressed-module
  SHA-256 is `26624f9ca927a89593fb6c3eb2f2a3b1bb5258b08b409159028cf598f02e6b2e`.
- Those three index Wasms report embedded git SHA
  `7c997f4b1ef10f8217d526e82f8016b7e05d0486`; do not attribute them to the newer
  `8ae34cf38` checkpoint used for the child Wasms.
- UserIndex still reports six created users; LocalUserIndex still reports four local and six
  global users. The four existing User canisters remain on User WASM `0.0.1`. There are no
  pending, in-progress, or failed upgrades.
- Group and Community child Wasms from `8ae34cf38` are published/active at `0.0.2` with zero
  rollout failures. Private group `weosr-yh777-77774-qaaoa-cai` runs Group `0.0.2`, has the four
  named users as members, and has IOU app id `1` enabled. All four users are paired to that app.
- ActionInbox `ll5dv-z7777-77777-aaaca-cai` was upgraded in place to `1.0.1` from
  `e570a28b6`. Its state was empty at upgrade verification; migration is complete, the deployed
  compressed module hash matches the exact IOU-pinned artifact, app id 1 is registered, and only UserIndex may
  deposit. Its preserved local `cycles_dispenser` value still points at LocalUserIndex;
  because there is no non-destructive setter, this is a documented local-only caveat, not a
  production configuration claim. It later stored the confirmed setup action that IOU #47/#48
  made visible after a fresh reload.
- IOU backend `lqy7q-dh777-77777-aaaaq-cai` was upgraded in place. Its WASM SHA-256 is
  `4fdee82d5e12e73eca6e5470a9f7d9ceedb5c7b5c96ea34e6b5fd61ebff9bf66`, and its stable
  owner and deployment timestamp survived the upgrade.

IOU app id `1`, canonical name `iou`, remained registered and published through all three index
upgrades. Its exact owner/registrar is
`wty7a-joybz-2ahtd-agtlr-ya5ce-xgl77-mfwne-7kvuz-hxdf6-yrimv-tae` and revision is
`1785968455520`. The generated verification binding and IOU `get_config` agree on UserIndex,
app id, revision, owner, canonical name, app canister, ActionInbox and manifest hash. The
public UserIndex directory query independently reports the same published owner, revision,
name, app/inbox canisters, and per-user-key requirement.

### Account-Type privacy and authorized card visibility

Issue #13's public disclosure is resolved independently of card activation. Public manifest
and extraction data contain no account-Type id, name, keyword, or plaintext template. Without
authorized private context the card still renders the `Account type` control, but its only
choice is `None`; even a plaintext template supplied by the host is neither rendered nor
returned. With the linked account's encrypted, nonce-bound private context, existing unit
coverage proves its decrypted Type roster is visible in both the editable selector and the
read-only IOU card. Thus Type is visible where requested—inside the authorized IOU iframe—while
remaining absent from public OpenChat state and from other accounts.

### Resolved entropy acceptance and remaining card acceptance

The deployed index checkpoint includes the governance-only `inspect_message` allowlist entries
for `stage_action_signing_key` and `activate_action_signing_key`. The later architecture fix
persists a lifecycle id instead of treating live `canister_version` as the lifecycle epoch, and
the corrected controller/time/recovery tests pass. Issues #51, #72, #74, #75, and #76 are closed.

The dedicated local `action_inbox_deposit` key was staged, independently pinned in IOU's ignored
local environment, activated, and queried as `Active`. All four local frontend flags are enabled.
Issue #77 then removed the remaining false-readiness mismatch: chat events, Group, and Community
now execute the approved generic paths only from persisted child `test_mode`; non-test children
and production remain fail-closed. The deployed Group `0.0.2` child carries that gate.

Generic #77/#78/#79 are pushed in both PR 2 source lines, and IOU #45–#49 have focused fixes and
regressions as described above. The setup action was imported after reload, and the
credentialless-card smoke then offered exactly `[None, Rent]`, selected the authorized `Rent`
through a private account-local identifier, approved the edited final payload, and deposited/routed
the draft only to House. The draft deliberately remains `Pending` for user review; import and exact
acknowledgement are not claimed. Production remains disabled independently of the local test-mode path.

## Scope and provenance

### IOU

The review covered all application-owned material:

- Rust canister code, Candid, stable-memory layout, upgrades, authorization, bounds, and
  inter-canister awaits;
- frontend authentication, cryptography and key custody, caches, untrusted data parsing,
  CSV export, OpenChat integration, relay handling, and mobile links;
- unit, integration, E2E, coverage, relay, Android, Candid/WASM, and dependency tests;
- CI, lockfiles, native configuration, generated assets, source maps, ignore rules, and
  security/deployment documentation.

The implementation target was IOU `main`. App-owned problems were fixed there.
OpenChat was changed only where the weakness belonged to the reusable chat platform.

### OpenChat fork-only changes

The review identified 130 unique fork-only commits authored by `ktimam`, relative to
upstream merge base `05ec432…`, across:

- `feat/interactive-action-card` (`c1d72d628`, 4 fork-only commits);
- `feat/windows-desktop-dev-shell` (`374f36070`, 1);
- `feat/on-device-model-manager` (`333c13d3a`, 25); and
- `feat/confirmable-action-cycle` (`f0c740207`, 125).

The local `open-chat` and `open-chat-cycle` forks were reviewed. Unrelated upstream
implementation is not presented as user-authored work.

### Claude chats

The related local Claude histories were read as design/debugging evidence:

- IOU: 12 top-level sessions and 442 JSONL files including subagents,
  2026-07-17 through 2026-08-01;
- OpenChat: 3 top-level sessions and 232 JSONL files, 2026-07-02 through 2026-07-30;
- OpenChat cycle: 1 top-level session and 28 JSONL files, 2026-08-01.

Relevant threads covered tests, the generic contribution plan, chat agent, ActionCard
security, IOU authentication, local models, and browser vision. Chat claims and old test
output were hypotheses; current code and fresh tests were authoritative. No chat secret
content was copied into issues or this report.

## Correct local-development threat model

The intended local scenario is four durable, isolated browser profiles: father, mother,
child, and property manager. Each has its own account and key material. The profiles and
development keys are deliberately reusable so the same accounts can be recreated
across runs.

Normal restart, durable-profile reuse, account recreation across runs, or loss of an
intentionally disposable test profile is **not a security finding**. This report does
not require recovery for a deleted local-development profile. The disposable
`.pw-profiles-scenarios` directories in issue #22 are repository hygiene only; they
are not the four named durable profiles.

The relevant boundary is a production browser profile changing from principal A to B
without a process restart. No UI state, sheet key, consumer private key, relay secret,
inbox marker, chat link, or preference may cross it. IOU now remounts the authenticated
tree by deployment/principal scope, generation-guards asynchronous key work, scopes
durable caches, and purges obsolete global keys. StrictMode activation and the
concurrent disconnect/upload race have dedicated regressions.

Development P-256 keys in isolated local profiles are an accepted dev-only tradeoff,
not a production custody mechanism.

## IOU findings and remediation

### Key lifecycle and authorization

- **#8, critical:** creation waits for the authoritative sheet ID and derives the same
  deterministic production key used on reload; retry does not create a second sheet.
- **#9, critical:** recorded members can derive a closed-sheet key after a fresh
  session; anonymous callers, outsiders, and removed members remain denied.
- **#12, high:** closing snapshots are AES-GCM encrypted under `K_sheet`; only schema,
  ciphertext, IV, and salt reach the canister. Old plaintext stable bytes/backups cannot
  be made secret retroactively.
- **#19, medium:** vetKD transport keys are ephemeral. Production-web consumer JWKs are
  memory-only plus a canister-wrapped record; native production uses secure storage.
  Development remains principal-scoped. Legacy plaintext is removed only after a
  wrapped remote copy, and on native a secure copy, succeeds.
- **#25, high:** OpenChat verification requires the exact configured non-anonymous owner
  and expected app name.
- **#31/#33, high/medium:** authenticated state is session-keyed, stale sheet-key work is
  rejected and zeroized, destructive disconnect requires a principal/generation ticket,
  and deletion waits for every active upload (including orphaned memoized work) before
  becoming the final canister write. Connect, signing, persistence, wrapping, upload,
  and terminal-import paths all reject stale and ABA sessions.
- **OpenChat key disconnect:** the obsolete browser-direct V1 revoke path was removed.
  The browser signs the exact NUL-terminated V2 user/app/key-version challenge from its
  caller-scoped binding; IOU calls the pinned UserIndex as the registered app canister,
  rechecks the pin, binding, key epoch, and PEM after the await, and removes the binding
  only on `Success`/`KeyNotFound`. The normal UI deletes locally only after those clean
  outcomes and retains the key on remote failure. Raw key deletion remains a separately
  documented emergency local erase and may leave an unusable OpenChat public key.
- **#36, medium:** sheet ownership is rechecked after the vetKD await. Authorization
  assumptions are not carried across an await to the
  [ICP management canister](https://docs.internetcomputer.org/references/management-canister/).
- **#42/#44, high:** every non-local OpenChat origin now requires HTTPS and one to three
  independently provisioned ids for the dedicated v4 UserIndex action-signing keyring.
  IOU derives each queried PEM's purpose-scoped id and accepts only pinned `Active` or
  unexpired `VerifyOnly` keys; exact loopback alone retains the recreated-local-keyring
  exception. The complete v4 outer record is verified before decryption, every payload,
  card-context, replay-identity and acknowledgement commitment is recomputed afterward,
  and pre-v4, wrapper-less on-chain, malformed, unknown-field, downgrade, substitution,
  cutoff, route and tamper cases fail closed. Independent Rust-produced preimage/context
  hashes and a raw P1363 signature pin cross-language interoperability.

The design follows [ICP vetKeys](https://docs.internetcomputer.org/concepts/vetkeys/):
transport state is replaceable per session; authorized canister derivation makes a
sheet key recoverable. Production web reload therefore requires authenticated canister
access and intentionally has no plaintext offline fallback.

### Stable state and resource limits

- **#10, high:** explicit caps cover pairs, sheets, entries, ciphertexts, histories,
  wrapped keys, rewrap batches, pages, per-sheet bytes, chat links, and relay state.
  Composite reads replace global scans where possible; legacy fallback scans fail
  closed at 10,000 records.
- **#11, high:** initial administration is installer/controller-bound; later changes
  require the configured creator or a controller.
- **#20, medium:** relay destinations are exact and credential-free, bearer data is in a
  header, CORS/audience/provenance are exact, messages/listeners are byte-bounded, and
  drafts, namespaces, codes, pairings, and rate state are capped and pruned.
- **#30, medium:** stale shadow Candid declarations were removed.
- **#40/#41, medium:** handled ActionInbox items are acknowledged only after durable
  handling and failures remain queued on their originating inbox route. `actions` is now
  a replicated update and IOU always reads from zero; durable identity comes from the
  signed 32-byte replay key, not the numeric locator. Each decrypted secret authorizes
  deletion of at most its one exact action. Replay-under-forged-id, adjacent unhandled
  action, failed-locator replacement, route-change, concurrency and exact-secret
  regressions are covered.

Removing the 10,000-record fallback safely requires new indexes and a resumable
controller migration; partially populated indexes could hide legacy data. Memory IDs
and migrations must follow [ICP stable structures](https://docs.internetcomputer.org/languages/rust/stable-structures/)
and the [canister upgrade guidance](https://docs.internetcomputer.org/guides/security/canister-upgrades/).

### Frontend isolation and untrusted content

- **#13, high:** private templates are no longer published through the public manifest.
  A clean live deployment was queried after all four local OpenChat accounts loaded: the single
  IOU action exposed only `kind`, `message`, `amount`, `currency`, and a public instruction. It
  exposed no `template` field, private type name, or private keyword. IOU also implements and tests
  the required private display path: after authorized private hydration, the editable OpenChat IOU
  card shows an `Account type` selector and the read-only card shows the selected saved Type. The
  opaque iframe decrypts only the linked sheet roster in memory and confirms only a
  sheet/chat/message/row-bound AES-GCM `template_ref`. Before hydration it neither invents nor
  displays a Type. The signed-in importer rejects plaintext OpenChat type selection and restores a
  Type only after authenticating that reference. The owner approved sending the exact public card
  rows/final confirmation bytes through UserIndex to the registered app canister for attestation
  (#48), and approved the one-time private capability handoff (#54). IOU and the generic OpenChat
  candidate implement those narrow contracts. The current local frontend switches are enabled and
  the deployed Group/Community backend paths require persisted `test_mode`; production remains
  fail-closed. The local real-card smoke through edited approval and House-only deposit passed
  against #77/#78/#79; the deposited draft is intentionally pending user review rather than imported
  or acknowledged. The public leak is fixed independently.
- **#14/#17/#32, high/medium:** consumer keys, preferences, relay secrets, chat links,
  and inbox markers are scoped by IOU deployment and principal; inbox state also
  includes OpenChat deployment. Obsolete global keys are purged.
- **#26, high:** entry decrypt/parse failure is isolated per record.
- **#34, medium:** partner template decoding is structurally validated, bounded, and
  item-isolated.
- **#35, medium:** schedules are non-empty and capped at 100; portions and fee semantics
  are validated and negative/invalid balance components are rejected.
- **#18, medium:** CSV export neutralizes formula-leading content, including behind
  whitespace or a byte-order mark.

### Build, mobile, and test gates

- **#21:** production source maps are disabled, generated assets are synchronized, and
  current web/Android assets contain no source maps.
- **#22/#29:** disposable browser-test profiles and `.openchat-iou` co-deployment state
  are ignored without changing the durable four-profile model.
- **#27:** third-party CI actions are pinned to commit SHAs.
- **#28:** RustSec fails on every advisory/warning except exact documented
  `RUSTSEC-2024-0436` (`paste`).
- **#24:** E2E fails when prerequisites are missing unless
  `IOU_E2E_ALLOW_SKIP=1` is explicit; dependency output/status and coverage are
  validated.
- **#37:** raw `iou://invite` capability links are rejected pending verified HTTPS/App
  Links.
- **#38:** Android release tasks fail closed without signing material; debug stays
  usable.

## IOU verification evidence

The latest IOU verification passed `pnpm test` with **824/824 tests**, `pnpm typecheck`,
the focused affected unit set with **34/34**, and the repaired card Playwright suite with
**18/18**. The focused v2 and D8 subset passed **10/10**. The preceding complete build and
Rust checkpoint also passed `pnpm build` and all **48/48** Rust canister tests. This evidence
includes the final
session, disconnect, cross-process stale-epoch, two-device ordering, ABA,
multiple-orphan-upload, terminal-import, StrictMode, cross-deployment cleanup, inbox
exact acknowledgement, signed-delivery replay/locator replacement, keyring substitution and
verify-only cutoff, stale manifest-route race, deployment-owned manifest,
manifest-icon validation, private account-type visibility, exact card-context binding, encrypted
type-reference isolation/tamper, strict v4 ActionInbox decoding, and key-lifecycle regressions.
The browser repair tests the host-first v2 bootstrap, exact 32-byte frame nonce and app context,
and rejects v1, missing/wrong nonces and stale replay after nonce rotation. The instrumented
security-critical coverage below is an earlier checkpoint that includes the
private card-context and account-type display/import additions, exact initial/final OpenChat
card-attestation wire, ActionInbox protocol correction, and Hono advisory pin. Coverage was not
rerun after the final correlation/browser changes and must not be presented as the latest
824-test run.

IOU #45/#46 add repository-policy regression cases for the opaque-origin asset CORS contract and
absence of a shadow `vite.config.js`. They are current working-tree additions and are not included
in the historical **824/824** count above; their final focused/full run belongs in the closing
acceptance evidence.

- TypeScript `pnpm typecheck`: passed.
- Security-critical coverage: 86.01% statements/lines (4,570/5,313), 85.00% branches
  (1,310/1,541), 89.51% functions (316/353).
- The broader whole-`src` diagnostic was not rerun on 2026-08-05. Its 2026-08-01 historical
  result was 45.89% statements/lines (5,541/12,072), 87.08% branches (1,881/2,160),
  and 85.86% functions (407/474); do not present it as current or confuse it with the
  security-critical gate.
- Rust canister tests: 48/48, including canonical non-direct card-context coverage,
  the 181-byte cross-language card commitment/hash golden, exact public rows and payload,
  exact final encrypted type-reference binding, stale key/revision/chat/account rejection,
  frontend-IDL-to-Rust wire decode, every V2 disconnect-binding coordinate, and the
  coordinated-revoke versus emergency-erase policy. The earlier locked strict-Clippy and
  release-WASM hash evidence was not regenerated by the 2026-08-05 continuation.
- Production `pnpm build`: passed at 217 modules with the existing size warning.
- Real-registry npm audit gate: passed. The newly published Hono CORS ReDoS advisory
  (GHSA-8j4g-w8fx-2239) initially failed the gate; pnpm 11 now enforces Hono 4.12.34
  through `pnpm-workspace.yaml`, `pnpm why hono` reports one patched version, and an
  offline regression rejects vulnerable lockfile entries. Cargo audit scanned 98
  dependencies against 1,189 advisories and passed with only the exact `paste` exception.
- IOU relay self-test: 18; OpenChat relay self-test: 19/19.
- Capacitor/source-map gates: passed, with zero current source maps.
- Android debug: 139 tasks. APK 4,708,991 bytes, SHA-256
  `135088FA3DA381B00520C4A55753F4428342581A3D65FFAB653ACAB107F8AC97`.
- Android release without credentials failed as intended.
- Final IOU `git diff --check` was clean apart from line-ending warnings. Full repository
  `cargo fmt --check` remains non-green solely because of broad pre-existing/unrelated
  `src/lib.rs` formatting drift; no mass formatting was applied as part of this security work.

No skipped replica test counts as evidence. Local unit success does not replace a
deployed upgrade/recovery drill.

### Local generated-artifact cleanup

The OpenChat cycle fork's rebuildable Windows Rust intermediates had grown to
**50.34 GiB** under `target/debug`, primarily incremental and dependency outputs plus
multi-gigabyte `.lib`/`.rlib` files. After all active verification processes exited,
the cleanup resolved and checked that exact directory and removed only rebuildable
children. Final protocol tests regenerated 10.41 GiB and those intermediates were
removed by the same checked procedure. The final PR 1 cache and PR 2 backend gates then
regenerated another **33.14 GiB**; after confirming that no Cargo or Rust compiler process
remained, a third checked pass removed those intermediates. The three passes reclaimed
**93.79 GiB** of generated files in aggregate and left the directory at 52.1 MiB. They
preserved the runnable
`open-chat.exe` and `app_lib.dll`, all source and untracked PR material, `.dfx`
canister state, and the four browser profiles. Removed artifacts are not in the recycle
bin; Cargo can regenerate them.

The clean PR 2 submission worktree's rebuildable
`C:\tmp\openchat-pr2-submit\target` contained 67,417 files: approximately **40.44 GiB**
logical and **37.93 GiB** allocated. After its owning validation completed, that exact target
was resolved, checked, and removed. Source, `.dfx`, the clean PR branch, untracked material,
browser profiles, and replica/canister state were preserved. This was an intermediate clean-PR2
target cleanup, not a final cleanup claim: the reusable checkpoint target was subsequently used
for exact Wasm builds, deployment, and PocketIC compilation.

After later validation recreated output in that submission worktree, a new bounded cleanup removed
only `C:\tmp\openchat-pr2-submit\target\debug`, measured at exactly
**17,297,571,964 bytes**. The exact directory was removed rather than a broader target path; free
space after deletion was exactly **42,176,458,752 bytes**. This is another rebuildable-debug-output
cleanup record, not a final-candidate or broader-worktree cleanup claim.

After the later child-Wasm work completed, the exact rebuildable directory
`C:\tmp\openchat-checkpoint-entropy-target\debug` had grown to approximately **57.04 GiB**.
It was resolved and removed without touching the measured ~**0.71 GiB** release output, source,
untracked PR work, `.dfx` replica state, or browser profiles. Free space rose to approximately
**57.46 GiB** before subsequent release builds consumed part of it (approximately **50 GiB** free
afterward). No broader target or replica cleanup was performed; the debug output is reproducible
and was not moved to the recycle bin.

The most recent focused cleanup removed only the two exact incremental compiler-cache
directories `C:\Kiko\MyProjects\IOU\target\debug\incremental` (**0.67 GiB**) and
`C:\Kiko\MyProjects\Blockchain\ICP\open-chat-cycle\target\debug\incremental`
(**3.52 GiB**). Both paths were confirmed absent afterward, and free space rose from
**10.41 GiB** to **14.03 GiB**. Cargo can regenerate them. Executables, release/Wasm output,
dependencies, source and untracked PR material, `.dfx` state, the replica, and all four
browser profiles were preserved.

The IOU and OpenChat Vite processes run on ports 3000 and 5003, and the
preserved local replica remains healthy on port 8080. Browser profiles, local storage,
canister state, and the father/mother/child/property-manager account model were not reset.
The reviewed checkpoint OpenChat canisters and IOU backend were upgraded in place as listed
in the 2026-08-06 snapshot. The OpenChat frontend was restarted with all four local flags and
local canister ids after a stale process had been contacting mainnet ids; the replica and profiles
were left intact. The active key, pairings, group membership, and app enablement are verified.
The subsequent browser smoke did prove the local private-Type/final-confirmation path through
House-only deposit. It did not import or acknowledge the resulting draft, which remains pending
for user review, and it does not replace hosted or production-release gates.

## IOU residual release boundaries

1. Historical plaintext closing data can remain in old stable bytes/backups.
2. The 10,000-record fallback needs an indexed migration before that population.
3. Dev P-256 member replacement still needs per-sheet historical rewrap to match
   production vetKD. This does not affect recreation of the four local accounts.
4. Production-web restoration requires a live authenticated canister/vetKD path.
5. Verified HTTPS mobile association, real Android signing, complete live-replica E2E,
   production-like upgraded-canister tests, and recovery drills remain release gates. The
   preserved local state has been upgraded, but that is narrower evidence.
6. The new #39 stable epoch must still be exercised by an in-place canister-upgrade/live
   two-agent drill, including the backend-first breaking-Candid rollout and a cached old
   PWA; unit state-machine and stable-map reopen coverage pass locally.
7. The replicated ActionInbox read and exact acknowledgement flow (#40/#41) still require
   a live multi-page/retry/redeploy drill against rebuilt OpenChat canisters.
8. Production must provision and rotate the #42 allowlist of dedicated v4 signing-key ids
   through an independently authenticated release channel. UserIndex keyring discovery is
   not a remote trust root; the empty-allowlist exception is exact-loopback development only.
9. The earlier IOU fixes, both exact OpenChat PR branches, and the PR 2 deployment checkpoint are
   pushed where applicable. Draft PRs are #9132 and #73. Generic PR 2 #77/#78/#79 are pushed;
   IOU #45–#49 are included in the current IOU main change and deployed locally. Hosted CI and
   production release drills remain.
10. The owner approved the exact full-card/final-payload attestation and one-time
    viewer/card/recipient-key-bound private capability, and both generic/client contracts
    are implemented locally. Local activation is enabled only through persisted child `test_mode`,
    and the signing-key ceremony is complete. Production remains disabled and retains the
    architecture, Candid, PocketIC, signing-trust, and four-profile release gates. The authorized
    `Rent` display, edited approval, and House-only deposit passed locally against #77/#78/#79.
    The draft was deliberately left `Pending` for user review, so import and exact acknowledgement
    remain outside this smoke result.

## OpenChat review

### PR 1 — local inference/model management

The PR 1 tree now enforces canonical lowercase model IDs (maximum 64), blocks path/dot,
Windows-reserved, and case-collision forms; permits only credential-free HTTPS port 443;
blocks private IPv4/IPv6, DNS rebinding, proxy inheritance, and unsafe redirects; pins
DNS and byte limits; and bounds the store to four models/24 GB.

Mutation locking, atomic stage/backup, canonical-child deletion, fail-closed manifests,
full SHA-256 verification before parsing, immutable browser catalog metadata, restored
selection validation, and prompt/text/image/schema/token and concurrency caps are in
place. Desktop navigation is exact and limited to safe schemes. Fork bootstrap beacons,
intercepts, hard-coded loopback telemetry, runtime leakage, and generated-CSP bypasses
were removed. Real-model tests cannot silently pass without a fixture.

The continuation review also found that a static path-only model/projector map could
reuse stale content after a verified same-path replacement and retain every loaded native
allocation (#71). The cache is now keyed by verified path plus freshly checked SHA-256,
has deterministic capacity one for the model and projector respectively, loads before
evicting a known-good entry, and invalidates only the affected identity on a committed
replacement or live deletion. A failed live deletion or successfully rolled-back
promotion preserves the known-good entry; a committed live deletion is invalidated before
scratch cleanup, and a promotion whose rollback also fails evicts fail closed. The cached
projector explicitly retains its backing model so its native raw-pointer lifetime is safe.

The browser Gemma catalog pins revision
`0314792d7f1f7e229411f620751375812bb9faf2` with exact hashes/sizes and licensing. CI
real inference uses an immutable 13,893,600-byte MIT GGUF fixture.

The final PR 1 evidence comes from the clean branch `codex/pr1-local-models` at
`f7825b347b5f8449053778450b934110e0ee3537`, based on upstream `3c49a7302`, rather than the
old combined worktree. It passes **178 frontend tests**, the app TypeScript check with zero
errors, **15/15** native tests and **16/16** catalog tests. Registry, integration and shipping
feature builds compile, and its security, secret, license and formatting audits pass. The
candidate contains only generic model functionality and is pushed. The repository-wide Svelte
diagnostics remain inherited upstream debt outside this changed surface.

CI pins Node 24.18.1. Node 20 reached EOL on 2026-03-24 per the
[official lifecycle](https://nodejs.org/en/about/previous-releases); the exact release
was checked in the [official index](https://nodejs.org/dist/index.json).

### PR 2 — generic in-chat cards/external apps

Current hardening fixes:

- **#8/#12/#19/#20/#26:** immutable app/revision/action identity, authoritative
  recipients, private max-eight key lookup, bounded contracts, HTTPS/credential checks,
  iframe origin binding, and immutable host provenance;
- **#9/#10:** immutable owner, changed-manifest unpublication/re-review, revision checks,
  and compare-and-set publication across the verifier await;
- **#11/#17:** canonical first-wins published names, bounded/expiring unpublished
  reservations, 256-bit link capabilities, per-principal throttling, O(1) token lookup,
  and bounded/reclaimable token state;
- **#18:** invalid/oversized overrides are rejected instead of using stale payload;
- **#21:** IOU WASM/fixtures are replaced by a neutral verifier;
- **#25/#49:** confirmation reserves one immutable actor/payload/generation before outbound
  awaits. UserIndex's durable semantic outbox persists the exact authoritative request and
  destination before the ActionInbox await, shares one dispatch across exact retries, rejects
  altered attempts, and absorbs late results without lease takeover. Linux restart/upgrade and
  every-await interleaving proof remain release gates;
- **#33/#35/#39:** append-only stable indexes, durable resumable secondary-index cursors,
  bounded expiry/cleanup work, fail-closed capacity, and exact 1 MiB deposit / 512 KiB
  response ceilings replace monolithic scans and silent eviction. The exact pre-PR2 heap
  schema is decoded; empty state upgrades, while non-empty legacy actions/replay state traps
  explicitly because it lacks the fields required for a valid v4 conversion;
- **#34:** UserIndex re-derives the current published app revision and authoritative
  inbox route rather than trusting a card-selected destination;
- **#37:** each encrypted v4 envelope carries a random 32-byte acknowledgement
  capability. ActionInbox stores only a domain-separated digest bound to its canister
  and action fingerprint, then acknowledges one exact live numeric locator with a fixed-cost
  comparison. Legacy, malformed, future, wrong, replayed, or missing capabilities fail
  closed;
- **#40/#42/#43:** app keys require canonical P-256 SPKI PEM, the standalone crypto
  crate declares its own serde feature, and unknown link tokens are rejected before
  P-256 parsing; and
- **#41:** per-user, per-app, and global count/byte limits, reverse indexes, resumable
  100-row reconstruction, and deletion cleanup bound the app-key lifecycle;
- **#52:** app deletion removes active and consumed provenance, capabilities, grants, and
  app-owned key/link state. Only a 60-second anti-churn issuance record remains, with bounded
  periodic cleanup; unknown/state-free removal no longer creates unbounded epochs. Focused
  deletion, expiry, cap, same-key relink, and adjacent lifecycle tests pass;
- **#51/#72/#74/#75/#76:** UserIndex, LocalUserIndex, and GroupIndex persist
  `LifecycleId { generation, version_salt }` and a `raw_rand`-seeded entropy gate. Security outputs
  fail closed until ready; a recovery upgrade advances the lifecycle, clears restored short-lived
  bearers/authorities, and schedules fresh entropy while purpose/counter separation prevents reuse.
  Corrected controller, time, rollback, and migratory-task tests pass and these issues are closed;
  production-like recovery drills remain release evidence rather than an implementation blocker;
- **#47/#61:** portable explicit manifest/card encodings replace raw Candid hashing,
  frozen cross-language vectors detect drift, and publication preserves the exact
  manifest revision vouched by the app canister;
- **#48/#54:** the backend recomputes and stores an exact full-card content hash, accepts
  the verified bit only after an exact registered-app echo, and requires a separate final
  grant for the exact edited confirmation bytes. The frontend now transports those exact
  contracts and delivers the approved private-context capability only after an explicit
  click through a source/opaque-origin/per-load-nonce-bound bridge. The local switches are enabled;
  production remains compiled/gated off, and the child backend executes only from persisted
  `test_mode`;
- **#55/#57:** ordinary test-mode users can no longer re-own another user's app, and
  group/channel enablement is capped at 32 with deterministic legacy/import bounding;
  and
- **#77:** chat events, Group, and Community use the persisted child `test_mode` flag for the
  approved private-context and edited/final-confirmation backend paths. A frontend flag alone
  cannot activate them; non-test children fail closed. The focused set passes **89/89** in each
  worktree with format/check, and Group/Community `0.0.2` were published from `8ae34cf38`;
- **#78:** the generic host's one-shot bootstrap can precede a framework listener. The current
  fix repeats the same nonce-bound bootstrap only during the bounded handshake and cancels on
  ready/reset/timeout/teardown. Focused retry/cleanup/stale-session regressions are pushed in clean
  `f93bffe0a` and checkpoint `4eed022b8`, and the local live smoke passed;
- **#79:** the generic bridge copies Svelte-proxied private context into structured-clone-safe values
  before `postMessage`. The fix and regressions are pushed in clean `68aadfd35` and checkpoint
  `790bb76d0`, and the local live smoke passed;
- **#63/#64/#65/#69:** LocalUserIndex rechecks exact child authority after its await,
  group/community retain and revalidate the captured ingress identity rather than the
  callback caller, and app verifier, attestation, configuration and ActionInbox calls now
  have explicit ten-second bounded waits. UserIndex applies caller, caller/app, app,
  global and in-flight deposit/attestation limits before each outbound await. The durable
  exact-byte outbox and late-result/cutoff policy are implemented; stopped-inbox/upgrade runtime
  recovery proof remains open under #69;
- **#36/#66/#68:** thread root participates in the durable card identity. Live writes
  use the full 32-byte identity directly in the 64-byte selector-plus-identity primary
  tombstone key and bind the final-payload hash; there is no u64 projection or side map.
  Projected-prefix collisions and altered retries fail closed after reopen. Recipient bindings are raw-count
  bounded before work and validated with bounded set/map comparisons; and
- **#38/#45/#67/#70:** GroupIndex one-use authority contains the exact route/card/lease
  coordinates; UserIndex revalidates and consumes it, re-derives the app and recipient route,
  and signs the complete NUL-domain-separated v4 outer record with a dedicated staged/active/
  verify-only keyring. `actions` is replicated. Remote consumers use independently pinned key
  ids; keyring discovery is not their trust root. Deterministic Rust/WebCrypto vectors and
  route/key/purpose mutation tests pass; Linux PocketIC/live rollout proof remains.

The clean PR 2 branch at `68aadfd35d93b3bbb25d352edb81c83790160c0c` is pushed and open as
draft [#73](https://github.com/ktimam/open-chat/pull/73), stacked on exact PR 1 head
`f7825b347b5f8449053778450b934110e0ee3537`. The dependency-compatible checkpoint is
preserved at `790bb76d00240ca5a8a4c124db4535dd7795f96b`. Focused entropy tests and component/
Wasm checks are green on both sources, and the safe local frontend gate passes **22/22** focused
security tests, TypeScript, and targeted Svelte diagnostics. The later lifecycle and #77 gates are
also green as recorded above. The final clean-head PR 2 focused rerun passes **68/68**. Generic
#78/#79 are committed and pushed in both source lines. The current whole-workspace `svelte-check`
is not a green or authoritative gate because its `node_modules` is linked to the deployment repo,
`marked` and `svelte-easy-crop` are missing, and inherited `VideoCallsReleased` parser errors remain.

The final source-scoped PR 2 frontend run is green: shared 8 files/175 tests, agent 8/32, client 15/164,
and app 23/382, for **54 files and 753 tests**. The agent capability mapper passes 4/4, the new worker
response-contract regression passes 1/1, Turbo worker build/typecheck passes 4/4, and the OpenChat app
dependency typecheck passes 7/7. The broad package command also collected tests from a pnpm-linked
Rollbar dependency and failed on that vendor package's deprecated APIs; `--dir src` establishes the
application-source result and the vendor collection is a local harness artifact, not an OpenChat source
failure. The checkpoint frontend source result is retained as regression evidence. The clean
reconstruction, exact checkpoint Wasms, formatting/diff, and genericity gates now exist; strict
generated/bidirectional Candid comparison, hosted CI, remaining production-like PocketIC drills,
and complete live action-flow evidence through reviewed import/exact acknowledgement remain pending.
The local `Rent` smoke through House-only deposit passed, but the state-preserving checkpoint upgrade
is not a substitute for those final gates.

An earlier exact-checkpoint WSL/PocketIC v11 run reproduced `NotInitialised` and exposed wrong
controller/time handling in the snapshot tests. That evidence was retained because it led to
#72/#74/#75/#76; it is not the current result. The corrected persisted-lifecycle implementation,
harness, and exact-Wasm gates pass and those issues are closed. Broader production-like coverage of
the complete asynchronous chain, stopped canisters, upgrades, and ambiguous outcomes remains.

The broader PocketIC suite, including the 100-by-1,000 ActionInbox capacity and
acknowledgement-sybil cases, remains unexecuted against the final exact-commit matrix and is not
counted as runtime evidence. The exact old
heap snapshot necessarily deserializes before the O(1) non-empty guard; it now rolls the
upgrade back with a migration-required trap instead of losing data. A non-empty legacy
deployment therefore needs a drain/export/reinstall decision, while current-v4 capacity
and upgrade behavior still need their explicit Linux release runs.

Architecture/release blockers include:

1. **#13:** installer/controller/metrics wiring and the UserIndex-to-ActionInbox-to-
   LocalUserIndex path are deployed in the preserved local environment. The existing local
   ActionInbox `cycles_dispenser` value remains a documented test-only mismatch because no
   non-destructive setter exists. Separately, a non-empty committed pre-PR2 heap snapshot traps
   explicitly because its rows cannot be authenticated as v4. Before upgrading such a production
   canister, drain it or use a reviewed export/reinstall policy; prove current-state, restart,
   saturation and recovery in PocketIC/live replicas.
2. **#38/#45/#51/#72/#74/#75/#76:** stage/activate/verify-only logic, independently pinned
   remote trust, the `inspect_message` ingress entries, and persisted lifecycle are implemented.
   Local key staging/pinning/activation and corrected recovery gates passed. Production still needs
   partial-rollout/convergence/retirement drills and a controller/backup threat model plus bounded
   scrubbing before claiming physical deletion of retired private-key copies from heap or stale
   upgrade memory.
3. **#48/#54/#77/#78/#79 plus IOU #45–#49:** exact initial/final attesters, the click-only private
   capability, and persisted-test-mode backend activation are implemented. Production remains
   hard-disabled. The local card offered exactly `[None, Rent]`, used the private account-local
   `Rent` identifier, passed edited confirmation, and deposited only to House. The resulting draft
   remains `Pending` for user review; later import/exact-ack release evidence must preserve the same
   account boundary. Public OpenChat state must never contain Type metadata.
4. **#49/#51/#69:** the immutable semantic outbox, exact retry/late-result policy, and persisted
   lifecycle/`raw_rand` entropy gates are implemented. Prove production-like
   stop/snapshot/issue/load/reseed, stopped-inbox/timeout, restart/upgrade, and ambiguous-callback
   recovery across the coordinated state graph before production activation.
5. **#36/#66/#67/#70:** full-width identity, one-use route authority and complete v4
   signatures pass focused tests. Prove them across upgrades and a two-LocalUserIndex,
   cross-shard, four-user PocketIC matrix, including compromised/stale-shard attempts.
6. **#52:** lifecycle deletion, bounded anti-churn retention and periodic cleanup pass
   focused tests; still prove long-id churn, upgrades and app delete/recreate behavior under
   realistic load before enabling capabilities.
7. **#56/#60:** source-level directory and manifest bounds are implemented. Product callers use
   exact-id or paginated APIs: a client call accepts at most 32 exact app lookups and chunks them
   into backend requests of at most 8; explorer and owner pages are also capped at 8. Every new
   directory response must fit both exact Candid and MessagePack encodings under 1,200,000 bytes.
   The legacy `ai_apps` wire method returns only a bounded first compatibility page and has no
   product caller. MyApps now paginates, search length counts Unicode scalar values without a
   narrowing/wrap conversion, and search totals count all matches before pagination. Registration
   enforces 100 rules and 2,000 keywords per manifest, 500 keywords per action, prototype-safe ASCII
   field names, and bounded schema depth/node/property counts while rejecting regex `pattern`.
   Focused validation passed: UserIndex directory filters 6/6, near-capacity page cloning 1/1,
   search totals 1/1, API contract tests 4/4, agent client/mapper tests 9/9 and action/card/surface/
   auto-propose tests 86/86; the agent typecheck passed. Manifest validation passed 9/9 backend and
    56/56 frontend focused tests. A reviewed checkpoint backend is deployed locally, entropy/keyring
    acceptance is complete, and all local frontend flags are enabled. The local browser chain through
    House-only deposit passed against #77/#78/#79; import/exact acknowledgement remains deliberately
    deferred for user review, and production remains off.
8. **#58:** app-authenticated private claim/selector operations, secret-derived per-app subjects and
    selectors, canonical chat/message handles, and removal of the raw IOU link URL are fixed in source.
    The Rust integration target compiles; 15 link/revoke integration tests compile without runtime,
    and the affected agent/worker/app response, build and typecheck path passes. Clean regeneration,
    rebuilt WASMs, Linux PocketIC and live-upgrade proof remain release gates.
   **#62:** the pre-await attempt/in-flight limits require reject/trap/timeout PocketIC concurrency
   proof and are not Sybil resistance.
9. **#50:** source restore paths now purge retained errors/logs/traces whose endpoint markers identify
   PR2 link, card, capability, grant, route or deposit operations in User, LocalUserIndex, UserIndex,
   GroupIndex, Group and Community. ActionInbox preserves its stable tuple compatibility but never
   restores or re-persists historical traces. Focused logger purge tests pass 2/2, ActionInbox stable
   restore tests pass 4/4, and source-contract checks pass 2/2. The preserved local canisters were
   upgraded, but no before/after exported-log drill was captured; a disposable upgrade must still
   prove historical entries are removed and stay absent after another upgrade.
10. IOU #45–#49 are implemented, tested, and locally deployed. Generic PR 2 #77/#78/#79 are
    already pushed, its clean-head focused rerun is **68/68**, and the local
    confirmation-to-House-only-deposit smoke passed.
    Preserve the deposited draft for user review before completing replicated-read-to-IOU-
    verify/decrypt/import-to-exact-ack evidence. Also run strict bidirectional Candid checks, Linux
    PocketIC, and a disposable live upgrade; the successful local checkpoint and child deployment
    alone are not complete release evidence.

## Exact two-PR plan

### PR 1

The clean pushed branch is `codex/pr1-local-models` at
`f7825b347b5f8449053778450b934110e0ee3537`, based on upstream `3c49a7302`. It includes only
generic model contracts/catalog/integrity, downloader/store, llama.cpp and Tauri bridge,
browser text/vision inference, model UI, platform support required by those model features,
tests, SBOM, license/dependency policy, and the shared model-refresh event contract.
It is open as draft [upstream PR #9132](https://github.com/open-chat-labs/open-chat/pull/9132).

Exclude ActionCard/external-app code, IOU material, fork notes, local scripts, generated
profiles/WASM, general desktop-shell/navigation changes, and mixed lockfiles. Require clean
Linux/Windows CI, a non-mutating
candidate formatting check, and no false-green real-inference job.

### PR 2

Include only generic bounded app/manifest contracts, directory/publication lifecycle,
per-chat enablement, app-bound linking, authoritative recipients, signed/encrypted
delivery, secret-based acknowledgement, inbox/key lifecycle and resumable migrations,
confirmation state machines/leases, card UI, external-host provenance, and optional
generic proposal support. It may consume PR 1's generic inference interface, but card/external-app
behavior must fail cleanly without a local model and PR 2 must contain no model implementation delta.

The pushed `codex/review-checkpoint-pr2` branch at
`790bb76d00240ca5a8a4c124db4535dd7795f96b` preserves the dependency-compatible source line
but is not the PR submission diff. The clean `codex/pr2-app-chat-interfaces` branch at
`68aadfd35d93b3bbb25d352edb81c83790160c0c` is stacked on the exact frozen PR 1 commit above and
open as draft [fork PR #73](https://github.com/ktimam/open-chat/pull/73). Path/hunk and genericity
review found no IOU identifiers or local-model implementation delta; rerun those gates for every
subsequent change.
Fork notes, caches, local deployment helpers, generated artifacts and mixed lockfiles are not
admitted. Generic #77/#78/#79 are pushed in PR 2; keep IOU #45–#49 strictly in IOU. The checkpoint
source has advanced beyond the deployed artifacts: index Wasms remain from `7c997f4b1`, while Group
and Community child Wasms remain from `8ae34cf38`. Finish the remaining #36/#45 PocketIC/live proof,
then scan every candidate for IOU
strings, URLs, prompts, ids, fixtures, canister ids, and Wasms.

There is no third mixed PR. The two draft PRs are exactly upstream #9132 and fork #73; PR 2 also
has one non-submission preservation/deployment checkpoint. IOU-specific adoption remains in IOU.

## Tracking uncommitted OpenChat material

[Issue #3](https://github.com/ktimam/open-chat/issues/3) is the canonical inventory for
fork-only untracked material that must not be committed just to track it. Record path or
safe category, purpose, owner, sensitivity, disposition (PR 1, PR 2, shared ignore,
personal/outside repo, or delete after review), target issue/PR, base commit, and a
checksum when useful. Categorize generated permissions, caches, scripts, models/paths,
canister IDs/WASM, profiles/credentials, IOU artifacts, and mixed lockfiles without
pasting sensitive contents.

Use `.git/info/exclude` for repository-local caches, notes, and personal/generated
artifacts without a commit. These two OpenChat directories are linked worktrees, so
their `info/exclude` file is shared; add only patterns that are safe to hide in both
worktrees. Use committed `.gitignore` only for a generic rule that protects every
contributor. Do not use stash as the long-term inventory, run broad `git add`, or place
credentials in issues. Issues #1/#2 remain the two umbrella trackers, with individual
security issues linked for tests and acceptance criteria. The recommended workflow is
therefore: inventory with `git status --untracked-files=all`, record only safe path and
disposition metadata in #3, link a PR candidate to #1 or #2, and add it to an actual PR
only when that PR is reconstructed from an exact clean-base path list.

On 2026-08-05 this was also implemented in GitHub without committing any local
artifact: milestones `OpenChat PR 1 - Local Models` and `OpenChat PR 2 - App Cards`
now hold the corresponding issues; labels `pr-1-local-models`, `pr-2-app-cards`,
`security-review`, `release-blocker`, `untracked-work`, and `fixed-in-worktree`
separate scope from status. Issue #3 is the non-secret inventory. A local path being
listed in #3 does not authorize adding it to either PR.

The Windows debug external-browser **profile-selection override** is one such local item: record
its local launch settings in #3 with disposition **debug-only / excluded from PR 2**. Do not record
the contents of browser profiles. Do not conflate that override with #91's generic desktop
`open_url` repair, which delegates to the operating-system handler, contains no profile
selection, and is committed in exact pushed PR 2 head
`16080b0780ed97c3cd63d4187188ac04b19b3769`.
If a generally useful
profile-selection feature is ever proposed, give it its own issue and security review; it does not
become a third PR or part of the current card/model submissions merely because the fixture needs it.

Keep #3 as the safe inventory rather than committing helpers just to remember them. Its next
checkpoint should distinguish the historical pushed/checkpoint/Wasm provenance from the current
exact pushed setup-token head `16080b0780ed97c3cd63d4187188ac04b19b3769`, including the
committed #91 bridge and its passed exact-blob Linux production gate. Keep the entropy (#51),
outbox (#49/#69), scoped-identity (#58), and debug
browser-override categories separate. Do not include keys, selectors, canister credentials,
browser state, or private fixture contents in the issue.

## GitHub issue index

An open issue may have a working-tree fix; it remains open pending review, commit,
hosted CI, and live verification.

Each canonical issue was opened with reproduction steps, security impact, acceptance
criteria, and an exact-regression plus adjacent-boundary test plan. Rows marked closed
have their implementation and validation evidence recorded in the linked issue.

### IOU

| Issue | State | Subject |
|---|---:|---|
| [#8](https://github.com/ktimam/IOU/issues/8) | Open | Critical production sheet-key persistence |
| [#9](https://github.com/ktimam/IOU/issues/9) | Open | Critical closed-sheet recovery |
| [#10](https://github.com/ktimam/IOU/issues/10) | Open | Storage/cycle bounds |
| [#11](https://github.com/ktimam/IOU/issues/11) | Open | Configuration front-running |
| [#12](https://github.com/ktimam/IOU/issues/12) | Open | Plaintext closing balances |
| [#13](https://github.com/ktimam/IOU/issues/13) | Open; public leak/account isolation verified, setup imported, authorized `Rent` selection and House-only deposit passed; draft pending user review | Template metadata leakage |
| [#14](https://github.com/ktimam/IOU/issues/14) | Open | Cross-principal consumer key |
| [#15](https://github.com/ktimam/IOU/issues/15) | Closed duplicate | CSV; canonical #18 |
| [#16](https://github.com/ktimam/IOU/issues/16) | Closed duplicate | Custody; canonical #19 |
| [#17](https://github.com/ktimam/IOU/issues/17) | Open | Preference isolation |
| [#18](https://github.com/ktimam/IOU/issues/18) | Open | CSV formula injection |
| [#19](https://github.com/ktimam/IOU/issues/19) | Open | Consumer JWK/vetKD custody |
| [#20](https://github.com/ktimam/IOU/issues/20) | Open | Relay controls |
| [#21](https://github.com/ktimam/IOU/issues/21) | Open | Bundle/source-map freshness |
| [#22](https://github.com/ktimam/IOU/issues/22) | Open | Disposable profile ignores |
| [#23](https://github.com/ktimam/IOU/issues/23) | Closed duplicate | Gates; canonical #24 |
| [#24](https://github.com/ktimam/IOU/issues/24) | Open | E2E/dependency/coverage gates |
| [#25](https://github.com/ktimam/IOU/issues/25) | Open | OpenChat owner binding |
| [#26](https://github.com/ktimam/IOU/issues/26) | Open | Malformed-entry DoS |
| [#27](https://github.com/ktimam/IOU/issues/27) | Open | Mutable CI refs |
| [#28](https://github.com/ktimam/IOU/issues/28) | Open | RustSec warnings |
| [#29](https://github.com/ktimam/IOU/issues/29) | Open | `.openchat-iou` ignore |
| [#30](https://github.com/ktimam/IOU/issues/30) | Open | Shadow Candid |
| [#31](https://github.com/ktimam/IOU/issues/31) | Open | Auth/session boundary |
| [#32](https://github.com/ktimam/IOU/issues/32) | Open | Relay/chat/inbox scope |
| [#33](https://github.com/ktimam/IOU/issues/33) | Open | Disconnect/upload race |
| [#34](https://github.com/ktimam/IOU/issues/34) | Open | Partner template bounds |
| [#35](https://github.com/ktimam/IOU/issues/35) | Open | Schedules/fees |
| [#36](https://github.com/ktimam/IOU/issues/36) | Open | Post-await authorization |
| [#37](https://github.com/ktimam/IOU/issues/37) | Open | Mobile custom-scheme invite |
| [#38](https://github.com/ktimam/IOU/issues/38) | Open | Android signing guard |
| [#39](https://github.com/ktimam/IOU/issues/39) | Open; committed/pushed on main, live two-agent upgrade drill pending | Cross-process consumer-key mutation epoch |
| [#40](https://github.com/ktimam/IOU/issues/40) | Open; exact-secret acknowledgement fixed, live drill pending | Handled ActionInbox items were never acknowledged |
| [#41](https://github.com/ktimam/IOU/issues/41) | Open; cursor removed/replicated read fixed, live drill pending | Exclusive inbox cursor skipped an adjacent action |
| [#42](https://github.com/ktimam/IOU/issues/42) | Open; v4 key-id pins/rotation cutoffs fixed, production pins pending | Uncertified OpenChat signing-key query |
| [#43](https://github.com/ktimam/IOU/issues/43) | Open; committed/pushed on main, hosted clean-install CI pending | Transitive Hono CORS ReDoS advisory |
| [#44](https://github.com/ktimam/IOU/issues/44) | Open; complete v4 verification fixed, cross-repo/live proof pending | Stale ActionInbox v2 signature and permissive envelope decoder |
| [#45](https://github.com/ktimam/IOU/issues/45) | Closed; IOU-only CORS/header fix, policy regression, and live opaque-frame load passed | Opaque card iframe cannot load public modules |
| [#46](https://github.com/ktimam/IOU/issues/46) | Closed; stale file removed and repository-policy regression passes | Ignored `vite.config.js` shadows tracked security config |
| [#47](https://github.com/ktimam/IOU/issues/47) | Closed; IOU-only domain-separated hash fix, crypto/poll 42/42, and stored-action recovery passed | Raw payload hash makes valid v4 actions invisible |
| [#48](https://github.com/ktimam/IOU/issues/48) | Closed; actor dependency fix, policy 12/12, and fresh-reload polling passed | Sheet poll captures an undefined actor after reload |
| [#49](https://github.com/ktimam/IOU/issues/49) | Closed; key/binding invariant, legacy fail-closed migration, 53/53 Rust, 830/830 frontend, in-place backend upgrade, four relinks, and post-upgrade card context passed | OpenChat binding can drift from the authoritative consumer key |
| [#50](https://github.com/ktimam/IOU/issues/50) | Closed; failing-first regression, source fix, preserved-state first-use routing, and live journey pass | Raw-route hardening removed the discoverable chat-to-sheet setup journey |
| [#51](https://github.com/ktimam/IOU/issues/51) | Closed; synchronous main capture/dynamic-bootstrap fix and focused/build/routing gates pass | Routing bearer scrub ran after asynchronous authentication initialization |
| [#52](https://github.com/ktimam/IOU/issues/52) | Open; exact-head hydration and complete confirm → ActionInbox → routed import/ack → History lifecycle pass locally, hosted four-profile CI automation remains | Automate full OpenChat card-delivery lifecycle acceptance |
| [#53](https://github.com/ktimam/IOU/issues/53) | Closed; manifest/attester alignment, focused frontend/Rust coverage, active registration read-back, and full signed-in image lifecycle pass | Image-card schema admitted values rejected by the IOU attester |
| [#54](https://github.com/ktimam/IOU/issues/54) | Closed; IOU-only parser fix rejects year zero and focused parser/schema tests pass | Direct draft import accepted year-zero dates |
| [#55](https://github.com/ktimam/IOU/issues/55) | Closed; IOU-only safe-minor-unit fix rejects unsafe/overflow results and focused parser tests pass | Direct draft amount conversion accepted unsafe or infinite minor units |
| [#56](https://github.com/ktimam/IOU/issues/56) | Closed; failing-first policy hard-caps Propose at one click, extends observation to 60 seconds, and the controlled image lifecycle creates/cleans one source and card | Live journey could retry Propose and create duplicate test cards |

Earlier #1–#7 are closed historical issues; current work did not reopen them.

### OpenChat

| Issue | State/disposition | Subject |
|---|---:|---|
| [#1](https://github.com/ktimam/open-chat/issues/1) | Open tracker | PR 1 |
| [#2](https://github.com/ktimam/open-chat/issues/2) | Open tracker | PR 2 |
| [#3](https://github.com/ktimam/open-chat/issues/3) | Open tracker | Untracked inventory |
| [#4](https://github.com/ktimam/open-chat/issues/4) | Open; fixed in tree | Downloader |
| [#5](https://github.com/ktimam/open-chat/issues/5) | Open; fixed gate | False-green/deps |
| [#6](https://github.com/ktimam/open-chat/issues/6) | Open; fixed in tree | Deletion/IDs |
| [#7](https://github.com/ktimam/open-chat/issues/7) | Open; fixed in tree | Browser integrity |
| [#8](https://github.com/ktimam/open-chat/issues/8) | Open; fixed in tree | Identity/routing |
| [#9](https://github.com/ktimam/open-chat/issues/9) | Open; fixed in tree | Manifest mutation |
| [#10](https://github.com/ktimam/open-chat/issues/10) | Open; fixed in tree | Publish race |
| [#11](https://github.com/ktimam/open-chat/issues/11) | Open; fixed in tree | Name squatting |
| [#12](https://github.com/ktimam/open-chat/issues/12) | Open; fixed in tree | Navigation identity |
| [#13](https://github.com/ktimam/open-chat/issues/13) | Open; current storage fixed, legacy non-empty upgrade fails closed, drain/export/reinstall and live proof pending | Inbox lifecycle/wiring |
| [#14](https://github.com/ktimam/open-chat/issues/14) | Open; fixed in tree | Inference bounds |
| [#15](https://github.com/ktimam/open-chat/issues/15) | Closed duplicate | Inbox; #13 |
| [#16](https://github.com/ktimam/open-chat/issues/16) | Closed duplicate | Link codes; #17 |
| [#17](https://github.com/ktimam/open-chat/issues/17) | Open; fixed in tree | Link-code controls |
| [#18](https://github.com/ktimam/open-chat/issues/18) | Open; fixed in tree | Override fallback |
| [#19](https://github.com/ktimam/open-chat/issues/19) | Open; fixed in tree | Contract/state |
| [#20](https://github.com/ktimam/open-chat/issues/20) | Open; fixed in tree | External provenance |
| [#21](https://github.com/ktimam/open-chat/issues/21) | Open; fixed in tree | Neutral verifier |
| [#22](https://github.com/ktimam/open-chat/issues/22) | Open; fixed in tree | Desktop trust |
| [#23](https://github.com/ktimam/open-chat/issues/23) | Open; inherited debt | Dependency audit |
| [#24](https://github.com/ktimam/open-chat/issues/24) | Open; fixed in tree | Bootstrap/CSP |
| [#25](https://github.com/ktimam/open-chat/issues/25) | Open; fixed in tree | Concurrent confirms |
| [#26](https://github.com/ktimam/open-chat/issues/26) | Open; fixed in tree | Key enumeration |
| [#27](https://github.com/ktimam/open-chat/issues/27) | Open; fixed in tree | Unbounded claim-token state/work |
| [#28](https://github.com/ktimam/open-chat/issues/28) | Open; fixed in tree | Revoke full-map scan |
| [#29](https://github.com/ktimam/open-chat/issues/29) | Open; fixed in tree | Claim Candid/TypeScript drift |
| [#30](https://github.com/ktimam/open-chat/issues/30) | Open; fixed in tree | Public token-bearing traces |
| [#31](https://github.com/ktimam/open-chat/issues/31) | Open; fixed in tree | Payload-bearing endpoint traces |
| [#32](https://github.com/ktimam/open-chat/issues/32) | Open; fixed in tree | Tombstone eviction replay |
| [#33](https://github.com/ktimam/open-chat/issues/33) | Open; bounded migration fixed, live upgrade pending | Monolithic inbox upgrade/expiry scans |
| [#34](https://github.com/ktimam/open-chat/issues/34) | Open; fixed in tree | App-selected inbox routing |
| [#35](https://github.com/ktimam/open-chat/issues/35) | Open; fixed in tree | Silent unacknowledged-action eviction |
| [#36](https://github.com/ktimam/open-chat/issues/36) | Open; full-width primary key fixed, legacy/live upgrade proof pending | Truncated idempotency key |
| [#37](https://github.com/ktimam/open-chat/issues/37) | Open; fixed in tree | Public acknowledgement crypto DoS |
| [#38](https://github.com/ktimam/open-chat/issues/38) | Open; staged keyring fixed, zeroization/rollout/PocketIC pending | Signing-key rotation/keyring |
| [#39](https://github.com/ktimam/open-chat/issues/39) | Open; fixed in tree | Aggregate inbox byte caps |
| [#40](https://github.com/ktimam/open-chat/issues/40) | Open; fixed in tree | Weak AI-app PEM validation |
| [#41](https://github.com/ktimam/open-chat/issues/41) | Open; bounded migration fixed, live upgrade pending | Unbounded/orphaned app-key state |
| [#42](https://github.com/ktimam/open-chat/issues/42) | Open; fixed in tree | Standalone crypto feature unification |
| [#43](https://github.com/ktimam/open-chat/issues/43) | Open; fixed in tree | Unknown-token P-256 amplification |
| [#44](https://github.com/ktimam/open-chat/issues/44) | Open; fixed in tree | Missing PR 1 PubSub event contract |
| [#45](https://github.com/ktimam/open-chat/issues/45) | Open; independent pins and replicated reads fixed, provisioning/live proof pending | Uncertified signature trust root |
| [#46](https://github.com/ktimam/open-chat/issues/46) | Open; fixed in tree | PR 1 candidate formatting gate |
| [#47](https://github.com/ktimam/open-chat/issues/47) | Open; fixed in tree, live proof pending | Cross-language verifier hash |
| [#48](https://github.com/ktimam/open-chat/issues/48) | Open; exact contract fixed, edited final-payload approval and House-only deposit passed locally; import/exact ack deferred | Full-card and final-payload attestation |
| [#49](https://github.com/ktimam/open-chat/issues/49) | Open; immutable reservation and durable semantic outbox fixed in tree, Linux saga recovery proof pending | Confirmation lease/saga mismatch |
| [#50](https://github.com/ktimam/open-chat/issues/50) | Open; source purge fixed and focused tests pass, live upgrade/export proof pending | Historical trace/log retention |
| [#51](https://github.com/ktimam/open-chat/issues/51) | Closed; persisted lifecycle/entropy design and recovery evidence accepted | Snapshot rollback reuses security material |
| [#52](https://github.com/ktimam/open-chat/issues/52) | Open; lifecycle cleanup/caps fixed, upgrade/load proof pending | Capability revocation/retention/quotas |
| [#53](https://github.com/ktimam/open-chat/issues/53) | Open; gated in tree | Direct-chat frontend/backend mismatch |
| [#54](https://github.com/ktimam/open-chat/issues/54) | Open; owner approved, click-only contract fixed, private account-local `Rent` selection passed locally; hosted gates remain | Generic private-context capability |
| [#55](https://github.com/ktimam/open-chat/issues/55) | Open; four-account Type isolation and House-only card routing passed locally; broader release proof remains | Four-account test-mode ownership isolation |
| [#56](https://github.com/ktimam/open-chat/issues/56) | Open; bounded exact/page APIs and compatibility cap fixed in tree, clean app validation/live upgrade pending | Unbounded app-directory query |
| [#57](https://github.com/ktimam/open-chat/issues/57) | Open; count cap fixed, dangling cleanup pending | Unbounded/dangling per-chat app grants |
| [#58](https://github.com/ktimam/open-chat/issues/58) | Open; app-private subject/selector and opaque-handle boundary fixed in tree, Linux/live proof pending | Cross-app identity/key correlation |
| [#59](https://github.com/ktimam/open-chat/issues/59) | Open; gated in tree | Unusable card/no-inbox candidates |
| [#60](https://github.com/ktimam/open-chat/issues/60) | Open; aggregate/prototype/schema limits fixed in tree and focused tests pass, live upgrade pending | Schema/rule/prototype/approval bounds |
| [#61](https://github.com/ktimam/open-chat/issues/61) | Open; fixed in tree, live proof pending | Published revision differs from verifier vow |
| [#62](https://github.com/ktimam/open-chat/issues/62) | Open; pre-await attempts/in-flight throttles and failure-adjacent tests pass in tree, PocketIC pending | Pre-quota card-attestation C2C amplification |
| [#63](https://github.com/ktimam/open-chat/issues/63) | Open; fixed in tree, PocketIC pending | LUI child authority not rechecked after await |
| [#64](https://github.com/ktimam/open-chat/issues/64) | Open; fixed in tree, PocketIC pending | Post-await caller is callee, not ingress user |
| [#65](https://github.com/ktimam/open-chat/issues/65) | Open; bounded clients fixed in tree, PocketIC pending | Unbounded calls into app-controlled canisters |
| [#66](https://github.com/ktimam/open-chat/issues/66) | Open; thread/full-key/legacy/reopen tests pass, PocketIC upgrade matrix pending | Thread root omitted from durable card identity |
| [#67](https://github.com/ktimam/open-chat/issues/67) | Open; one-use GroupIndex authority fixed, multi-shard PocketIC pending | Any LocalUserIndex can assert authority outside its shard |
| [#68](https://github.com/ktimam/open-chat/issues/68) | Open; bounded/set-based fix and boundary tests pass in tree | Quadratic unbounded recipient-key bindings |
| [#69](https://github.com/ktimam/open-chat/issues/69) | Open; timeouts/throttles/durable exact-byte outbox fixed in tree, stopped-inbox/PocketIC proof pending | Unbounded ActionInbox waits and shared call-pool starvation |
| [#70](https://github.com/ktimam/open-chat/issues/70) | Open; complete dedicated v4 binding fixed, Linux/live interop pending | Missing action-signature protocol/routing domain separation |
| [#71](https://github.com/ktimam/open-chat/issues/71) | Open; fixed and tested on clean pushed PR1 candidate, hosted CI pending | Stale and unbounded native model cache |
| [#72](https://github.com/ktimam/open-chat/issues/72) | Closed; persisted lifecycle/watchdog recovery accepted | Lost `raw_rand` callback permanently wedges the entropy gate |
| [#74](https://github.com/ktimam/open-chat/issues/74) | Closed; controller/time harness corrected and passing evidence recorded | Entropy snapshot drills use the wrong controller and never advance watchdog time |
| [#75](https://github.com/ktimam/open-chat/issues/75) | Closed; live canister version replaced by persisted lifecycle id | Live canister version is not a stable lifecycle epoch |
| [#76](https://github.com/ktimam/open-chat/issues/76) | Closed; migratory task handling corrected for clean/checkpoint dependency sets | Async entropy and delivery jobs use non-migratory spawn |
| [#77](https://github.com/ktimam/open-chat/issues/77) | Closed; persisted-test-mode fix pushed, 89/89 per worktree, `8ae34cf38` child deployment and live flow passed | Backend gates block approved private context and edited confirmation |
| [#78](https://github.com/ktimam/open-chat/issues/78) | Closed; generic retry fix/tests pushed in clean `f93bffe0a` and checkpoint `4eed022b8`; delayed-listener and live flows passed | One-shot card bootstrap races external-app listener startup |
| [#79](https://github.com/ktimam/open-chat/issues/79) | Closed; clone-safe bridge fix/tests pushed in clean `68aadfd35` and checkpoint `790bb76d0`; capability-bearing live flow passed | Svelte capability proxy crashes private-context `postMessage` |
| [#80](https://github.com/ktimam/open-chat/issues/80) | Open; generic exact-token cancellation fix/tests pushed at `dda2833d6`, live proof pending | Closing link consent removes an installed app key and forces repeated Connect |
| [#81](https://github.com/ktimam/open-chat/issues/81) | Open; authorization fix and focused Group **3/3** plus Community **3/3** are green in exact pushed PR 2 head `16080b078`; deployment pending | Setup-token mint bypasses private-channel and verified-member authorization |
| [#82](https://github.com/ktimam/open-chat/issues/82) | Open; early admission, bounded reservation, and exact cancellation are green in exact pushed PR 2 head `16080b078`; deployment pending | Rejected mint calls amplify work and post-await failures orphan tokens |
| [#83](https://github.com/ktimam/open-chat/issues/83) | Open; sensitive-transport redaction is green (**3/3**, included in final frontend **958/958**) at exact pushed PR 2 head `16080b078`; deployment pending | Chat-link bearer leaks through frontend transport diagnostics |
| [#84](https://github.com/ktimam/open-chat/issues/84) | Open; pre-consent redaction and actual-URL sink separation are green (**3/3**) at exact pushed PR 2 head `16080b078`; live backend redemption/deployment pending | Consent UI renders the live bearer before handoff |
| [#85](https://github.com/ktimam/open-chat/issues/85) | Open; immutable validated surface snapshot is green in the full resolver file (**32/32**) at exact pushed PR 2 head `16080b078`; deployment pending | Async manifest mutation can redirect a minted bearer |
| [#86](https://github.com/ktimam/open-chat/issues/86) | Open; initiating app/canonical-chat binding is green (**3/3**) at exact pushed PR 2 head `16080b078`; deployment pending | Pair-first setup can mint for the wrong chat after navigation |
| [#87](https://github.com/ktimam/open-chat/issues/87) | Open; inherited dependency baseline, unchanged by PR 1/PR 2, requires a separate maintenance PR and clean-install reachability gates | Wallet dependency pins vulnerable Axios and an invalid Base account version |
| [#88](https://github.com/ktimam/open-chat/issues/88) | Open; alias fix remains in final pushed PR 1 head `f43d2a2d5`; five focused web/model/on-device files pass **145/145** and typecheck reports **0 errors** | Clean agent typecheck depends on a removed package artifact |
| [#89](https://github.com/ktimam/open-chat/issues/89) | Open; 19 source aliases fixed at exact pushed PR 2 head `16080b078`; frontend **958/958**, Svelte **0 errors/565 warnings**, agent typecheck green, and Linux production gate exit **0**; deployment pending | Clean frontend gates resolve card code through removed package artifacts |
| [#90](https://github.com/ktimam/open-chat/issues/90) | Open; six suites use source-relative paths at exact pushed PR 2 head `16080b078`; root-command proof **44/44**, included in **958/958**, and Linux production gate exit **0**; deployment pending | Source-inspection tests fail under the documented root command |
| [#91](https://github.com/ktimam/open-chat/issues/91) | Open; generic desktop `open_url` fix is committed in exact pushed PR 2 head `16080b078`; pre-rebase plugin **17/17** remains applicable by exact tree equivalence and Linux production gate exits **0**; deployment pending | Desktop external-app bridge is unimplemented |
| [#92](https://github.com/ktimam/open-chat/issues/92) | Open; fixed and pushed in final PR 1 head `f43d2a2d5`; exact WSL `prod_test` passed in **10m36s** with byte-identical **7,656,521-byte** Wasm SHA-256 `4197ce6d…a0cfa` and zero unresolved Wllama references; deployment pending | Production build cannot resolve Wllama `?url` asset import |
| [#99](https://github.com/ktimam/open-chat/issues/99) | Closed; optimistic sender events converge to backend-attested identity without persisting ephemeral confirmation material; focused/full/live gates pass | Successful sends stayed locally unverified |
| [#100](https://github.com/ktimam/open-chat/issues/100) | Closed; app identity re-resolves across optimistic→verified hydration; mounted and live transition coverage pass | Card identity was not re-resolved after hydration |
| [#101](https://github.com/ktimam/open-chat/issues/101) | Closed; attested isolated frames use neutral copy and genuine trust warnings remain | Fully attested cards were labeled untrusted |
| [#102](https://github.com/ktimam/open-chat/issues/102) | Closed; generic image sanitizer/gate coverage, IOU schema/attester coverage, active manifest read-back, and complete signed-in image lifecycle pass | Image proposals forwarded schema-invalid fields into exact app attestation |
| [#103](https://github.com/ktimam/open-chat/issues/103) | Closed; exact fresh proposer card auto-loads under strict ephemeral attestation while recipient/history/reload paths stay gated; mounted/full/live gates pass | Freshly proposed attested cards required redundant external-origin consent |

## Historical release recommendation

The 2026-08-07 setup-token revision is not represented by the older preserved deployment below.
PR 2's exact pushed post-rebase head is
`16080b0780ed97c3cd63d4187188ac04b19b3769` and includes #91's committed generic desktop
bridge. Its exact-blob Linux `prod_test` exits **0** (Rollup **11m46.9s**, wrapper **716s**);
the emitted **7,656,521-byte** Wasm is byte-identical, referenced, and SHA-256
`4197ce6d3dc9240c42ee52b4197dc99638875a06b0083901f8a57767338a0cfa`, with zero
unresolved Wllama references. The exact-Git-blob plus canonical
`OC_WEBSITE_VERSION=1.0.0` retry addresses only the CRLF/environment wrapper; baseline
`porto`/`accounts` notices and the nonfatal public-key CRLF warning remain out of scope. Next,
upgrade the OpenChat token producer before the IOU consumer, upgrade IOU without resetting state,
and run live redemption through pending-row assignment plus the Father two-chat/two-sheet journey.
The successful local-only Father **Open setup** → **Open in browser** handoff opened a distinct
Father-profile window, reached the exact `/settings#openchat-routing` route after fragment scrub,
rendered signed in, and left the default browser unchanged. The excluded debug profile override is
neither PR 2 nor deployment, redemption, or assignment evidence.

PR 1's #92 source/build blocker is resolved and pushed at exact head
`f43d2a2d53f2c9f8a3086104a356d4d3a315858a`. Five focused web/model/on-device files pass
**145/145**, typecheck reports **0 errors**, and exact WSL `prod_test` completed in **10m36s**
with a byte-identical **7,656,521-byte** Wasm at SHA-256
`4197ce6d3dc9240c42ee52b4197dc99638875a06b0083901f8a57767338a0cfa` and zero
unresolved Wllama references. PR 1 deployment remains pending.
IOU #51's final source gates pass, but it still requires an exact hash/push and preserved-state
deployment before the synchronous scrub can be called shipped. Do not infer either final head from
the earlier recorded hashes.

Do not promote to production solely because local checks and the preserved checkpoint/child
deployment pass. The local real-card `Rent` smoke against generic PR 2 #77/#78/#79 passed through
House-only deposit; the draft is intentionally pending user review and is not claimed as imported
or acknowledged. IOU #45–#49 are committed/pushed; #49's backend and matching local frontend are
deployed, all four bindings are relinked, and post-upgrade card-context redemption passed. Next run
pinned hosted CI and Linux PocketIC, exercise fresh install and disposable upgrades, test
all four durable named profiles across restarts and same-profile principal switching, and complete
production key/Android drills.

Submit only the two clean OpenChat candidates, never either broad preservation worktree. Draft PR 1
#9132 and stacked draft PR 2 #73 are open. PR 1's final source head is recorded and pushed at
`f43d2a2d5`; deployment remains. Generic #77/#78/#79 are contained in PR 2; keep IOU #45–#51
in IOU. PR 2's exact final head is pushed and its Linux production gate passes; rerun the
four-profile browser flow and obtain hosted CI before presenting either PR as production-ready.
