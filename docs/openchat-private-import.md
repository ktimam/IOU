# Private imports from the unofficial OpenChat client

This is the local-test workflow, not the legacy registered-app/card integration.
IOU and OpenChat have separate sign-ins. Setup does not create an IOU entry, and a
draft received by IOU is not saved until its final review is confirmed.

**2026-10-01 correction:** encrypted delivery from OpenChat is mandatory, not just
encryption at Save. The September 26 plaintext transport is obsolete. Source changes
and passing tests do not update previously installed APKs or served bundles automatically.

## Normal user flow (UI repair, 2026-10-06)

### Connection-only document and APK framing

Public discovery advertises `/openchat/connect.html`, a separate physical HTML
asset rendering the same **Connect IOU** screen and account/chat setup protocol.
It does not load the main app router, sheet pages, import receiver or transaction
save UI. The legacy `/openchat/connect` SPA route remains available to existing
web clients, with the main document's unchanged framing policy.

Only the new connection asset additionally permits `http://localhost:5193`, the
APK's existing on-device setup helper. It retains the existing `https://oc.app`
ancestor. Normal IOU pages do not gain loopback framing permission. The asset
disables extensionless aliases; its exact URL is excluded from PWA precaching and
the main-document navigation fallback. A browser still controlled by an older
service worker must receive the normal IOU service-worker update before relying
on the new routing policy; do not clear accounts or private data to update it.

The helper origin is not proof of a signed APK. Existing parent/origin/nonce,
expiry, account and explicit-consent checks still apply. This authenticated setup
page uses the existing IOU origin and identity settings; changing only its path
does not select a different Internet Identity principal. Browser storage
partitioning can still require sign-in inside the connection context.

This requires publishing the updated IOU frontend/directory. It does not require
an OpenChat canister change, an APK update or a new user-facing screen. Encrypted
inbox delivery, model prompts and processor bytes are unchanged.

Local verification on October 10 used an isolated production build, mounted
connection/protocol tests, publication/header regressions and fresh Edge browser
storage. The browser fixture served the built bytes with their staged asset
headers: Connect rendered for the exact helper, other IOU routes and unapproved
loopback parents were blocked, and an active service worker fetched Connect's
own document while retaining ordinary SPA fallback. This is not a deployed
asset-canister test or a live Internet Identity/phone sign-in test; those remain
post-publication checks. No user account was accessed by these framing tests.

### Separate account connection and chat setup (2026-10-09)

Setup protocol v2 separates **Apps → IOU → Connect/Reconnect** from the chat's
**Open setup**. Account connection verifies the current IOU identity and recovers
its existing delivery key; it has no sheet picker. It refreshes only the requested
saved chat routes and does not write, remove or guess their sheet mappings.

**Open setup** presents the active sheets available to the signed-in IOU account,
preselects that chat's saved sheet, and changes only that chat's opaque route after
**Save setup**. IOU persists the mapping through its existing authenticated
`chat_sheet_links` API. The handle is client routing metadata, not a claim that the
official OpenChat backend has verified chat membership. No OpenChat canister change
is required. A mismatched IOU account fails before key recovery or mapping changes.
The existing currency and private Type preview remains visible in chat setup;
unreadable slots or a changed preview disable sharing rather than exporting partial
or stale configuration.

For an existing v1 connection, account reconnect can preserve the explicitly linked
legacy recipient only if its identity, backend, sheet and delivery key still match.
It does not recover unknown historical per-chat mappings. Missing mappings require
**Open setup** for that chat. Existing proposal and delivery records are not retargeted.

The public catalog advertises `setupScopes: ["account", "chat"]`; the explicit,
origin- and nonce-bound v2 exchange carries the opaque account identity and at most
32 route configurations within a 1 MiB bound. Each returned private route has its
own delivery recipient context and private Type vocabulary. Account identity is stable
across delivery-key renewal but distinct for different IOU principals or backends.

Valid, unexpired inbox capabilities are reused only when owner-authenticated grant
metadata matches the same recipient, destination and revision and the capability
hash matches the grant's owner-bound inbox ID. Reconnecting does
not mint a grant per chat unnecessarily, and duplicate routes to the same sheet can
share a grant. Missing/expired grants still use the existing 32-grant quota and can
fail closed; the complete response is size-checked before grant creation, and a
failed setup never removes old grants or pending entries. The default
grant expiry has five minutes of headroom inside the unchanged backend 90-day
maximum, avoiding rejection from small positive client clock skew. Explicit expiry
requests retain their strict bound.

On October 9, the verified local frontends were activated and registry generation
10 was published. The updated x86 APK was installed in place; a cold emulator
restart retained the existing account, private cards and IOU chat opt-in. The final
normal emulator flow selected an existing synthetic sheet through **Open setup**
and saved its route. App-level **Reconnect** then presented no sheet picker and
completed successfully. After force-stopping and reopening only the local-test APK,
the account, chat opt-in and configured route were restored. **Open setup**
automatically preselected the same sheet and displayed both private Types without
manual reselection. Account/chat reconnect and restart acceptance passed.

Live testing exposed two return-shape bugs: `vec nat64` decodes as
`BigUint64Array`, and `active_sheet_id` belongs to `PairSummary`, not `Pair`.
Both were corrected in the active IOU frontend. The focused schema/loader suite
passed 15 tests, and each frozen IOU runtime passed all 132 integration tests.
These checks created no financial entries and did not rerun model accuracy,
install an APK on a physical phone or change an official OpenChat canister.

Known cancellation limitation: cancelling in the embedded IOU page and returning
can leave the native chat-setup attempt waiting. Main Apps does not expose its
Cancel action for that chat-initiated attempt. Reloading the APK page alone did
not release it; force-stopping and reopening only the local-test APK cleared it
while preserving the account, private cards, settings and pending route handle.
This workaround is not a passing cancellation-protocol test.

The dated acceptance below describes earlier builds; setup v1 remains a compatibility
path for them. Model prompts, processor behavior and financial save semantics are
not part of this correction.

### Durable inbox correction (2026-10-08)

The current implementation restores asynchronous encrypted delivery. It requires the
updated IOU backend and frontend, the updated OpenChat client, and one explicit
**Apps → IOU → Reconnect** to authorize its write-only inbox. Merely updating this
document or the public directory does not upgrade an installed APK.

1. In setup-v1 compatibility mode, Connect selects the IOU sheet and exchanges its
   public encryption key plus a scoped write-only inbox capability. In the scoped
   setup flow described above, account Connect/Reconnect and per-chat Open setup
   are separate. Public discovery contains only the generic endpoint, never this
   capability or private sheet configuration.
2. **Add to IOU** encrypts the reviewed fields in OpenChat and saves the exact
   encrypted request in the device-local card before sending it. The generic inbox
   transport does not require an IOU window to be open.
3. IOU's existing canister stores ciphertext before acknowledging **Pending**.
   This is not a ledger save. Closing either app does not remove the pending item.
4. On the linked sheet, the signed-in IOU owner sees **Pending from chat**. IOU
   recovers the existing recipient key, decrypts locally, and uses the original
   **Review & add** form or batch confirmation. This also works on another device
   signed in to the same IOU identity with access to the same key and sheet.
5. **Save** separately encrypts the ledger entries and writes one idempotent batch.
   Only then does IOU acknowledge the inbox item. A lost response can be retried
   with the same request ID without appending another batch. **Dismiss** explicitly
   removes the pending item without adding a ledger entry.

Pending items and acknowledgement tombstones have a 30-day retention period from
first delivery. Reviewing is not required immediately. An expired item is no longer
returned; bounded maintenance later reclaims its storage. Connect grants last up to
90 days; expiration/revocation blocks new deposits, not review of still-live items.
IOU retains at most 32 grants per owner, including revoked grants still inside
their retention window. In the original v1 connection flow, each explicit Connect creates a new grant; repeated
reconnections or an unknown setup outcome can exhaust that quota. Check whether
OpenChat accepted the prior connection before trying again. Revoke is not an
immediate quota reset: bounded cleanup removes eligible expired grants after their
30-day post-expiry retention. A capacity error must not trigger automatic reconnect,
discard pending items or erase the existing connection. These are IOU backend
limits, not OpenChat model or card-count rules.
An unknown save outcome remains pending; a confirmed save with a failed inbox
acknowledgement is shown as saved with pending cleanup, not as a failed ledger save.
Unreadable ciphertext, changed Types, or a missing recipient key are not silently
discarded or replaced.

The backend is encryption-blind but sees routing metadata, identities, sizes and
timing. The capability authorizes deposit only, not reading or acknowledging. It is
not proof of official OpenChat provenance. No official OpenChat canister changes,
message upload for verification, model changes, or new intermediary page are needed.
The generic inbox methods live in IOU's existing backend; other apps can implement
the same protocol without app-specific OpenChat code.

The older window-based handoff remains a compatibility path for previously connected
clients. Its unsaved receiver state was memory-only; those past handoffs are not
automatically migrated into the new inbox. Reconnect and use a newly reviewed card
for the new protocol; do not reinterpret an uncertain old delivery as a new save.

### Durable inbox live verification (2026-10-08)

The upgraded local backend passed 119 Rust tests. Each frozen frontend profile
(local and private-network) passed TypeScript, 104 unit tests and 123 integration
tests. Registry generation 9 was published. The frozen model prompts, processor
and model configuration were preserved; none of these checks reran model inference.

Live testing then established the following with one synthetic request:

- Actual Connect supplied a private inbox grant. A temporary sender harness used
  production OpenChat encryption and transport to deposit while all IOU pages were
  closed. The backend returned `Pending`; replaying the identical ciphertext and
  request ID returned `Pending` with `replayed: true`.
- Closing and reopening the entire isolated browser restored the decrypted request
  in the normal sheet's **Pending from chat**, without saving it.
- A second, independent fresh browser profile signed in as the same local simulated
  Internet Identity. No authentication state or key was copied between profiles;
  backend-backed key recovery decrypted the same pending request there.
- The existing **Review & add** form and **Add entry** action saved one synthetic
  12.34 USD entry. A normal UI reload showed exactly one matching synthetic row,
  22 history entries (previously 21), and no remaining pending header.

This proves the stated local encrypted transport, durable pending recovery and
normal IOU review/save/readback. The sender was a harness, not a complete journey
through OpenChat's normal inline card UI. Its localStorage held synthetic
ciphertext for replay; production encrypted OpenChat card storage was covered by
separate unit tests, not exercised by that harness. Simulated local identity is
not passkey/provider or production Internet Identity acceptance.

Both ARM64 and x86_64 APKs subsequently passed independent package verification:
the expected signer, unchanged native/authentication inputs and DEX parity, and
all 1,617 packaged frontend assets matched the reviewed build. The ARM64 artifact
SHA-256 is `51ec6e2ee7ad33e47201614aeacc258f3209263d217cb95b55a6160f2a1adfa9`.
This is build/embedded-asset verification, not installed-app flow acceptance.

The verified x86_64 APK was then installed over the existing emulator local-test
package without clearing its data. Its signer was unchanged; the normal `/chats`
page displayed the existing account avatar without a new sign-in. The runtime
reported `2.0.0-localtest.332edbd15feaba1360674ee62b28e7f3`, matching the verified
build, with native Credential Manager authentication and OTA disabled. Its APK
SHA-256 is `4ed415ca361e16e039ccd0037466a6cb30574f7a473670d84132efd6844e247c`.
Installation, startup and version checks passed. App discovery remained unverified
when the bounded check stopped because WebView debugging was slow. No new sign-in,
app connection, inference, delivery or Save was attempted. The new APK's complete
emulator and physical-phone flows remain unverified; no physical phone was connected
for this checkpoint.

The older dated acceptance records below remain evidence for their respective
builds, not verification of this new inbox.

Use **Apps → IOU → Connect**, select the named IOU account/sheet, and confirm
**Connect**. The client shows IOU's connection screen directly, not a transport
page or file-import form. No entry is shared or saved during connection.

After **Propose**, review the original inline card and select **Add to IOU**.
The approved fields are encrypted in OpenChat before delivery. IOU opens the
already-connected sheet and uses its existing **Pending from chat → Review & add**
entry form (or batch confirmation) and **Save**. There is no intermediate JSON
page, pairing-code step, manual draft picker, or second destination selection.
Receiving a draft never saves it automatically. Unavailable or changed account,
sheet, key or Type bindings fail closed; the UI explains the required correction.

Desktop browser verification on 2026-10-06 passed the repaired normal flow: reconnect
retained sign-in and showed the named account/sheet and Types; a synthetic 45.67
proposal opened the normal sheet directly through **Add to IOU**, with no intermediate
JSON page, manual IDs or transport button. **Review & add** used the existing entry
form and honored the selected Type's 10% fee. Explicit saving returned **Saved in IOU**
and OpenChat's **Saved** acknowledgement; fresh normal sheet navigation found exactly
one matching row, gross 45.67 and net 41.10.

That browser interaction used the repaired r1 preview. The subsequent r2 preview
adds the recovery-message correction directing users to **Apps → Reconnect**; its
source, output and unchanged transport headers were verified before activation at
the same origin. Its retained evidence is under
`F:/Temp/OpenChat-IOU/pr-flow-repair-20261006/web-r2/artifacts/`.

Browser r3 is now served at the same origin with the narrow Saved-status fix. Its
source/compiled UI, relay output and unchanged AI assets passed independent checks,
and the replacement preserved the exact security headers. Evidence is under
`F:/Temp/OpenChat-IOU/pr-flow-repair-20261006/web-r3/artifacts/`; its version is
`2.0.0-localtest.63d10d313e0ac88441122a01a18cdd98`. Subsequent actual browser checks
with IOU r4 retained the account and source-linked card after reload: no automatic
send or new tab, acknowledgement unchecked, and Reopen disabled. Explicit reopening
then Review & add and saving returned "Saved in IOU — the earlier save was already
accepted." OpenChat showed Saved and the corrected "The app reports that this request
was saved." Fresh history retained one row for each browser/native test note.

IOU r4's `source.json` is SHA-256
`bc0779909901f43369a64a8ff385058eff081aae8c8cda748f4e722cba523ff2`, under
`F:/Temp/OpenChat-IOU/pr-flow-repair-20261006/iou-r4/`. App/node TypeScript checks,
228 unit tests and 90 integration tests passed. Runtime source identity and HTTP
framing policy were checked; only exact localhost origins 5190, 5192 and 5193 are
allowed on the import/connect routes, with no wildcard.

The repaired x86 APK subsequently passed its normal connection and review/save
flow on persistent emulator-5554. Apps → IOU reconnect showed friendly sheet names
and Types; cancel/reopen reused the same fixed ports successfully. Propose → inline
card → Add to IOU opened the normal sheet's Pending from chat → Review & add and
unchanged entry form. Explicit Add entry saved synthetic 45.67 USD, 2026-10-06,
You owe, note `TEST ONLY - APK UI repair`, with the Type's 10% fee and net 41.10.
IOU displayed Saved in IOU and the native card displayed Add to IOU Saved.
The normal submit handler awaited its backend reload, and a subsequent sheet snapshot
contained the row with that unique test note, gross 45.67 and net 41.10. This is backend
reload readback, not a separate-session independent readback. The local form screenshot is
`F:/Temp/OpenChat-IOU/pr-flow-repair-20261006/emulator-normal-iou-form.png`.
A later fresh browser history page independently confirmed that native test-note row.
After the narrow status correction, the final x86 APK was installed in place and
retained the existing account and same card. Only explicit acknowledgement enabled
Reopen; the normal existing sign-in returned to the original IOU sheet and entry
form with the same date, note and 10% fee/net 41.10. Explicit Add entry returned the
earlier-save-already-accepted result, with one native test-note row. Back in OpenChat,
Saved and the corrected saved-status sentence were visible. Final local evidence is
`final-apk-normal-iou-review.png` and `final-apk-saved-card.png` under
`F:/Temp/OpenChat-IOU/pr-flow-repair-20261006/`.

The final x86 APK SHA-256 is
`1dab809a8af3aea89546c8b1f58499d29cf24842dc249bb48b1da5fdd56dd769`; the matching
ARM artifact is `84aa572be993bcf0f7f22265eda4ecbfdd78747414c45baf84b2d0ede351f0e0`.
Their shared build is `ab7e55a2161f1747404a2699cd01a3ea`, with source record SHA-256
`b90916cbf31b0695af427b4ae27d59baee105d8518c01b07c804deb3e2988f8c`. Both artifact
reports and `APK-COMPACT.json` are in `pr-flow-repair-20261006/apk-saved-status/artifacts/`
under the project temp root. This proves the stated synthetic review/replay flow,
not native GPU inference or physical-phone acceptance; ARM remains statically verified only.

The earlier stale-status and blocked Open active sheet issues are resolved. Actual
browser navigation now opens Details in a new top-level IOU account tab, where Open
active sheet works normally. The restricted receiving-frame CSP is unchanged.
No global release, new model-accuracy or public-provider qualification is claimed.

## Previous local-test checkpoint: 2026-10-06 (before this UI repair)

The tested sources are IOU `1ce9eef2105ced88aaa8b533018dbe6926223a40` and
OpenChat `d0b00668c342d6b4bc09f93e19c2f023c6c07926`. This checkpoint covers the
image and encrypted-delivery behavior on fork `main`, not complete PR UI parity
or a broader image-extraction contract. The extra transport/import pages were still
present in this checkpoint. Prompts, model weights, backend services and product code were unchanged
during these final checks. Normal setup uses **Apps**; review uses the restored
PR-style inline card at its source message, not the former private-draft manager panel.
Cards remain private and encrypted on the sender device; delivery still requires
sender approval followed by separate IOU review and Save.

- **Desktop images:** fresh normal-UI tests passed with both Gemma and the smaller
  all-q4 Qwen. The Arabic receipt produced 12,900 EGP, 2026-08-14 and Settlement.
  The date-range image produced 1,912.15 USD, 2026-07-19, the app-defined test Type
  and its **You owe** default, with the displayed July 19–August 6 range in the note.
  Qwen passed Arabic → date-range → Arabic without restart or model switching;
  Gemma passed the date-range image after switching back to its retained cache.
  Gemma's Arabic result also passed encrypted delivery, separate review/Save and
  fresh sheet readback in the dedicated acceptance account. The other proposals
  were inspected and cancelled, not saved. These browser results were directly
  observed by the testing agent; the independent record review did not replay them.
- **Final x86 APK:** in-place installation retained the existing account. Normal
  IOU reconnect passed. A restart before the final delivery restored the account,
  chat and prior private-card link, with usable app setup; restored fields were not
  separately reinspected. The reviewed synthetic 44.45 USD card passed encrypted
  handoff, matching receiver review, explicit Save, helper/APK **Saved** acknowledgement
  and a fresh normal sheet readback showing one matching row. Its date was
  2026-10-06, kind IOU and direction **You owe**; Type was unset and note empty.
  This verifies delivery fidelity, not extraction of the synthetic text's note or
  Type. No post-save restart or same-ID replay was tested in this final run. The
  earlier 44.44 test was left before receiver review and was not saved.
- **Remaining boundaries:** the foreground, secure emulator WebView exposes WebGPU
  but returns a null adapter. No device or model inference was requested, so native
  image inference has not passed. The matching ARM APK is built and statically
  verified but not installed on a physical phone; phone testing remains deferred.
  Prior scoped advisory deferrals remain unchanged; this run did not perform a
  fresh advisory scan or establish public-release acceptance. A successful reconnect
  does not prove the cause of previous intermittent failures.

The final APK SHA-256 values are
`09e9f1aee2bb6e0b4c1cee3217c0bb0e52b6df94dc253fc92e9c2b72987e3682`
(x86_64) and
`e19253bf1746ecdc401f20c76098dbb770442c44021ee6240b249006a403588f`
(aarch64). Evidence is retained locally in
`F:/Temp/OpenChat-IOU/pr-only-final-20261006/artifacts/acceptance-progress.json`
and `independent-acceptance-inventory.json` in that directory. The latter separates
artifact verification, saved UI evidence and direct browser observations. These
records do not turn browser passes into APK GPU acceptance. Original test images,
screenshots and account identifiers remain private local evidence, not repo fixtures.

## Restart the existing local-test environment

The general `scripts/live/start-environment.ps1` launcher belongs to the legacy
registered-app/local-OpenChat-canister integration. It is not the unofficial fork's
reboot entry point: changing its `openChatRepo` setting would still launch local
OpenChat backend flags and require the old app registration. Do not use it to
replace the unofficial client, or retarget its saved state to a new replica.

Reuse healthy processes first. When a service is stopped, restore only these
existing components, in order, without rebuilding or reinstalling anything:

1. From this IOU checkout, check the strict recovered manager with
   `pwsh -File scripts/live/pocketic-recovered.ps1 status -EnvironmentConfigPath scripts/live/start-environment.local.json`.
   Use the same command with `start` only when it is stopped. Preserve the existing
   config, state directory, canisters and account data, even where historical names
   mention OpenChat. Do not substitute `dfx start`, reset, deploy or automatic repair.
   An incomplete checkpoint requires separate backup-first recovery approval.
2. Start only the known verified IOU frontend snapshot, not a dirty development
   checkout containing unaccepted model/processor experiments. The UI-repair source
   activated on 2026-10-06 is
   `F:/Temp/OpenChat-IOU/pr-flow-repair-20261006/iou-r4/source`; its `source.json`
   receipt is SHA-256 `bc0779909901f43369a64a8ff385058eff081aae8c8cda748f4e722cba523ff2`.
   This supersedes the initial repair snapshot `iou/source` (receipt SHA-256
   `f3fc197e45c0e48fc69f45c06858c1dea59bb10b2fe035d13e2af47959c7033d`) and the
   earlier `iou-pr-card-ui-preview-20261005` restart example; both remain historical.
   Activation does not establish successful delivery or Save. From the repaired
   source directory use its installed Vite command
   `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 3000 --strictPort`.
   The launcher must pass an explicitly present empty `VITE_IC_URL` in the child
   environment, plus `VITE_LOCAL_IMPORT_SENDER_ORIGIN=http://localhost:5190` for
   this browser origin. Also preserve the exact local framing configuration described
   below: browser `http://localhost:5190`, native handoff `http://localhost:5192`,
   and native setup `http://localhost:5193`. Keep the existing local network, port and canister settings;
   do not let a stale LAN override replace the preserved local gateway. Use the
   existing IOU-only launcher that supplies these values, not the general launcher.
3. From the fork checkout, reuse the selected, already verified frozen web artifact:
   `node scripts/preview-unofficial-local-web.mjs --directory <existing-frozen-web-build>`.
   Supply its absolute directory; do not rebuild, change its origin or clear model
   caches merely to restart it. Open the artifact's `http://localhost:5190` address,
   not its IP alias. A `/communities` health request must accept `text/html`.

The recovered replica serves IOU and its local identity service; it does not change
the unofficial client's official OpenChat backend. HTTP readiness is not proof of
signed-in app connection, model inference or successful encrypted delivery.

## Browser handoff prerequisite

Before delivering drafts through the browser workflow, configure the IOU frontend
with the exact unofficial client's sender origin. For a client served at
`http://localhost:5190`, pass this setting in the environment used to launch Vite
(or to build the frontend when serving built assets):

```text
VITE_LOCAL_IMPORT_SENDER_ORIGIN=http://localhost:5190
```

This is the sender's origin, not IOU's own origin (for example,
`http://localhost:3000`). It must be a canonical HTTP loopback origin: no trailing
slash, path, query, fragment or wildcard. `localhost` and `127.0.0.1` are different
origins. IOU never learns or automatically trusts a sender origin from an incoming
message; a valid browser handoff also requires its launch nonce and exact parent
frame window (or the original opener in the historical top-level path).

Restart the IOU Vite frontend after changing this startup configuration. For built
assets, rebuild with the setting and serve the new assets; a browser reload alone
does not apply a changed launch/build environment. IOU can still render, sign in
and connect without this setting, so those steps do not prove that browser handoff
is configured. If delivery remains at **Open the card with Add to IOU in OpenChat**
or the connection expires, check the effective frontend setting for a missing,
invalid or outdated origin, as well as whether the nonce or exact parent-window
binding was lost. Setup-file preparation is historical recovery, not a current
connection step.

The native flow uses dedicated local-test transport origins, not arbitrary local
ports. Its one-use launch capability is erased before IOU loads. The receiver binds
the exact parent, origin and nonce and accepts ciphertext only; recipient decryption
and the ordinary IOU review/Save remain required. Setup sharing still requires the
user's explicit **Connect**. None of this proves official OpenChat provenance.

For the local development frontend only, pass `IOU_LOCAL_APP_FRAME_ORIGINS` as a
JSON array of exact loopback origins for the browser relay and native setup/handoff
listeners. No wildcard is allowed. This opt-in affects only `/openchat/connect` and
`/openchat/import`, and is ignored by production builds and non-local networks.

## Connect IOU

Use the client's configured public app directory for normal setup. No manual catalog
or processor file downloads or uploads are required.

1. In OpenChat, open **Apps**. IOU appears automatically when it is listed
   in the operator-configured directory.
2. Choose **Connect** for IOU. The IOU connection screen opens directly in the
   client; opening `/openchat/connect` directly does not create a setup request.
3. Check the exact **Requesting client** address. Continue only if you recognize
   it and just started this request. Sign in to IOU separately if needed and verify
   the account. Choose **Connect**, then return to OpenChat and check that it accepted
   the account connection. Account Connect/Reconnect has no sheet picker.
4. Enable IOU in the intended chat and choose **Open setup** in that chat's app
   settings. Choose the intended named **Sheet**; an existing mapping is preselected.
   Wait for its private Types to load. Review the account/sheet reminder, currency,
   Type names, keywords and **Owed to you** / **You owe** directions.
   IOU also recovers the signed-in user's delivery keypair and shares ONLY its public
   key/fingerprint and bound recipient context. The private key and separate sheet key,
   fees, schedules, entries and sign-in credentials remain in IOU. No message/image/draft
   is exchanged during setup. Missing or changed delivery keys require reconnection.
5. Choose **Save setup**, then return to OpenChat and check that it accepted this
   chat's setup. Connection does not automatically enable other chats or save entries.

Setup-v1 compatibility clients combine account connection and sheet selection in
one **Connect** screen. That older flow does not implement the separate scoped
account/chat setup above.

The setup request expires after ten minutes. If the requester closes, the page
reloads, or the identity/destination changes during setup, start a fresh **Connect**
request. If sharing has an unknown outcome, check OpenChat first; IOU does not
automatically retry. The APK uses its separate local setup bridge, not a browser
login bridge; this procedure is not a claim of native runtime acceptance.

## Setup updates and local storage

Opening **Apps** refreshes the public directory. Compatible updates from
the same approved publisher are verified and installed without file uploads or
another APK update, provided the client already supports the directory and protocol.
Updates wait while processing or any private cards are retained; a failed update
retains the last working setup. Changes requiring a new private recipe, trust or destination
ask for **Reconnect**. Account reconnect refreshes the existing chat destinations;
it does not reassign them or silently accept another IOU identity. To choose a
different sheet for one chat, use that chat's **Open setup** and **Save setup**.
After changing Types or currency, explicitly refresh and review the affected setup
rather than assuming the remembered copy changed.
Changing publisher origin or requiring a new client protocol is not a compatible update.

The local-test client remembers connected or imported setup, selected app/action and
enabled chats on this device, isolated by the signed-in OpenChat account and backend.
That local setup contains private Type names and an inbox write capability. New
setup writes are AES-GCM encrypted in device-local IndexedDB with a nonextractable
key; this is not chat encryption or synchronization. Legacy setup remains readable
and is encrypted on the next write. Same-origin client code can use the key, so this
does not protect against malicious client code. Forgetting setup removes its key.
Use the app's existing **Disconnect** control to remove its connection. Disconnecting
is device-local: it does not invoke IOU's authenticated grant-revocation endpoint.
A previously shared write capability therefore remains valid until its expiry or
explicit backend revocation; Disconnect is not a claim of remote authority removal.
It stops use of that connection on this client and does not erase retained cards or
pending requests already delivered to IOU. Private cards have no fixed count limit and are
saved separately in a device-local encrypted collection, scoped to OpenChat
account/backend, with a 16 MiB collection safety budget. Normal cards remain bounded
to 256 KiB; only a card containing a sealed inbox request may use the 384 KiB bound
for its exact encrypted delivery bytes. The collection budget remains 16 MiB.
Approval tokens remain ephemeral. Inbox cards also retain the exact encrypted
delivery bytes and receipt inside the encrypted local card for safe retries.
Restoring a card requires fresh
review; an attempted delivery retains the same request ID and is never retried automatically.
Signing out clears the live card view but retains the encrypted local collection.
Cancel the selected unsent card or use **Details → Remove from this device** on a
retained card to remove it, retaining the other cards and collection key. The former
global **Forget** control belonged to the removed private-app manager and is not a
normal-flow instruction.
These local operations do not recall a delivered request or undo an entry already saved in IOU.

## Historical recovery with setup files

The following file-based workflow records the older recovery UI. The current
normal **Apps → Connect** flow does not require the removed **Private apps**
workspace or manual files; do not use these historical controls as current UI
acceptance instructions.

Keep file export/import for explicit recovery in a compatible historical client,
not normal connection. Manually
imported setup is not silently assigned to a publisher or replaced automatically.
When using this recovery path, prepare and import a fresh matching pair after an update.

1. Open `/openchat/import` on the intended IOU deployment and sign in to IOU.
2. Choose an existing active sheet and select **Load this sheet’s private Types**.
3. Expand **Private local-client setup**, then select **Prepare setup files**.
   IOU fetches the public processor and its metadata, verifies its size and SHA-256,
   and prepares the catalog locally. This step does not download either file.
4. Select each download button separately:

   - **Download private setup catalog** → `iou-private-local-app.json`
   - **Download public processor** → `iou-local-processor.js`
5. Confirm that both files finished saving in the browser’s Downloads list. A
   **Download requested** notice is not proof that the browser saved the file. If
   either file is missing or blocked, inspect the browser’s exact status before
   retrying; do not disable browser security protections.
6. In the unofficial client’s **Private apps** workspace, import the catalog and
   matching processor using its file controls. Do not execute the processor file
   directly or paste it into browser developer tools.

The catalog contains private Type names, keywords, directions and currency context.
Keep it out of public repositories and shared diagnostic attachments. The processor
is public code, but the client must still verify it against the catalog’s digest.
Prepare a fresh pair after changing the IOU account, sheet, Types or currency.
Prepared download controls are invalidated when their loaded context changes.

## Saved Types in the sender's private draft

Connected or exported private setup declares IOU's Type labels, IDs and direction
defaults through OpenChat's generic named-choice editor. Selecting a Type updates
its ID/name and direction, never the independent IOU/Settlement kind. Direction edited explicitly
by the user is preserved, including an edit to the same value. Clearing the Type
restores the pre-Type direction unless it was manually edited. Different rows have
independent history; neither selection nor clearing repeats model processing.

The private processor context opts into this host behavior only when the paired
selector is exported. Older contexts retain their previous behavior; public or
empty-Type exports do not include the selector. A client must support the new
declaration before accepting it. Directory-managed setup follows the update/reconnect
rules above; manually imported recovery setup requires a fresh matching pair.

The baseline is held only in the sender's draft session. Explicit field edits are
authoritative; there is no advanced-JSON editor in the normal user flow.
After card recovery following reload or logout/return, all saved values are treated
as manual. Changing Type still updates its ID/name but does not reapply direction
defaults; clearing Type cannot reconstruct the former direction. Edit direction
explicitly after restoration.
The receiver gets only the final reviewed fields and cannot recover pre-Type values
from sender history. IOU's receiving page remains responsible for current-sheet
validation, fees and schedules. Type labels must be distinct, visible and different
from the selector's None label; invalid labels fail export rather than creating an
unusable catalog.

## Review and deliver

1. Create and review a private draft in the client. Check every outgoing field and
   the destination before explicitly approving the handoff.
2. OpenChat encrypts the fields before its inbox deposit (or legacy relay/native handoff). IOU accepts only the
   version-2 encrypted offer, not legacy plaintext. Authenticate separately in IOU
   if necessary. The already-linked receiving account/sheet is resolved and checked
   automatically before local decryption with the user's recovered
   delivery private key. Recipient context, destination, action, revision and request ID
   are cryptographically bound. The context is not proof of OpenChat chat membership.
3. In the normal sheet, choose **Pending from chat → Review & add** and review the
   existing entry form or batch confirmation. This final review includes applicable
   IOU-owned fees and schedules, not just the model’s proposed values.
4. Select **Save** only for the reviewed entry. Entry contents are separately encrypted
   locally for the selected sheet before the authenticated write.

Public discovery never includes recipient keys. The trusted exact-origin Connect flow
provisions them. Delivery uses ephemeral P-256 ECDH, HKDF-SHA256 and AES-256-GCM;
it is independent of ledger sheet encryption. Routing/key/context metadata and message
sizes remain visible; recipientContext is base64url, not encryption. Only authorized IOU
frontend code decrypts the fields for review; malicious frontend code after decryption
remains a threat. No encrypted envelope authenticates the truth of model-extracted fields.

If delivery or saving has an unknown outcome, check the original IOU sheet first.
Use the existing draft’s explicit reopen/retry flow with the same import ID, account
and sheet. Do not generate a new proposal to retry a save: a new proposal has a new
identity and may produce a duplicate. A received acknowledgement alone does not
prove that an entry was persisted.

For the older window-based compatibility path only, IOU removes the browser handshake nonce from its URL after capturing it. Reloading
or closing the receiver loses its in-memory handoff and any unsaved received draft;
reloading the plain URL does not restore that browser connection. After correcting
the frontend configuration, use the existing client draft's explicit same-ID retry
(unknown delivery) or reopen (received but unsaved), with fresh consent. Do not
generate a replacement proposal merely to reconnect.

Current local-test acceptance records distinguish successful builds/unit tests from
real authenticated model inference, handoff and saved-entry verification. Do not
treat setup download, APK startup or a rendered draft as end-to-end acceptance.

## Encrypted-handoff source checkpoint: 2026-10-01

Implemented: mandatory sender-side encryption, authenticated recipient-key recovery,
local decryption for second review, and the existing separately encrypted sheet save.
OpenChat saves the active private card encrypted on-device; IOU's received unsaved
draft remains in memory. Old plaintext offers are rejected. Existing connections
without a delivery key must reconnect; there is no plaintext compatibility fallback.

The earlier checkpoint passed 1,946 IOU OpenChat/batch unit tests. After the image-test
additions, the cross-checkout integration passed 98 tests and both IOU TypeScript
checks passed. The integration uses the real OpenChat sender
crypto and IOU receiver, including wrong-key/tamper rejection, no writes on receive,
second-review invalidation and same-ID retry/conflict handling. It mocks authenticated
backend writes; it is not a real saved-entry or installed-APK acceptance test.

The matching OpenChat checkpoint passed 588 feature tests, 777 scoped offline CI
contracts and 18 native handoff harness tests. Actual Edge reload tests verified
encrypted local-card recovery and cross-tab attempted-send protection using synthetic
data only. No model prompt or processor changes were needed for this correction.
The subsequent full OpenChat frontend regression passed 5,065 tests across 338 files,
with no failures, skips or unhandled errors after repairing one outdated test mock.

The expanded integration suite replays four existing, sanitized small-Qwen/Gemma
Arabic and date-range outputs through the real host parser, IOU processor, generic
Type initialization and encrypted handoff. It verifies the original expected fields
and no write before IOU approval, without rerunning either model. A further scoped
unit run passed 421 tests, including two explicit characterizations showing that the
unchanged image contracts cannot preserve printed direction, description or footer-only
Type evidence they never request. Those characterizations are not image-accuracy
passes; the retained historical strict-format failure is still identified as such.

Final review also reproduced and corrected a key-clear race: receive-only recovery
could complete a native secure-storage write after deletion. Recovery now participates
in active-operation tracking and cannot start while deletion is pending. The two
regressions failed before the fix; both key-lifecycle suites now pass 42 tests. The
receive-only path still cannot create or replace keys. A fresh production build passed,
and the existing local frontend serves the correction. No canister update was needed.

Both OpenChat web layouts and local-test APK ABIs were subsequently rebuilt with the
encrypted transport. The local web preview serves the new v2 bundle; IOU's existing
local frontend serves this receiver. The IOU production build also passed. Older
plaintext builds remain incompatible and are not made safe by the source tests.

### Authenticated browser verification

On 2026-10-01, the existing Edge accounts and synthetic test sheet completed a fresh
Connect, sender review, encrypted delivery, authenticated local decryption, second
IOU review and explicit save. A fresh sheet reload confirmed the saved amount, date,
direction and unique test note, including the selected Type's fee and due schedule.

The sender card survived reload before delivery with its original request ID and no
restored consent. After closing the delivery windows and reloading again, it restored
as a locked, uncertain request. An explicitly approved same-ID retry reached IOU,
required its second review, and returned that the earlier save was already accepted.
A fresh sheet reload showed exactly one matching entry, not a duplicate.

This is actual desktop-browser and existing local-backend evidence, not a mocked
write. It uses synthetic text and a manually reviewed test note; it is not image
accuracy, mobile layout, native APK handoff or physical-phone GPU acceptance. No
OpenChat backend change, new account, new sheet or canister deployment was needed.

Separate responsive checks subsequently passed for both web layouts at 390 by 844:
the encrypted sender card restored without consent or horizontal overflow, and both
model screens showed the retained downloads and optional voice controls. No model
configuration changed and no delivery occurred in those checks. They establish the
browser layout only, not Android runtime behavior.
