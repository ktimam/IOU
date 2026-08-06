# IOU ↔ OpenChat local dev runbook

How to bring the IOU app up **against a local OpenChat replica** and run the full
propose → confirm → deposit → import journey. This is the IOU-specific half; the OpenChat
replica/canisters/frontend/exe are brought up separately (see
`open-chat-cycle/LOCAL-DEV.md`).

## Choose the startup path

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
3. Identify which source or artifact layer you are changing. The current clean PR 2 source head is
   `68aadfd35d93b3bbb25d352edb81c83790160c0c`; the dependency-compatible checkpoint source
   head is `790bb76d00240ca5a8a4c124db4535dd7795f96b`. They include generic #77's test-mode
   backend gate, #78's bounded bootstrap retry, and #79's structured-clone-safe private-context
   handoff. The latter two changes are frontend-only and do not change any canister Wasm.

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
   only the approved OpenChat origins. For current PR 2 acceptance, serve either clean
   `68aadfd35` or dependency-compatible checkpoint `790bb76d0`; `8ae34cf38` is the deployed
   child-Wasm provenance, not the final frontend source head.
9. Recheck zero upgrade failures, six global/four local users (for this fixture), the
   published app revision/inbox/app-canister binding, exact active key pin, frontend HTTP
   health, and all four signed-in profiles. Father, mother, child, and property manager must all
   be members of the group and independently show app id `1` (`iou`) as connected; the app must
   be enabled for the group.
10. Confirm Type metadata is absent from public manifest/discovery data. In the current IOU fixture,
    only House has `Rent`: father sees `Rent`, property manager sees `Rent · partner`, and the
    FatherMother/FatherChild accounts show no Type to their members. The card may show `Rent` only
    after explicit load and its one-time encrypted private context. Generic OpenChat #78/#79 are
    present in the source heads above. IOU #47/#48 are also fixed in the current IOU main changes:
    the crypto/poll suites pass **42/42** and repository-policy tests pass **12/12**. The exact
    clean-head PR 2 focused rerun at `68aadfd35` passes **68/68**. A fresh reload imported the
    already-stored setup action without reconfirming it. The separate local `Rent` smoke then passed:
    the card options were exactly `[None, Rent]`, `Rent` was selected through its private account-local
    identifier, edited final-payload approval passed, and the resulting draft was deposited/routed
    only to House. Leave that draft `Pending` for user review; this recorded smoke did not import or
    acknowledge it. This is a local acceptance pass, not a production-release authorization.

    Do not treat the current whole-workspace `svelte-check` as authoritative or green: its
    `node_modules` is linked to the deployment repository, `marked` and `svelte-easy-crop` are
    missing, and inherited `VideoCallsReleased` parser errors remain. Use the focused **68/68**
    clean-head rerun as the latest PR 2 frontend evidence until that workspace baseline is repaired.

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
| OpenChat replica + canisters | WSL dfx, `:8080` | user_index, local_user_index, II (`qhbym`), … |
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
  structured-clone-safe values before `postMessage`. This is present in clean `68aadfd35` and
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
- **Connection and chat-to-sheet mapping are separate, but there is no longer an “Open setup” link:**
  - **Connect** pairs THIS user's delivery key (64-character claim token → IOU backend →
    app-authenticated `c2c_claim_ai_app_link_code`). This is the
    "connected/disconnected" status and lets OpenChat encrypt confirmed deposits for that user.
  - The first time the user imports a verified v4 OpenChat draft, leave
    **“Remember: always import this chat's drafts into this sheet”** checked (the default). IOU then
    stores a caller-private, app-scoped opaque chat-handle → sheet mapping. Each of the four local
    accounts must Connect separately and establish its own mapping by importing into its intended sheet.
  - The old `/openchat/link-chat?chat=...` route and OpenChat **Open setup** surface were removed because
    raw chat coordinates are a public correlation risk. Treat any old link/setup instructions as stale.
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
