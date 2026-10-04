# Unofficial OpenChat client: consolidation and release plan

Historical assessment date: 2026-09-21. This is the original plan; implementation is now active.
The September 26 implementation checkpoint is historical. For the current encrypted
delivery, persistent sender cards and verified browser workflow, see
[the private import guide](openchat-private-import.md).
The old checkpoint's plaintext/memory-only design is superseded. Current web and
local-test APK builds do not by themselves satisfy the release gates below.

## Decision and boundary

Maintain one active development branch, `main`, in `ktimam/open-chat`. Track upstream
OpenChat's `master` through regular reviewed merges. Release a clearly unofficial web
client and Android client using the official OpenChat chat/identity services.

Target **zero new OpenChat backend canisters and zero changes to official OpenChat
backend services**. Static HTTPS hosting is sufficient for the web client; an asset
canister is optional, not required. IOU remains a separately authenticated application.
Reuse its existing deployment and encrypted entry APIs where feasible. If no production
IOU deployment exists, that app still needs its own deployment; this assessment did not
verify IOU's production deployment state.

This is not a build-flag change. PR2 currently depends on backend APIs and message types
which the upstream backend does not have. Preserve its user-facing workflows by replacing
those dependencies, not by pretending missing authorization/verification succeeded.

Full protocol-level parity is impossible under the unchanged-backend constraint:
official clients cannot acquire our shared interactive cards, and the fork cannot
manufacture authoritative OpenChat app attestations or chat-membership proofs.

## Verified source inventory

Read-only remote checks on September 21 found:

| Reference | Commit | Meaning |
| --- | --- | --- |
| Upstream `open-chat-labs/open-chat:master` | `a7058da3a26a7f9773a3e8eadc79ff7f33e44b53` | Latest checked upstream tip |
| Fork `ktimam/open-chat:master` | `05ec432cb34ba87aa09a417f008dff3f294a6595` | Current fork default; 307 commits behind checked upstream |
| Fork `codex/pr1-local-models` | `e8fb7ed4a7e38204bba775800ba219432f9d3c1a` | Latest published model slice |
| Fork `codex/pr2-app-chat-interfaces` | `0bf6a357ec45fec3bdeb958c7f224e8780e0d9bf` | Latest published combined stack |

PR1 is already an ancestor of PR2. PR2 adds 83 commits over PR1; merging every old
feature branch again would duplicate historical implementations. The combined stack's
upstream baseline is `df9d9ed52`; current upstream is 121 commits ahead of that baseline.
Refresh these pins immediately before implementation; they are not moving release targets.

At that assessment, the combined PR2 reconciliation worktree was the authoritative
local source. Older checkpoint/submit worktrees contained uncommitted changes and
experiments; they were preservation/comparison sources, not the default integration base.

Important preservation findings from that assessment:

- Latest PR2 worktree has 15 pre-existing tracked deletions, described as unrelated in
  existing release records. Do not automatically include them.
- A bounded Git inventory reported 127 missing/unreadable feature-history objects,
  including four current-tree blobs. Existing worktree source survives in at least one
  checked case. Use a fresh trusted clone and verify it before merging; do not reset or
  delete these working copies to repair the problem.
- Preserve the five untracked `fork-notes` documents and compare older dirty changes
  against the September stack. Include only intentional missing work.
- The separate local runtime directory held credentials/profiles, not the latest source
  repository. Keep runtime directories out of source-control publication.
- IOU `main` also has uncommitted currency-conversion work. Preserve and review it
  independently; do not mix it into an OpenChat merge accidentally.

## Feature disposition

| Feature | Release approach with official backend unchanged |
| --- | --- |
| Normal chat, media, groups, channels and existing account identity | Use current upstream client protocol and production services; verify against the actually deployed version, not only Git HEAD |
| Both UI versions and Android model settings | Consolidate the latest shared implementations and test equivalent behavior |
| Qwen/Gemma all-WebGPU inference, cache retention, optional audio | Retain PR1 runtime; no OpenChat canister required |
| Configurable model catalog | Use bundled/importable/HTTPS configuration; do not depend on the added Registry `model_catalog` endpoint |
| `/ai`, image/text processing, suggestion chips | Keep client-side; explicitly review automatic chat-posting behavior and disclose/control sharing |
| App directory and prompt/schema configuration | Versioned fork/user-trusted catalog, with pinned package identities; not an official OpenChat-published app directory |
| Per-chat app enablement | Account/device-local preference initially; not a server-enforced group-wide admin setting |
| Single/multiple-entry proposals and editing | Private local drafts, never custom ActionCard messages on the official backend |
| App-owned OCR, normalization and model-specific prompts | Preserve ownership in IOU/app packages; host exposes only generic contracts |
| IOU connection, saved Types and sheet selection | Separate IOU authentication; fetch/decrypt permitted app data under that identity, without custom OpenChat capability methods |
| Confirmed delivery | App-owned authenticated handoff/submission using existing IOU encrypted entry/batch APIs where suitable; verify replay/idempotency and failure recovery |
| Shared results | Optional explicitly approved ordinary message/link; not a universally interactive or server-attested card |
| Shared pending/confirmed/cancelled card state, authoritative app provenance, chat-member key fan-out | Cannot retain existing semantics without backend cooperation; replace explicitly or leave unavailable |

Removing an unsupported call must not grant its former privileges. In particular, do
not set `appVerified`/`appContentVerified` to true or open production by enabling the old
local-only flags. A local draft needs its own type, lifecycle and authority model.

## Privacy architecture for the replacement

Before confirmation, the proposal flow must not transmit the selected source content
or extracted draft off-device. This is a target to implement and test, not a current
guarantee. Existing chat synchronization and user-requested model/package downloads are
separate network activity; do not claim the whole client is offline.

1. OpenChat performs local inference/OCR using an app-provided prompt/schema.
2. App-owned processing runs through a constrained local interface. Do not give drafts
   to a remotely hosted iframe before consent. A JavaScript Worker or iframe alone is
   not a no-network security boundary. If executable processors are needed, define and
   test an isolated runtime with restricted imports/capabilities and resource limits.
3. A host-controlled renderer builds the draft from one canonical payload and a trusted
   declarative UI definition. No independently supplied hidden submission values.
4. Review shows all outgoing fields, app/destination and recipients. Changes invalidate
   approval. Model output is data, never authority or executable instructions.
5. After explicit confirmation, OpenChat MUST encrypt the exact fields on-device to
   the connected user's authenticated public delivery key BEFORE any relay, native IPC,
   loopback or app handoff. No plaintext fallback or plaintext card-verification request.
6. IOU decrypts locally using that user's recovered private delivery key, checks the
   bound receiving account/sheet, and presents a second unsaved review. Only explicit
   Save encrypts the final entry with the separate sheet key for existing backend APIs.
   The old September 26 plaintext handoff did not satisfy this requirement; its tests
   and encrypted-save evidence cannot be used as encrypted-delivery acceptance.
7. Approved 2026-10-01: persist the active private card encrypted on the same device,
   isolated by OpenChat account/backend. Never persist approval tokens or automatically
   send after restore. Keep attempted-state/request-ID write-ahead for duplicate safety.
   See [the receiver workflow](openchat-private-import.md) for the updated contract.

Keep IOU business rules, saved-Type semantics, dates, currency policy and prompts in IOU,
not OpenChat core. Private local drafts are not synchronized chat records. Account changes,
logout, retention, deletion and local-storage protection need explicit behavior.

Local app association does not prove an official OpenChat user's identity or membership
to IOU. Do not use a frontend-supplied chat/user ID as authorization. The initial design
routes the authenticated IOU user's own actions; cooperative/shared authority is separate.

## First release gate: authentication from our own origin

Existing account continuity is assumed required. A new domain does not automatically
inherit `oc.app` passkeys or Internet Identity's derived principal.

Live public checks on September 21 found only the official browser origins in
`oc.app/.well-known/webauthn` and `oc.app/.well-known/ii-alternative-origins`.
Android credential sharing is pinned to named official packages/signing certificates.
Do not impersonate those origins/packages or disable credential checks.

The current upstream source contains `create_account_linking_code`,
`verify_account_linking_code` and `finalise_account_linking_with_code`. The combined
client already has an Android code-linking flow. First prove that a fork-owned RP/domain
and separately signed APK can use this supported flow to attach to an existing account,
then sign in again after restart. This source evidence is not production acceptance.

If supported account linking cannot meet the requirement in production, stop before
large-scale release work. Options then require an explicit decision: upstream origin
cooperation, a different supported login route, or a changed account-continuity requirement.

Do not silently choose a different Internet Identity derivation origin and create a
different account. OpenChat account linking and IOU app linking are separate mechanisms.

## Consolidation sequence: one active branch

1. **Preserve and inventory.** Save dirty work and notes without publishing credentials,
   real test images or runtime profiles. Record intended versus incidental deletions.
2. **Fresh source and integrity.** Clone trusted fork/upstream into the chosen permanent
   project location, verify object availability, and pin the above references. No new
   permanent source checkout under a temp directory.
3. **Create fork `main` from latest combined PR2.** PR1 is already present. Preserve old
   branch tips as archival references; no force-push or history rewrite is required.
4. **Merge pinned upstream `master` into `main`.** Reconcile current frontend, generated
   agent/protocol code, both UIs, Android and build tooling deliberately. Current upstream
   includes substantial user-canister evolution; textual conflict resolution is not a
   compatibility test.
5. **Remove the custom-backend dependency from the active product.** Implement local
   catalogs/drafts and the app-side route. Restore active OpenChat backend/API definitions
   to the upstream baseline where feature code added new protocol. Keep historical PR
   implementations recoverable in history/archives, not as accidentally enabled release paths.
6. **Recover intended missing work.** Compare dirty old worktrees/notes with the consolidated
   feature checklist; port only needed changes once. Include the existing startup, media,
   model-cache and mobile-layout regressions.
7. **Publish only after gates pass.** Push `main`, make it the fork default, point CI/releases
   to it, and stop ongoing development on the old PR branches. Keep them temporarily as
   read-only archives; delete only after an explicit preservation review. IOU continues on
   its own `main` because it is a separate repository.

Future upstream merges land on the same fork `main`, with release tags for rollback.
Do not merge every old checkpoint branch or copy the live runtime over the latest source.

## Packaging and deployment work

- Give the client distinct unofficial name, icon, APK application ID and release signer.
  Keep the signing key out of the repository and define update/rollback ownership.
- Pin all resolved production canister IDs and service URLs in a release configuration.
  `OC_DFX_NETWORK=ic` alone is insufficient: existing environment values can override
  defaults and retain local canister IDs. Inspect the built artifacts too.
- The latest sideload Android configuration already disables official OTA replacement
  and ignores old cached UI under that policy. Retain this protection. Any future fork
  updater must use our own authenticated update channel, never the official UI bundle feed.
- Browser service-worker/cache scope and APK cache migration must not mix local-testing,
  official and fork assets. Explain migration instead of silently copying credentials.
- Native push depends on the official notification infrastructure/Firebase configuration.
  Qualify a supported arrangement or clearly disable unsupported native push initially;
  do not bundle private keys or assume a new Firebase project works with the old pusher.
- Reuse bundled small Qwen all-q4 and Gemma configuration, direct verified source downloads
  and optional audio. Do not restore retired mixed weights or add model hosting by default.
- Review source availability, notices and distribution obligations for the upstream AGPL
  license and the shipped model/runtime packages; distinguish the product from official
  OpenChat. This is a release checklist item, not a legal clearance statement.
- Retain the previously deferred scoped advisory record. No broad OpenChat core audit is
  part of this plan; review feature/release exposure and any newly introduced dependencies.

## October 4 local-test IOU advisory deferral

On 2026-10-04 the user explicitly chose to defer the following newer findings
recorded by [IOU run 37188618011](https://github.com/ktimam/IOU/actions/runs/37188618011)
for the unofficial **local-test** release. This records that decision; it does
not rerun the audit or assert that the findings are harmless.

| Recorded package/version | Recorded advisory IDs |
| --- | --- |
| Hono 4.12.34 | [GHSA-gqvv-2mrq-wpjv](https://github.com/advisories/GHSA-gqvv-2mrq-wpjv); [GHSA-g6gw-c38x-mqfc](https://github.com/advisories/GHSA-g6gw-c38x-mqfc); [GHSA-crvj-82cr-hjcx](https://github.com/advisories/GHSA-crvj-82cr-hjcx); [GHSA-hxh3-vqpv-xpqv](https://github.com/advisories/GHSA-hxh3-vqpv-xpqv) |
| ip-address 10.4.0 | [GHSA-rpw4-54j3-4h4q](https://github.com/advisories/GHSA-rpw4-54j3-4h4q); [GHSA-2vr4-cq9g-pvrc](https://github.com/advisories/GHSA-2vr4-cq9g-pvrc); [GHSA-j6r3-76f7-8jcv](https://github.com/advisories/GHSA-j6r3-76f7-8jcv); [GHSA-h3mg-xc3c-68pw](https://github.com/advisories/GHSA-h3mg-xc3c-68pw) |
| fast-uri 3.1.7 | [GHSA-hrr3-gc8f-f4qj](https://github.com/advisories/GHSA-hrr3-gc8f-f4qj) |
| brace-expansion 2.1.4 / 5.0.9 | [GHSA-q2hr-2g5m-vwhr](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr); [GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7); [GHSA-6j4f-fj2g-mc7p](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p) |

The brace-expansion row groups the versions and IDs recorded in that report;
it does not assert every possible version/ID combination. The decision is limited
to the recorded finding set, not future findings, versions or advisories.
`brace-expansion` is a different package from OpenChat's separately deferred
`braces`; previous OpenChat Rust/braces and earlier IOU decisions remain unchanged.

Reachability and exploitability in the deployed IOU paths are not established by
this decision. Dependency presence does not prove exposure or non-exposure.
The findings stay open and disclosed, but no longer require a local-test approval
decision. The original hosted audit job remains failed; downstream typecheck,
coverage, card UI, build and Rust jobs skipped behind it remain skipped. Separate
local functional passes do not convert those hosted outcomes into passes.

No package was upgraded, no new audit or query was run, and no CI gate, exception,
suppression or security policy was changed. This does not approve a public or
production release. Model/browser acceptance and the existing phone, optional
voice and public-release deferrals remain separate.

## Acceptance gates

1. **Backend compatibility:** requests use only supported official APIs; no `ai_apps`,
   `register_ai_app`, provenance, app-key, capability, ActionInbox or custom ActionCard
   requests reach official OpenChat. Missing custom APIs must not break chat startup.
2. **Account continuity:** existing account, chats and media survive supported linking,
   reload, logout/login and APK updates. Test browser and final signed APK on their final
   origin/RP, with explicit consent for any production account mutation.
3. **Privacy:** use synthetic marker data and instrument browser/native network paths.
   Propose, local normalization, review, cancel and failure must not transmit the marker;
   confirm sends only recipient-encrypted approved fields, never plaintext. Include adversarial processor/UI packages,
   hidden fields, changed destinations, source echo, telemetry and late callbacks.
4. **Models:** Qwen/Gemma, both UI versions, optional audio enabled/disabled, text/images,
   OCR-only/model-only/verification modes, fresh downloads, retained-cache switching and
   repeated image inference. Preserve app-owned image expectations and known limitations.
5. **IOU:** correct amount/date/note/type/direction, multiple entries, manual edits, reconnect
   without re-inference, private account routing, retries and duplicate prevention. A
   successful local draft is not successful persisted delivery.
6. **Platform:** desktop browser, Android browser, emulator UI/auth/install checks and
   physical-phone WebGPU checks. Emulator startup alone does not establish GPU inference.
7. **Release artifact:** exact source commit, reproducible configuration, signer, worker/
   model asset integrity, no development identifiers/secrets, no official OTA replacement,
   startup performance and the normal upstream client smoke suite.

Historical PR CI and phone results remain evidence for their exact prior artifacts. They
do not qualify the newly merged, rebranded, production-connected fork release.

## Recommended execution order and unresolved choices

First: preserve source, obtain a clean checkout, and prove existing-account sign-in.
Second: consolidate `main` with upstream and retain the model-only experience.
Third: replace PR2 backend dependencies with private drafts and IOU-side delivery.
Fourth: qualify both UIs and the production-configured signed APK, then publish.

Choose the permanent fork checkout, public domain/RP, unofficial product name, APK identity
and signing/update policy before packaging. Decide whether local-only draft/app preferences
are acceptable for the first release; cross-device synchronization is a separate feature.
If original shared-card semantics are mandatory, the zero-backend-change target must be
revisited rather than hidden behind a frontend compatibility switch.

No merge, fetch, branch/default change, deploy, account linking or release build was performed
by this assessment. Only source inspection, read-only remote/public metadata checks and this
plan document were produced. Implementation duration should be estimated after the login
spike and clean merge expose the actual blockers, not from the former PR test status.

## Evidence references

- [Upstream at assessed commit](https://github.com/open-chat-labs/open-chat/tree/a7058da3a26a7f9773a3e8eadc79ff7f33e44b53)
- [Upstream UserIndex API](https://github.com/open-chat-labs/open-chat/blob/a7058da3a26a7f9773a3e8eadc79ff7f33e44b53/backend/canisters/user_index/api/can.did)
- [Existing account-link completion API](https://github.com/open-chat-labs/open-chat/blob/a7058da3a26a7f9773a3e8eadc79ff7f33e44b53/backend/canisters/identity/api/src/updates/finalise_account_linking_with_code.rs)
- [Combined feature source](https://github.com/ktimam/open-chat/tree/0bf6a357ec45fec3bdeb958c7f224e8780e0d9bf)
- [Model catalog design](https://github.com/ktimam/open-chat/blob/0bf6a357ec45fec3bdeb958c7f224e8780e0d9bf/docs/webgpu-model-catalog.md)
- [Local-only app release gates](https://github.com/ktimam/open-chat/blob/0bf6a357ec45fec3bdeb958c7f224e8780e0d9bf/frontend/app/src/utils/aiActionAvailability.ts)
- [Public WebAuthn origin declaration](https://oc.app/.well-known/webauthn)
- [Public II alternative origins](https://oc.app/.well-known/ii-alternative-origins)
- [Public Android credential associations](https://oc.app/.well-known/assetlinks.json)
- [Upstream license](https://github.com/open-chat-labs/open-chat/blob/a7058da3a26a7f9773a3e8eadc79ff7f33e44b53/LICENSE)
