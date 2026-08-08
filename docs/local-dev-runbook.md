# IOU ↔ OpenChat local dev runbook

How to bring the IOU app up **against a local OpenChat replica** and run the full
propose → confirm → deposit → import journey. This is the IOU-specific half; the OpenChat
replica/canisters/frontend/exe are brought up separately (see
`open-chat-cycle/LOCAL-DEV.md`).

## Current supported recovered state — 2026-08-07

The current environment is **not** the former six-subnet `dfx` topology. Its authoritative state
directory is `/home/kiko/openchat-cycle-recovered-supported-20260807`, restored with
`SubnetStateConfig::FromPath` for exactly three intact subnets: NNS, Internet Identity, and System.
It passed a clean PocketIC instance deletion/checkpoint and strict reopen with
`incomplete_state: null`, preserving canister ids and application state.

The saved six-subnet topology cannot be reopened safely: its SNS/System cross-subnet counters are
inconsistent. Against the current recovered state, **do not run** normal `dfx start`, `dfx stop`,
the old six-subnet `local-up.sh`, or any helper that assumes `.dfx/network/local/state` is the live
state. Keep the untouched pre-recovery backup at
`/home/kiko/openchat-cycle-preserved-pre-pr2-20260807/.dfx` as evidence; do not promote it back into
service.

For a controlled restart:

1. Address the exact live PocketIC instance through its control port. Request stop progress, delete
   that instance, and wait until it reports `Deleted` before terminating its exact parent process.
2. Reopen the external recovered state with the reviewed three-subnet configuration (NNS, II, and
   System all `FromPath`) and the local HTTP gateway on `127.0.0.1:8080`.
3. Fail closed unless the response identifies the expected three subnets, preserves the known
   canister ids, and reports `incomplete_state: null`.
4. Recheck frontend health, UserIndex/LocalUserIndex metrics, child versions, rollout queues, the
   app registration, and all four durable signed-in browser profiles before accepting the restart.

### Verified wrapper acceptance

The checked-in IOU-local wrapper `scripts/live/pocketic-recovered.ps1` was safety-reviewed and then
ran two complete clean `stop` → checkpoint → strict `start`/reopen → `status` cycles. On every
reopen it dynamically parsed the new PocketIC instance id, control port, and exact PID instead of
reusing stale metadata. It then revalidated all three recovered subnets and seven deployed
canisters. Cycle 2 left exact PR 2 head `001a1e298` healthy; the preserved state retained routing
**17/17**, Type isolation **12/12**, and card hydration **8/8** across the restarts.

Do not turn this acceptance into a cleanup claim. The optional extra cleanup gate was rejected, so
the obsolete six-subnet state and remaining WSL artifacts are still deliberately preserved. An
earlier narrowly targeted cleanup of rebuildable debug/build artifacts recovered about **46.8 GiB**.

The exact deployed PR 2 source is
`001a1e29881f340705444a9e11e96a54bc3eac9c`. Current versions are:

| Component | Current version | Deployment note |
|---|---:|---|
| UserIndex | `0.0.9` | exact PR 2 artifact deployed |
| LocalUserIndex | `0.0.5` | exact PR 2 artifact deployed |
| User children | `0.0.3` | all four user canisters upgraded |
| Private Group instance | `0.0.4` | exact PR 2 artifact deployed |
| Community child template | `0.0.4` | published; this fixture has no Community instance |
| GroupIndex | unchanged | not deployed or upgraded in this rollout |

The rollout queues are clear. PR 2 passes **990/990 frontend tests across 70 files**, the
nine-package backend matrix, both TypeScript checks, ESLint, Prettier, `cargo fmt`, and exact Linux
`prod_test`. PR 1 remains at
`f43d2a2d53f2c9f8a3086104a356d4d3a315858a` with its focused **145/145**, typecheck, and exact
WSL `prod_test` evidence.

Live acceptance proves account-scoped Type isolation (**12/12**) and recreated-account-safe Father
per-chat House/Family routing (**17/17**); the routing test dynamically discovers the current two
distinct sheet ids. Exact-PR-2 private card hydration also passes **8/8** after reloading the sender
optimistic echo: before consent the selector has only `None`, then explicit **Share private context**
exposes House `Rent`, excludes Family `Family expense`, auto-selects `Rent`, and does not reconnect.
That reload is now recognized as a sender optimistic-state/identity regression, so this is
canonical-event evidence rather than acceptance of the no-reload product path.

The current IOU gates are unit **846/846**, Rust **68/68**, and live E2E **56/56** under split
verification. The initial live run was **52/55** because three registry expectations were obsolete;
**51** unaffected scenarios remained green, and the replacement read-only/ownership plus live
owner-attestation registry suite passes **5/5**. Unit coverage is **71.49%** for statements/lines,
**84.85%** for branches, and **86.9%** for functions.

### Working-tree correction awaiting coordinated rollout — 2026-08-07

Do not treat the pushed/deployed `001a1e298` totals above as evidence for the following candidates.
The current PR 2 working tree reconciles successful provenance-backed sends immediately, re-resolves
and preserves authoritative app identity, hides the stale untrusted-content labels on attested cards,
and keeps unattested cards actionless. Its image path also requires explicit `acceptsImage: true`
and enforces the manifest's bounds and safe formats. IOU's matching manifest aligns half-minor-unit
amount rounding, the safe upper bound, ASCII-uppercase currency, real calendar dates, and bounded
NUL-free note/message with the app attester.

The extended `scripts/live/journey-fanout.ts` now drives chat send → iframe **Add to IOU** → exact
routed **Pending from chat**/**Review & add** → prefilled `EntryForm` submission → persisted
**History**, followed by nonce-exact soft-delete cleanup. These source/test changes still require
focused/full green gates, exact commits and pushes, manifest/binding rollout, and a live run before
they can be called deployed or verified.

## Historical startup paths (not for the current recovered state)

The procedures below predate the supported three-subnet recovery. They remain useful as design and
intentional fresh-reset reference, but their hashes, versions, deployment status, and six-subnet
control commands are superseded by the section above.

There are two intentionally different workflows:

- **Preserved restart/upgrade (normal development):** retain the existing replica,
  canister state, local signing keys, and the father, mother, child, and property-manager
  browser identities. Use the procedure immediately below.
- **Fresh reproducible setup (intentional reset):** use the full bring-up later in this
  document. The four identities and local keys can be recreated across runs, but that is a
  destructive choice and must not be confused with a normal restart.

### Preserved restart, PR 2 index upgrade, or child-Wasm publication

1. Confirm that the replica is healthy at `127.0.0.1:8080` and record canister ids,
   controllers, module hashes, versions, the IOU registration, and user counts before
   changing anything. **Do not** use `dfx start --clean`, reinstall a canister, remove a
   `.dfx` directory, or run a helper whose purpose is cleanup/reset/restore.
2. Verify the controller chain. In the current preserved environment, UserIndex and
   GroupIndex are controlled by `openchat_installer`; LocalUserIndex is controlled by
   UserIndex; and the installer is controlled by the selected local dfx identity. A mismatch
   is a stop condition.
3. Identify which source or artifact layer you are changing. PR 1's final pushed head is
   `f43d2a2d53f2c9f8a3086104a356d4d3a315858a`; it includes #88's clean-install alias fix
   and #92's pushed Wllama production-bundle fix. Five focused web/model/on-device files pass
   **145/145**, typecheck reports **0 errors**, and exact WSL `prod_test` completed in
   **10m36s**. The emitted **7,656,521-byte** Wllama Wasm is byte-identical to source at SHA-256
   `4197ce6d3dc9240c42ee52b4197dc99638875a06b0083901f8a57767338a0cfa`, with zero
   unresolved Wllama references. PR 1 deployment remains pending.

   PR 2's exact pushed post-rebase setup-token head is
   `16080b0780ed97c3cd63d4187188ac04b19b3769`. It includes the #81–#86 security
   remediations, #89/#90 clean-gate fixes, and #91's committed generic desktop bridge. Its final
   exact-blob Linux `prod_test` exited **0**: Rollup completed in **11m46.9s** and the wrapper in
   **716s**. The bundle emits and references a byte-identical **7,656,521-byte** Wllama Wasm at
   SHA-256 `4197ce6d3dc9240c42ee52b4197dc99638875a06b0083901f8a57767338a0cfa`,
   with zero unresolved Wllama references. The successful retry used the exact Git blob after an
   environment-only CRLF wrapper failure and supplied mandatory
   `OC_WEBSITE_VERSION=1.0.0`, the canonical CI value. Baseline unresolved
   `porto`/`accounts` notices and the known nonfatal public-key CRLF warning remain out of scope.
   PR 2 deployment remains pending.

   The following hashes remain the historical 2026-08-06 baseline, not the current setup-token
   candidate: clean PR 2 source `dda2833d6545c68599feccdd90f4faac86197717` and
   dependency-compatible checkpoint `790bb76d00240ca5a8a4c124db4535dd7795f96b`. They include
   #77's test-mode backend gate, #78's bounded bootstrap retry, #79's clone-safe private-context
   handoff, and #80's exact pending-link-token cancellation. #78/#79 are frontend-only; #80
   requires a UserIndex-only upgrade. The current per-chat setup-token work changes additional
   producers/relays. Never use the historical #80-only topology as its rollout plan; follow the
   reviewed token preflight and install the OpenChat producer before IOU.

   The current index canisters still run the tested artifacts built from embedded git SHA
   `7c997f4b1ef10f8217d526e82f8016b7e05d0486`:

   | Index canister | Version | Compressed SHA-256 |
   |---|---:|---|
   | UserIndex | `0.0.5` | `ed4adbf8dab4dd919b9bcf1f941c9ce02de0521e34b0c3fbdd437d87604be870` |
   | LocalUserIndex | `0.0.3` | `f277a4f767d4dd0f03e8d4c3d08969b6be909fe44533f9ad1a8fb47564bec5aa` |
   | GroupIndex | `0.0.3` | `26624f9ca927a89593fb6c3eb2f2a3b1bb5258b08b409159028cf598f02e6b2e` |

   Checkpoint commit `8ae34cf38cb633abc4d1143ba3e1b7feef9a793a`, which contains #77,
   was used to build only the Group and Community child Wasms currently published through
   GroupIndex:

   | Child Wasm | Version | Compressed SHA-256 | Module SHA-256 |
   |---|---:|---|---|
   | Group | `0.0.2` | `9388c354dd02ade409fa17d4dfff816a08819551bb03d39e10d798b18dde6967` | `00edafdd7339377252381dcbb55693d43a523fe9a4ef1eca33de532e0fe8c618` |
   | Community | `0.0.2` | `d8a27022f6363c4e26704cfae8ca2826293928f51cb0ed4d19e340ef8486292c` | `6c85c3c99f7655852a9a437c53c865d639e0b884bf63a2c80155db7a08b71451` |

   Do not report the indexes as `8ae34cf38` or `790bb76d0`, do not report the child Wasms as
   `790bb76d0`, and do not copy a child Wasm over an index Wasm. Source-head advancement for the
   frontend-only #78/#79 fixes does not authorize a canister upgrade.
4. On a normal preserved restart, skip all canister upgrades. If an index upgrade is explicitly
   intended, first copy the already-tested index Wasms into `open-chat-cycle/wasms`, hash the
   copied bytes, and then upgrade in dependency order: UserIndex, LocalUserIndex, GroupIndex.
   The sixth argument `local` means use that prebuilt Wasm, not rebuild or download one:

   ~~~sh
   bash scripts/upgrade-canister-prebuilt.sh local http://127.0.0.1:8080/ default user_index 0.0.5 local
   bash scripts/upgrade-canister-prebuilt.sh local http://127.0.0.1:8080/ default local_user_index 0.0.3 local
   bash scripts/upgrade-canister-prebuilt.sh local http://127.0.0.1:8080/ default group_index 0.0.3 local
   ~~~

   Use the identity verified in step 2 if it is not named `default`. After every upgrade,
   compare the installed module hash and embedded git SHA with the tested artifact before
   continuing.
5. Publish Group/Community child releases through GroupIndex; do not directly install a child
   canister. Require both `0.0.2` releases to be active with zero pending, in-progress, or failed
   rollouts. The preserved private group `weosr-yh777-77774-qaaoa-cai` (`IOU local 094847`)
   runs Group `0.0.2`.
6. On a normal restart, reuse the existing active `action_inbox_deposit` key. Its exact lower-case
   id in the ignored IOU environment is
   `8101944ff165ad36af3b6ed50f34c570154bb7d80c1fd6994206a0cb0984805c`.
   Query `action_signing_keys` and require that id to be `Active`. Only after an intentional
   keyring-changing index upgrade should you wait for a new `Staged` key, independently pin its
   id as `VITE_OPENCHAT_ACTION_SIGNING_KEY_IDS=<key-id>`, activate it through local governance,
   and verify it again. Discovery is never a production trust root.
7. Backend authorization is separate from frontend flags. Issue #77 allows the generic private-
   context and edited/final-confirmation paths only when the child canister's persisted
   `state.data.test_mode` is true. The preserved local Group was created in test mode. A non-test
   or production child must remain fail-closed; do not add an environment-variable bypass.
8. Before starting IOU, require that no ignored `vite.config.js` exists beside tracked
   `vite.config.ts` (#46). Then start or restart only the frontends, keeping the replica and browser
   profile directories:
   IOU on `127.0.0.1:3000` and OpenChat on `127.0.0.1:5003`. The OpenChat build used for
   local PR 2 acceptance must explicitly enable
   `OC_LOCAL_AI_APP_CARDS_ENABLED`,
   `OC_LOCAL_AI_APP_CONTENT_ATTESTATION_ENABLED`,
   `OC_LOCAL_AI_APP_FINAL_CONFIRMATION_ENABLED`, and
   `OC_LOCAL_AI_APP_PRIVATE_CONTEXT_ENABLED`.
   It must also use the local canister ids; a stale Vite process that contacts mainnet ids is not
   valid local evidence. Verify that an IOU module response to `Origin: null` carries
   `Access-Control-Allow-Origin: *` (#45) while the HTML `frame-ancestors` policy still permits
   only the approved OpenChat origins. For current token PR 2 acceptance, serve the final clean
   candidate only after its exact commit is recorded and pushed; `dda2833d6` is historical and
   `8ae34cf38` is old deployed child-Wasm provenance, not the token frontend source head.
9. Recheck zero upgrade failures, six global/four local users (for this fixture), the
   published app revision/inbox/app-canister binding, exact active key pin, frontend HTTP
   health, and all four signed-in profiles. Father, mother, child, and property manager must all
   be members of the group and independently show app id `1` (`iou`) as connected; the app must
   be enabled for the group.
10. Confirm Type metadata is absent from public manifest/discovery data. In the current IOU fixture,
    only House has `Rent`: father sees `Rent`, property manager sees `Rent · partner`, and the
    FatherMother/FatherChild accounts show no Type to their members. The card may show `Rent` only
    after explicit load and its one-time encrypted private context. Generic OpenChat #78/#79 are
    present in the historical source heads above. IOU #47/#48 are also fixed in IOU:
    the crypto/poll suites pass **42/42** and repository-policy tests pass **12/12**. The exact
    historical PR 2 card-focused rerun at `68aadfd35` passed **68/68**; #80's endpoint/model/API/
    consent/worker suites at `dda2833d6` pass **37/37**. A fresh reload imported the
    already-stored setup action without reconfirming it. The separate local `Rent` smoke then passed:
    the card options were exactly `[None, Rent]`, `Rent` was selected through its private account-local
    identifier, edited final-payload approval passed, and the resulting draft was deposited/routed
    only to House. Leave that draft `Pending` for user review; this recorded smoke did not import or
    acknowledge it. This is a local acceptance pass, not a production-release authorization.

    The exact pushed post-rebase PR 2 head
    `16080b0780ed97c3cd63d4187188ac04b19b3769` passes the full frontend suite
    **958/958**. Svelte typecheck reports **0 errors and 565 warnings**, and the agent typecheck is
    green. #90's root-command source-inspection proof passes **44/44**; focused frontend evidence is
    #83 **3/3**, #84 **3/3**, the #85 surface resolver file **32/32**, and #86 **3/3**. The
    post-rebase backend tree is exact to the previously green tree, whose recorded evidence is
    UserIndex **253/253**, token model **11/11**, LocalUserIndex **35/35**, Community **15/15**,
    Group **11/11**, User **19/19**, architecture **10/10**, and Candid golden **1/1**. The latest
    setup-token focused runs are common admission **4/4**, GroupIndex cancellation **2/2**, Group
    **3/3**, and Community **3/3**; no aggregate GroupIndex total is claimed. #91's generic desktop
    bridge is committed at that exact pushed head; its pre-rebase focused **2/2**, full plugin
    **17/17**, and format/diff evidence remain applicable through exact tree equivalence. The final
    exact-blob Linux `prod_test` exited **0** (Rollup **11m46.9s**, wrapper **716s**) and emitted
    and referenced the byte-identical **7,656,521-byte** Wllama Wasm at SHA-256
    `4197ce6d3dc9240c42ee52b4197dc99638875a06b0083901f8a57767338a0cfa`, with zero
    unresolved Wllama references. Its environment-only retry used the exact Git blob plus canonical
    CI `OC_WEBSITE_VERSION=1.0.0`; inherited `porto`/`accounts` notices and the known
    nonfatal public-key CRLF warning remain out of scope. PR 2 deployment remains pending.

    PR 1's final pushed head is `f43d2a2d53f2c9f8a3086104a356d4d3a315858a`. #92 is fixed
    and pushed; five focused web/model/on-device files pass **145/145**, typecheck reports
    **0 errors**, and exact WSL `prod_test` completed in **10m36s** with a byte-identical
    **7,656,521-byte** Wllama Wasm at SHA-256
    `4197ce6d3dc9240c42ee52b4197dc99638875a06b0083901f8a57767338a0cfa` and zero
    unresolved Wllama references. PR 1 deployment remains pending.

Snapshot restoration has an additional mandatory transition. Use **stop → load snapshot →
upgrade the same tested Wasm while the canister remains stopped → start**. Loading a
snapshot and immediately starting it is not a complete recovery: the same-Wasm upgrade is
what advances the persisted lifecycle, invalidates snapshot-restored short-lived
authorities, and schedules fresh entropy initialization. Verify that old link bearers and
GroupIndex authorities fail after recovery while the action keyring, per-user keys, and
durable outbox remain available.

## Topology (one shared replica + two node runtimes)

| Piece | Where | Notes |
|-------|-------|-------|
| OpenChat replica + canisters | recovered PocketIC, `:8080` | supported NNS + II + System `FromPath` topology; not the old six-subnet dfx state |
| `iou_backend` | **co-deployed on :8080** | MUST be on OpenChat's replica so `publish_ai_app`'s c2c `c2c_verify_ai_app_v2` can reach it. |
| `action_inbox` (per-app) | **co-deployed on :8080** | IOU's OWN inbox, `inbox_canister_id` in the manifest. NOT the global inbox (there is none locally). |
| IOU dev app | **Windows** node, `:3000` | IOU's `node_modules` is win32 — `pnpm`/`vite`/`tsx` FAIL under WSL. |
| register / publish | dfx (WSL) + tsx (**Windows**) | `register:openchat` runs on Windows node; `publish_ai_app` is a WSL dfx call. |

**Don't hardcode canister ids.** They're pool-assigned (depend on deploy order + what already
exists), so they're not reliably stable across restarts — and every OpenChat `--clean` reshuffles at
least `user_index`. `deploy-openchat-canisters.sh` reads the actual ids off the replica and writes
them into `.env.local`; the register step prints its inbox id for you to pass through. Preserve the
replica for normal restarts. After an intentional `--clean`, archive the stale
`.openchat-inbox/.dfx` mapping before provisioning a replacement; the deployment helper refuses to
discard an existing canister identity automatically.

## Bring-up steps

> **Intentional fresh reset only.** Do not use this section to restart the current recovered
> three-subnet environment. Use the controlled PocketIC lifecycle above. A fresh reset recreates
> canisters and may recreate the four durable accounts/keys; that is a destructive, separate choice.

0. **OpenChat first.** Replica + canisters up on `:8080`, frontend on `:5003`, exe running
   (`open-chat-cycle/LOCAL-DEV.md`).

1. **Provision IOU canisters + sync env** (WSL, idempotent):
   ```sh
   bash scripts/deploy-openchat-canisters.sh
   ```
   Deploys `iou_backend`, allocates the final `action_inbox` canister id without installing code,
   and rewrites `.env.local`. The inbox cannot be installed yet: its immutable `app_id` comes from
   OpenChat registration. The script prints the remaining commands with fresh ids filled in.

2. **Register + publish** (Windows shell — WSL fails on win32 esbuild):
   ```sh
   cd /c/Kiko/MyProjects/IOU
   OC_USER_INDEX_CANISTER_ID=<user_index> OC_APP_CANISTER_ID=lqy7q-... \
     OC_ACTION_INBOX_CANISTER_ID=ll5dv-... pnpm register:openchat
   ```
   First validate the rebuilt Wasm and OpenChat's canonical ActionInbox Candid without changing
   dfx state or the replica:
   ~~~sh
   OPENCHAT_ROOT=<open-chat-cycle> \
     ACTION_INBOX_WASM=<open-chat-cycle>/wasms/action_inbox.wasm.gz \
     bash scripts/deploy-openchat-inbox.sh --check
   ~~~
   The check fails if the Wasm predates the current ActionInbox source/interface. Rebuild it with
   `./scripts/generate-wasm.sh action_inbox` in the OpenChat worktree before continuing.

   Install the inbox using the exact app id printed by registration. If the stable canister id
   already contains a different Wasm, `--upgrade` is mandatory and performs an in-place canister
   upgrade; the helper never reinstalls, recreates, or deletes its local id mapping:
   ~~~sh
   OC_USER_INDEX_CANISTER_ID=<user_index> \
     OC_CYCLES_DISPENSER_CANISTER_ID=<cycles_dispenser> \
     OC_APP_ID=<registered app id> ACTION_INBOX_WASM=<open-chat-cycle>/wasms/action_inbox.wasm.gz \
     OPENCHAT_ROOT=<open-chat-cycle> IC_URL=http://127.0.0.1:8080 \
     bash scripts/deploy-openchat-inbox.sh --upgrade
   ~~~
   This verifies the installed module hash and that the inbox is bound to that app id and user
   index, with UserIndex as its sole authorized deposit relay. Registration also writes the
   language-neutral, exact-revision
   manifest commitment to `.openchat-iou/verification-binding.did`. Before publishing, bind the
   exact owner and install that generated commitment with the same WSL dfx identity that deployed
   the backend:
   ~~~sh
   dfx canister --network local call iou_backend set_ai_app_owner '(principal "<owner printed by register:openchat>")'
   dfx canister --network local call iou_backend set_ai_app_verification_binding \
     --argument-file verification-binding.did
   ~~~
   IOU's verifier fails closed until this binding exists. Then publish (WSL dfx,
   from `.openchat-iou/`):
   ```sh
   dfx canister --network local call <user_index> publish_ai_app \
     '(record {app_id=<registered app id>:nat32})'
   ```
   Registration is UNPUBLISHED until this — an unpublished app is owner-only and does NOT show in
   other users' group Apps lists or the directory.

   > **Manifest-change handoff (2026-08-07):** re-registering after a schema/action change advances
   > the app revision. Do not run card QC with the new frontend/manifest and the old exact-revision
   > IOU/user bindings. Capture the new registration read-back, install the newly generated
   > `verification-binding.did` on `iou_backend`, confirm publication and exact app id/revision, then
   > refresh or relink father, mother, child, and property manager **sequentially**. Verify each user's
   > authoritative consumer key and revision before moving to the next profile. Only after all four
   > connections are current should the no-reload card, image proposal, and full fan-out/import
   > journey be accepted. A stale revision should fail closed; repeated Connect prompts in that
   > mixed-version window are not valid product QC.

3. **Start the IOU app** (Windows node):
   ```sh
   cd /c/Kiko/MyProjects/IOU && node ./node_modules/vite/bin/vite.js --host 127.0.0.1 --port 3000 --strictPort
   ```
   Before launch, remove any local emitted `vite.config.js`; Vite can prefer it over the tracked
   TypeScript config even though Git ignores it. After launch, verify an asset request with
   `Origin: null` receives `Access-Control-Allow-Origin: *`. The wildcard applies only to public
   frontend assets; the card remains credentialless and sandboxed, and CSP still restricts which
   OpenChat origins may frame the document.

## Client-side gotchas (these are where the journey silently "does nothing")

- **A just-sent card that says unverified or has no action until reload is the PR 2 optimistic-send
  reconciliation defect.** Reloading proves only that the canonical backend event is valid. The
  corrected build must make the successful provenance-backed sender card verified/actionable
  immediately and must strip send-only proof, recipient-key, payload, and inbox-routing material
  from the stored event. Do not accept reload as the workaround.
- **`Directory binding only; card content is untrusted` / `Untrusted card text` on an attested card
  is stale PR 2 UI state, not an IOU attester verdict.** In the corrected build those labels render
  only when content attestation is absent, and that genuinely unattested card stays actionless.
  Also require authoritative app identity to survive iframe reset and to re-resolve when the card
  transitions from optimistic to backend-attested state.
- **An image proposal can fail while a text proposal works when the manifest and app attester
  disagree.** Require explicit `acceptsImage: true`; then compare the registered schema read-back
  with IOU's attester boundary: amount `0.005` through the safe maximum, three ASCII-uppercase
  currency characters, a real `YYYY-MM-DD` calendar date, and code-point-bounded NUL-free text.
  Re-registering these constraints changes the revision, so complete the binding/relink handoff
  above before diagnosing the new image path.
- **Hard-reload the IOU tab (Ctrl+Shift+R) after any `.env.local` change.** Vite bakes
  `import.meta.env.VITE_*` at load; a stale tab keeps the OLD `user_index` and pairing 500s with
  *"Canister <old id> has no update method 'c2c_claim_ai_app_link_code'"*.
- **A rendered frame that stays at “Waiting for the isolated app?” is a handshake failure, not a
  backend Type failure.** First verify IOU #45/#46: public modules must return wildcard ACAO to
  `Origin: null`, and no stale `vite.config.js` may shadow the tracked config. Then verify that the
  OpenChat build includes generic PR 2 #78's bounded retry of the same nonce-bound bootstrap. A
  one-shot load message can arrive before React/Svelte installs its listener; repeated messages
  must stop on ready, reset, timeout, or teardown and must never change the frame nonce.
- **`DataCloneError` after “Share private context” is generic OpenChat #79, not an IOU Type or key
  failure.** The OpenChat build must copy Svelte-proxied capability/context data into fresh
  structured-clone-safe values before `postMessage`. This is present in clean `dda2833d6` and
  checkpoint `790bb76d0` and requires a frontend restart, not a canister upgrade.
- **A full reload that starts calling mainnet canister ids means the OpenChat Vite environment is
  stale.** Stop/restart only the `:5003` frontend with the local canister URLs and four local PR 2
  flags. Do not clean the replica or browser profiles to fix a frontend environment mismatch.
- **Frontend flags do not authorize backend delivery.** The group/community child itself must have
  persisted `test_mode = true`; production and non-test children fail closed even when all four
  frontend flags are on.
- **A valid stored action that decrypts but never appears in “Pending from chat” has two IOU-only
  checks before any relink or reconfirm.** IOU #47 requires the exact OpenChat v1 digest
  `SHA-256(openchat.ai-app-card-confirm-payload.v1\0 || u32_be(length) || payload)`, not raw
  `SHA-256(payload)`. IOU #48 requires `actor` in the `SheetPage` polling effect dependencies so a
  delayed authenticated actor starts the immediate poll and interval. Run the crypto/poll suites
  (**42/42**) and repository-policy suite (**12/12**), restart/reload the IOU frontend, and first
  check whether the existing action appears. In the preserved fixture, the already-confirmed setup
  action was imported after a fresh reload; no OpenChat code change, canister upgrade, relink, or second
  confirmation was required.
- **Inbox is auto-derived — nothing to configure in the UI.** `getActionInboxConfig()` reads the
  inbox canister id straight from this app's registered manifest in OpenChat's user_index (the exact
  id OpenChat routes deposits to), with `VITE_ACTION_INBOX_CANISTER_ID` as fallback only when the app
  isn't registered yet. The old manual Settings field + its `localStorage` override are gone (any
  legacy `iou.openchat.actionInbox.v1` value is auto-purged on load). So `weosr` (and any hand-typed
  id) can no longer win — ignore it. Resolution uses `VITE_OPENCHAT_HOST` + `VITE_OC_USER_INDEX_CANISTER_ID`;
  keep both pointing at the same OpenChat replica.
- **Connection and chat-to-sheet mapping are separate; Open setup is raw-free:**
  - **Connect** pairs THIS user's delivery key (64-character claim token → IOU backend →
    app-authenticated `c2c_claim_ai_app_link_code`). This is the
    "connected/disconnected" status and lets OpenChat encrypt confirmed deposits for that user.
  - In each chat open its chat settings page, then use AI apps → **Open setup**. OpenChat creates a
    different one-time URL ending in `/settings#openchat-routing/{chatLinkToken}` for every
    invocation. IOU's synchronous main entry captures and scrubs the fragment before dynamically
    loading authentication/application bootstrap, then redeems it server-to-server, focuses that
    exact pending row, and lets the user choose its destination account/sheet. Retry the card after
    saving. Only successful token redemption creates an actionable `claim_version = 1` row. Old
    card/private-context-derived rows are hidden and cannot be assigned, unlinked, or dismissed.
    IOU #51 caught the prior after-async-auth ordering with a failing-first **1/1**; the correction
    passes focused **5/5**. The final IOU gate passes Cargo **68/68**, frontend **846/846 across
    71 files**, typecheck, production Vite build, and routing Playwright **5/5** using the installed
    system Chrome. The first Playwright invocation failed only because its bundled browser binary
    was absent; the supported `PLAYWRIGHT_EXECUTABLE_PATH` rerun passed with no code failure.
    The exact IOU hash, push, and deployment remain pending.
  - The token is not a chat coordinate or stable handle. If Windows opens a default browser signed
    in as a different IOU account, the mismatch does not consume it: sign out and into the matching
    IOU account, then press **Refresh** to retry. The token stays only in that page instance's
    module memory.
    React StrictMode/remounts share one in-flight claim; a remote/ambiguous result retains that same
    token for retry. UserIndex keeps a digest-only exact-caller/subject success receipt for one hour,
    while IOU bounds each redemption call to 30 seconds.
  - A one-off preserved Father desktop proof used an excluded debug build. After fully exiting the
    desktop app, the shell that launched it supplied:

    ```powershell
    $env:OC_DEV_EXTERNAL_BROWSER_EXE = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
    $env:OC_DEV_EXTERNAL_BROWSER_USER_DATA_DIR = '<durable-father-iou-profile-directory>'
    $env:OC_DEV_EXTERNAL_BROWSER_PROFILE = 'Default'
    ```

    The variables are read at process startup; setting them after the app is running has no effect.
    This debug-only override targets the dedicated durable Father IOU profile. Keep it outside both
    OpenChat PRs and inventory it in OpenChat issue #3 as local/debug-only material; never put
    browser-profile contents in an issue.
  - The local-only live proof used a desktop-only restart. The actual current-chat
    **Open setup** → **Open in browser** chain opened a distinct Father-profile window, scrubbed
    the opaque fragment, reached the exact
    `http://127.0.0.1:3000/settings#openchat-routing` route signed in, and left the default
    browser unchanged. This is neither PR 2 nor deployment evidence and does not prove token
    redemption or sheet assignment.
  - Release builds use the operating-system handler. OpenChat #91's generic desktop
    `open_url` implementation is committed in exact pushed PR 2 head
    `16080b0780ed97c3cd63d4187188ac04b19b3769`. Its pre-rebase focused **2/2** and full
    plugin **17/17** results remain applicable through exact tree equivalence. It contains no
    Father/profile override; deployment and live acceptance remain pending.
  - IOU lists only expiring principal-scoped digests and enforces ownership of the selected active
    sheet. Multiple live pending rows are independently assignable/unlinkable, so each chat can
    route to a different sheet. Rows are capped per principal and globally, and exact manifest
    revision/UserIndex/app/subject/subject-version/`app_user_key_version`/key trust is rechecked
    before and after redemption and at save.
  - The verified-v4 import screen's default-on **Remember** checkbox remains a second way to store
    the same caller-private mapping. Each of the four local accounts connects and routes separately.
  - The old `/openchat/link-chat?chat=...` route remains retired and must not be restored.
  - As of 2026-08-07, this is the intended source flow, not the currently deployed backend result.
    After #51's exact IOU hash/push are recorded, the token-producing OpenChat upgrade must land
    before the matching IOU consumer upgrade; then run the preserved Father two-chat/two-sheet
    acceptance without cleaning the replica. Until those upgrades complete, **Open setup** can open
    the right profile but cannot finish redemption.
- **IOU #49 is a backend-plus-assets rollout and requires one relink per account.** Upgrade
  `iou_backend`, rebuild/deploy the matching IOU frontend assets, then hard-reload the four
  father/mother/child/property-manager IOU profiles. No OpenChat canister or frontend upgrade is
  required for this IOU-only fix. A binding created before #49 has no persisted link-time key pin:
  it remains visible to its owner so **Disconnect from OpenChat** can revoke it, but card/attestation
  authorization and consumer-key replacement fail closed until it is relinked. For each profile,
  disconnect first, create a fresh claim token as that same OpenChat user, and **Connect** again.
  New links persist the exact authoritative PEM; refreshing the wrapped copy of that same key is
  allowed, while replacing it with another PEM is rejected. Prefer coordinated disconnect. The raw
  `delete_consumer_keypair` recovery endpoint deletes both the IOU key and IOU binding but cannot
  revoke the obsolete public key held by OpenChat. Before rollout, the exact-head gate is Rust
  **53/53**, focused consumer-key/Candid tests **17/17**, both TypeScript typechecks, and full
  frontend coverage **68 files / 830 tests** at **87.11% statements/lines**, **85.96% branches**,
  and **90.75% functions**.
  The preserved local rollout completed successfully on 2026-08-06: explicit backend canister
  `lqy7q-dh777-77777-aaaaq-cai` now runs module hash
  `bd43debf7f0864ae3a395c09ff3c0c7221ac53457db4e0518aa5aa8c9efa3119`, the matching frontend
  is rebuilt and served at `127.0.0.1:3000`, all four profiles were relinked sequentially, and
  OpenChat reports each connected. House retained pending `rent card smoke 0951728`; a
  post-upgrade, non-confirming private-context check returned exactly `[None, Rent]`. Do not run
  concurrent relinks: the local reconnect teardown/claim UI can settle out of order; finish and
  verify one account before starting the next.
- **Auto-propose chip requires all of:** the app **enabled** for the group (Group details → AI apps
  toggle ON), the **"Suggest AI actions"** setting on, and a **trigger keyword** — `owe`, `owes`,
  `owed`, `paid`/`sent`/`transferred`/`settled`/`received`, `rent`, `due`, etc. Matching uses
  word boundaries, so bare "owe" is accepted without matching unrelated words such as "power".
