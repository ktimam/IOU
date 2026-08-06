# IOU ↔ OpenChat local dev runbook

How to bring the IOU app up **against a local OpenChat replica** and run the full
propose → confirm → deposit → import journey. This is the IOU-specific half; the OpenChat
replica/canisters/frontend/exe are brought up separately (see
`open-chat-cycle/LOCAL-DEV.md`).

## Topology (why it's split across two replicas + two node runtimes)

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

## Client-side gotchas (these are where the journey silently "does nothing")

- **Hard-reload the IOU tab (Ctrl+Shift+R) after any `.env.local` change.** Vite bakes
  `import.meta.env.VITE_*` at load; a stale tab keeps the OLD `user_index` and pairing 500s with
  *"Canister <old id> has no update method 'c2c_claim_ai_app_link_code'"*.
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
- **Auto-propose chip requires all of:** the app **enabled** for the group (Group details → AI apps
  toggle ON), the **"Suggest AI actions"** setting on, and a **trigger keyword** — `owe`, `owes`,
  `owed`, `paid`/`sent`/`transferred`/`settled`/`received`, `rent`, `due`, etc. Matching uses
  word boundaries, so bare "owe" is accepted without matching unrelated words such as "power".
