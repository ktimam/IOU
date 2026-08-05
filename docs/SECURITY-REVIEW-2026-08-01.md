# IOU and OpenChat fork security review — 2026-08-01

## Executive result

The complete application-owned IOU codebase and documentation were reviewed, together
with only the changes authored by `ktimam` in the two local OpenChat forks and the
related Claude chat history. Upstream OpenChat code was followed only where a
fork-authored change altered its trust boundary.

The review found critical key-lifecycle defects, authorization and storage-exhaustion
risks, browser-session data separation defects, relay and mobile trust-boundary issues,
and test gates that could report false success. Every directly remediable IOU source
finding listed below has a fix and failing-first plus adjacent regression coverage in
the current working tree. Cross-process consumer-key mutation ordering is now guarded by
a canister-owned stable epoch/tombstone (#39). The GitHub issues intentionally remain open until the changes are
reviewed, committed, exercised in hosted CI, and validated against a live replica and a
real upgraded canister.

OpenChat must be upstreamed as exactly two independent, generic pull requests:

1. optional on-device inference and local-model management; and
2. generic in-chat cards and the interface between chats and external applications.

PR 1 passed its original local security gates, but the continuation review found an
unbounded, path-only native model cache (#71); its content-addressed bounded replacement
and final revalidation are recorded below. PR 2 fixes substantial registry, link, inbox,
key-lifecycle and delivery defects, but is not ready to ship. IOU now
independently attests the exact displayed card and the exact final confirmation payload
for #48, and the product owner approved that narrow attestation flow plus #54's one-time
private-context capability. The generic OpenChat backend/frontend candidate carries those
contracts, but every runtime activation switch remains false while durable confirmation,
bounded-call, signing-trust, stable migration and PocketIC gates remain open. The private
Type display is a required acceptance criterion, not permission to republish Type metadata;
it may appear only inside the authorized app iframe and leaves it only as an opaque encrypted
reference. Additional open architecture and release findings are tracked through #71.
Neither PR may include IOU-specific runtime behavior, fixtures, prompts, URLs, identifiers,
canister WASM, or documentation.

This is a source and local-verification review, not a proof that no other vulnerability
exists.

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
context and display the linked account's Type. Every OpenChat activation switch remains false, so
the currently running backend does not yet exercise that path.

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

Issue #51's source gate is also implemented across UserIndex, LocalUserIndex, and GroupIndex. A
persisted, purpose-separated entropy root is unavailable until fresh management-canister `raw_rand`
arrives. The canisters observe their monotonic canister version before every security output; a
version change invalidates restored short-lived bearers/authorities and requires a fresh seed before
issuing link, provenance, capability, grant, signature/key-stage, ECIES, acknowledgement, or
GroupIndex authority material. This uses the IC rule that loading a snapshot increments the target
[canister version](https://docs.internetcomputer.org/references/ic-interface-spec/abstract-behavior/).
Executable local state-machine tests replace the ignored rollback fixtures, but the real
stop/snapshot/issue/load/reseed sequence must still run in Linux PocketIC and a disposable deployment.

This continuation also found an upgrade-compatibility release gate during the final audit:
the exact committed pre-PR2 heap schema is now decoded, empty state upgrades while preserving
`next_id`, and non-empty actions/replay state traps with an explicit migration-required error
instead of being dropped or fabricated. Those records lack the fields needed to construct valid v4
records, so deployment requires a reviewed export/reinstall decision rather than a guessed
conversion. Older stable records now default a missing additive acknowledgement hash to empty and
remain readable but cannot authorize deletion or pass current v4 verification. The source outbox,
reseed and correlation mechanisms are implemented, but their missing real
confirmation→deposit→replicated-read→IOU import→exact-ack, snapshot-load, stopped-canister, and
upgrade runtime chains keep PR 2 and every feature switch blocked.

No backend canister was deployed or upgraded. The current local backend therefore cannot be used
as evidence for these source fixes. Windows can compile the integration target, but the repository's
PocketIC server is a Linux ELF executable; the runtime chain must run in Linux CI and against a
disposable live upgrade before activation.

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
  candidate implement those narrow contracts, but every runtime switch remains false pending the
  durable inbox/saga, bounded-call, signing-trust, Candid, PocketIC and live four-profile gates. The
  public leak is fixed independently.
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

The final 2026-08-05 IOU verification passed `pnpm test` with **67 files and 819 tests**,
`pnpm typecheck`, `pnpm build`, and all **48/48** Rust canister tests. This is the current
post-correlation source evidence. It includes the final
session, disconnect, cross-process stale-epoch, two-device ordering, ABA,
multiple-orphan-upload, terminal-import, StrictMode, cross-deployment cleanup, inbox
exact acknowledgement, signed-delivery replay/locator replacement, keyring substitution and
verify-only cutoff, stale manifest-route race, deployment-owned manifest,
manifest-icon validation, private account-type visibility, exact card-context binding, encrypted
type-reference isolation/tamper, strict v4 ActionInbox decoding, and key-lifecycle regressions.
The instrumented security-critical coverage below is an earlier checkpoint that includes the
private card-context and account-type display/import additions, exact initial/final OpenChat
card-attestation wire, ActionInbox protocol correction, and Hono advisory pin. Coverage was not
rerun after the final correlation changes and must not be presented as the final 819-test run.

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

The final continuation used isolated `C:\tmp` targets for PR 1 native tests, PR 2
unit/WASM and integration compilation, and the IOU/opaque-handle suites. After each
owning validation completed, those exact five targets were resolved, checked, and
removed, reclaiming another **21.21 GiB**. The tiny untracked PR 1 `.vite` cache was also
removed. The final measured free space on drive C was **66.94 GiB**. Active frontend
outputs, source/untracked PR material, repository-local IOU history, browser profiles,
and replica/canister state were preserved.

After the final declaration/card changes, the IOU and safe fail-closed OpenChat Vite
processes were restarted from the current source. IOU on port 3000, OpenChat on port
5003, and the preserved local replica status endpoint on port 8080 each returned HTTP
200. Browser profiles, local storage, canister state, backend WASMs, feature switches,
and the father/mother/child/property-manager account model were not reset. No OpenChat
canister upgrade was deployed: the new backend source remains uncommitted,
deployment-gated, and without the required PocketIC attestation-chain coverage. This
frontend health check is not live proof of the backend fixes or visible Type; the
running card still fails closed.

## IOU residual release boundaries

1. Historical plaintext closing data can remain in old stable bytes/backups.
2. The 10,000-record fallback needs an indexed migration before that population.
3. Dev P-256 member replacement still needs per-sheet historical rewrap to match
   production vetKD. This does not affect recreation of the four local accounts.
4. Production-web restoration requires a live authenticated canister/vetKD path.
5. Verified HTTPS mobile association, real Android signing, live replica E2E, upgraded
   canister tests, and recovery drills remain release gates.
6. The new #39 stable epoch must still be exercised by an in-place canister-upgrade/live
   two-agent drill, including the backend-first breaking-Candid rollout and a cached old
   PWA; unit state-machine and stable-map reopen coverage pass locally.
7. The replicated ActionInbox read and exact acknowledgement flow (#40/#41) still require
   a live multi-page/retry/redeploy drill against rebuilt OpenChat canisters.
8. Production must provision and rotate the #42 allowlist of dedicated v4 signing-key ids
   through an independently authenticated release channel. UserIndex keyring discovery is
   not a remote trust root; the empty-allowlist exception is exact-loopback development only.
9. Fixes are uncommitted; issues remain open until review and CI.
10. The owner approved the exact full-card/final-payload attestation and one-time
    viewer/card/recipient-key-bound private capability, and both generic/client contracts
    are implemented locally. Activation remains disabled until the remaining OpenChat
    architecture, Candid, PocketIC, signing-trust and live four-profile gates pass. Until
    then the deployed OpenChat card cannot load the private Type roster, even though IOU's
    renderer and cryptographic import path are complete and tested.

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

Latest PR 1 worktree evidence: the app TypeScript check passed, nine focused Vitest files passed
143/143, and the default-feature native plugin passed 14/14. Earlier same-day #71 evidence remains
focused cache lifecycle 15 passed with three explicit fixture ignores, full inference 28 passed with
four explicit fixture ignores, and pinned TinyLlama real inference exactly 1/1. The shipping
`inference,store` feature check passed
with five pre-existing warnings (three deprecated llama APIs and two unused legacy finder
helpers). The external Tauri/TypeScript contract did not change, so the prior app/shared/plugin
TypeScript checks and zero changed-path Svelte diagnostics remain applicable. The
non-mutating formatting gate
passes all 24 human-maintained candidate source/config files and records nine explicit
generated/legal exclusions. SBOM generation previously produced 556 components and
694,546 bytes with no local paths; Windows compile, Cargo formatting and diff checks
passed. The worktree CI/format/license policy records 15 package licenses, pins Node 24.18.1, and
passes through 2026-08-31. It is not yet an upstream-PR baseline: it compares against old base
`05ec432`, local `upstream/master` has moved, and the browser `@wllama/wllama` dependency must be
audited and reflected in the reconstructed lockfile, license record, and SBOM. Regenerate the policy
against the fetched clean PR 1 base. The repository-wide Svelte baseline remains 338 errors/554
warnings outside the fork-changed surface.

The current worktree npm audit reports 71 production findings (11 low, 43 moderate, 16 high,
1 critical) and 124 including development dependencies (14 low, 44 moderate, 60 high, 6 critical).
The present policy describes those as inherited, but final ownership depends on the clean PR 1
dependency diff. Inherited RustSec is 19 vulnerabilities/39 warnings, with
zero introduced. The baseline expires 2026-08-31 (#23); 15 introduced Rust packages
have exact source/version/license records.

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
- **#51:** UserIndex, LocalUserIndex, and GroupIndex persist a canister-version-aware,
  `raw_rand`-seeded entropy gate. Security outputs fail closed until ready; a version change clears
  restored short-lived bearers/authorities and forces a fresh seed, while purpose/counter separation
  prevents reuse inside one epoch. Local state-machine rollback tests pass; actual snapshot-load and
  failed-`raw_rand` recovery remain Linux/live gates;
- **#47/#61:** portable explicit manifest/card encodings replace raw Candid hashing,
  frozen cross-language vectors detect drift, and publication preserves the exact
  manifest revision vouched by the app canister;
- **#48/#54:** the backend recomputes and stores an exact full-card content hash, accepts
  the verified bit only after an exact registered-app echo, and requires a separate final
  grant for the exact edited confirmation bytes. The frontend now transports those exact
  contracts and delivers the approved private-context capability only after an explicit
  click through a source/opaque-origin/per-load-nonce-bound bridge. All three runtime
  switches remain false pending the remaining release gates;
- **#55/#57:** ordinary test-mode users can no longer re-own another user's app, and
  group/channel enablement is capped at 32 with deterministic legacy/import bounding;
  and
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

Latest affected PR 2 Rust evidence: shared `types` 31/31, UserIndex 212/212, GroupIndex 19/19,
and LocalUserIndex 32/32 passed; the complete integration-test target also compiles with
`--no-run`. The earlier ActionInbox implementation checkpoint remains 58/58. The PR 2 worktree
policy passes with Node 24.18.1, cargo-audit 0.22.2, Dependabot checks, and the 2026-08-31 expiry,
but its `baseCommit` is the already-combined `f0c7402` branch head, so it hides the preceding 125
interleaved commits and is not valid upstream-PR evidence. Regenerate it against the exact frozen
PR 1 head after reconstruction.

The final source-scoped PR 2 frontend run is green: shared 8 files/175 tests, agent 8/32, client 15/164,
and app 23/382, for **54 files and 753 tests**. The agent capability mapper passes 4/4, the new worker
response-contract regression passes 1/1, Turbo worker build/typecheck passes 4/4, and the OpenChat app
dependency typecheck passes 7/7. The broad package command also collected tests from a pnpm-linked
Rollbar dependency and failed on that vendor package's deprecated APIs; `--dir src` establishes the
application-source result and the vendor collection is a local harness artifact, not an OpenChat source
failure. Clean reconstruction, strict generated/bidirectional Candid comparison, rebuilt WASMs, hosted
CI, formatting/diff/genericity gates, Linux PocketIC, and live upgrade evidence remain pending.

The integration targets and new interleaving assertions compile, but the complete PocketIC
suite was not run against rebuilt WASMs. Unit coverage exercises attestation, content-hash
relay, post-await checks, collision/legacy behavior, retry and mutation boundaries; it is
not evidence for the complete asynchronous chain, stopped canisters, upgrades or ambiguous
outcomes on a replica.

The 100-by-1,000 ActionInbox capacity test and acknowledgement-sybil PocketIC tests
compile but remain unexecuted locally because the repository's PocketIC server is a Linux
ELF and cannot run on Windows. They are not counted as runtime evidence. The exact old
heap snapshot necessarily deserializes before the O(1) non-empty guard; it now rolls the
upgrade back with a migration-required trap instead of losing data. A non-empty legacy
deployment therefore needs a drain/export/reinstall decision, while current-v4 capacity
and upgrade behavior still need their explicit Linux release runs.

Architecture/release blockers include:

1. **#13:** finish installer/controller/cycles/metrics wiring and the UserIndex →
   ActionInbox → LocalUserIndex rollout. A non-empty committed pre-PR2 heap snapshot now
   traps explicitly because its rows cannot be authenticated as v4. Before upgrading such
   a canister, drain it or use a reviewed export/reinstall policy; prove empty-legacy,
   current-state, restart, saturation and recovery in PocketIC/live replicas.
2. **#38/#45:** stage/activate/verify-only logic and independently pinned remote trust are
   implemented. Provision real pins, validate partial rollout/convergence/retirement, and
   define the controller/backup threat model plus bounded scrubbing before claiming physical
   deletion of retired private-key copies from heap or stale upgrade memory.
3. **#48/#54:** exact initial/final attesters and the approved click-only private-capability
   bridge are implemented. Keep every switch false until strict generated-contract CI,
   Linux PocketIC and the live four-profile matrix prove the full chain. The authorized IOU
   card must show Type; public OpenChat state must never contain it.
4. **#49/#51/#69:** the immutable semantic outbox, exact retry/late-result policy, and persisted
   canister-version/`raw_rand` entropy gates are implemented in source. Prove actual
   stop/snapshot/issue/load/reseed, stopped-inbox/timeout, restart/upgrade, and ambiguous-callback
   recovery across the coordinated state graph before activation.
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
   56/56 frontend focused tests. These are source results only; no backend upgrade is deployed and
   every PR2 feature flag remains false.
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
   restore tests pass 4/4, and source-contract checks pass 2/2. This remains a release gate until an
   actual upgrade of disposable canisters proves the historical entries are removed from exported
   logs and stay absent after another upgrade; the preserved local backend was not upgraded.
10. Rebuild generated clients and every affected WASM, run strict bidirectional Candid checks,
   and execute the real confirmation→deposit→replicated-read→IOU verify/decrypt/import→
   exact-ack flow in Linux PocketIC and a disposable live upgrade. Windows compilation alone
   is not runtime evidence.

## Exact two-PR plan

### PR 1

Include only generic model contracts/catalog/integrity, downloader/store, llama.cpp and
Tauri bridge, browser text/vision inference, model UI, and only platform support required by those
model features,
tests, SBOM, license/dependency policy, and the shared model-refresh event contract.
The earlier short PR 1 path examples were not exhaustive. A complete committed-plus-dirty audit found
79 PR 1 candidate paths and 42 paths also present in the combined PR 2 workspace, including Tauri,
shared model contracts, stores, catalog/inference files, `Cargo.lock`, and Dependabot policy. Freeze an
exact reviewed path-and-hunk manifest rather than inferring ownership from a filename example.

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

Do not classify the broad product tree by exclusion. The current PR 2 branch is 125 commits over old
base `05ec432`, contains merge `b24437f` of PR 1 and later interleaved model work, and its complete
candidate manifest spans 496 paths. Reconstruct PR 1 first from fetched upstream; while it is under
review, stack PR 2 only against that exact frozen head and use path/hunk review plus `range-diff` to
prove the PR 2 delta contains no Model Manager, `/ai`, browser/native inference, cache, catalog, or
model dependency changes. After PR 1 merges, rebase/reconstruct PR 2 onto updated upstream.
Fork notes, caches, local deployment helpers, generated artifacts and mixed lockfiles
are not thereby admitted. Finish #13's legacy-inbox rollout decision and #38's physical
key-erasure threat model, validate the #36/#45 source closures in PocketIC/live upgrades,
then scan for every IOU string, URL, prompt, ID, fixture, canister ID, and WASM.

There is no third mixed PR. Reconstruct each candidate from an exact clean-base path
manifest and validate it in isolation; do not submit either current broad worktree as
the PR diff. IOU-specific adoption remains in IOU.

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

The latest #3 comment predates the entropy, durable-outbox, and scoped-identity files. Add a safe
path/category checkpoint mapping the entropy modules to #51, the outbox model/job/deposit contracts to
#49/#69, and the scoped subject/selector/route/declaration files to #58. Do not include keys, selectors,
canister credentials, or browser state in the issue.

## GitHub issue index

An open issue may have a working-tree fix; it remains open pending review, commit,
hosted CI, and live verification.

Each canonical issue was opened with reproduction steps, security impact, acceptance
criteria, and an exact-regression plus adjacent-boundary test plan. Rows marked closed
are duplicate reports redirected to the named canonical issue.

### IOU

| Issue | State | Subject |
|---|---:|---|
| [#8](https://github.com/ktimam/IOU/issues/8) | Open | Critical production sheet-key persistence |
| [#9](https://github.com/ktimam/IOU/issues/9) | Open | Critical closed-sheet recovery |
| [#10](https://github.com/ktimam/IOU/issues/10) | Open | Storage/cycle bounds |
| [#11](https://github.com/ktimam/IOU/issues/11) | Open | Configuration front-running |
| [#12](https://github.com/ktimam/IOU/issues/12) | Open | Plaintext closing balances |
| [#13](https://github.com/ktimam/IOU/issues/13) | Open; public leak fixed, authorized card display implemented, activation matrix pending | Template metadata leakage |
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
| [#39](https://github.com/ktimam/IOU/issues/39) | Open; fixed in worktree, live upgrade pending | Cross-process consumer-key mutation epoch |
| [#40](https://github.com/ktimam/IOU/issues/40) | Open; exact-secret acknowledgement fixed, live drill pending | Handled ActionInbox items were never acknowledged |
| [#41](https://github.com/ktimam/IOU/issues/41) | Open; cursor removed/replicated read fixed, live drill pending | Exclusive inbox cursor skipped an adjacent action |
| [#42](https://github.com/ktimam/IOU/issues/42) | Open; v4 key-id pins/rotation cutoffs fixed, production pins pending | Uncertified OpenChat signing-key query |
| [#43](https://github.com/ktimam/IOU/issues/43) | Open; fixed in worktree, hosted clean-install CI pending | Transitive Hono CORS ReDoS advisory |
| [#44](https://github.com/ktimam/IOU/issues/44) | Open; complete v4 verification fixed, cross-repo/live proof pending | Stale ActionInbox v2 signature and permissive envelope decoder |

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
| [#48](https://github.com/ktimam/open-chat/issues/48) | Open; exact backend/frontend contract fixed in tree, switches false/PocketIC pending | Full-card and final-payload attestation |
| [#49](https://github.com/ktimam/open-chat/issues/49) | Open; immutable reservation and durable semantic outbox fixed in tree, Linux saga recovery proof pending | Confirmation lease/saga mismatch |
| [#50](https://github.com/ktimam/open-chat/issues/50) | Open; source purge fixed and focused tests pass, live upgrade/export proof pending | Historical trace/log retention |
| [#51](https://github.com/ktimam/open-chat/issues/51) | Open; persisted entropy/version gate and executable local rollback tests fixed in tree, actual snapshot-load proof pending | Snapshot rollback reuses security material |
| [#52](https://github.com/ktimam/open-chat/issues/52) | Open; lifecycle cleanup/caps fixed, upgrade/load proof pending | Capability revocation/retention/quotas |
| [#53](https://github.com/ktimam/open-chat/issues/53) | Open; gated in tree | Direct-chat frontend/backend mismatch |
| [#54](https://github.com/ktimam/open-chat/issues/54) | Open; owner approved, click-only contract fixed in tree, activation gates pending | Generic private-context capability |
| [#55](https://github.com/ktimam/open-chat/issues/55) | Open; fixed in tree, live proof pending | Four-account test-mode ownership isolation |
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
| [#71](https://github.com/ktimam/open-chat/issues/71) | Open; content-addressed bounded cache and failure-adjacent lifecycle tests pass in tree, clean-baseline reconstruction/hosted CI pending | Stale and unbounded native model cache |

## Release recommendation

Do not deploy solely because local checks pass. Review and commit, run pinned hosted CI,
deploy to a disposable replica, exercise fresh install
and upgrades, test all four durable named profiles across restarts and same-profile
principal switching, and complete production key/Android drills.

Do not upstream either broad OpenChat branch. Construct the two PRs from the classified
paths, resolve PR 2 blockers, run PocketIC, and audit each resulting diff independently
for genericity and dependency delta.
