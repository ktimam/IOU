# OpenChat Private and IOU: development retrospective

Status date: **19 October 2026, Africa/Cairo**. Historical evidence begins on 1 August 2026. This report covers the retained conversation, repository history, validation records and release receipts through the first published OpenChat Private APK. It records unsuccessful approaches as well as successful ones; it is not a claim that every historical test or requested feature passed.

Companion documents: [summary tables](openchat-iou-summary-2026-10-19.md), [sanitized conversation export](../../chats/2026-10-19-openchat-iou/README.md), [current connection guide](../openchat-private-import.md), [current key/recovery design](../account-vault.md).

## 1. Outcome at the reporting cutoff

OpenChat Private 0.1.0 is [published in the fork](https://github.com/ktimam/open-chat/releases/tag/openchat-private-v0.1.0). Publication was 18 October at 21:02:02 UTC, which is **19 October at 00:02:02 Cairo time**. The unofficial client runs against official OpenChat chat/identity canisters without requiring changes to those canisters. IOU, app discovery and Android passkey association remain separately operated application infrastructure.

The current integration is **Connect → copy code → open IOU → confirm → Check connection**, followed by chat-specific sheet setup where necessary. Proposals use the app's card, and Add to IOU sends encrypted data into IOU's durable pending inbox. Final IOU review/save is separate from delivery. Technical setup panels, mandatory file imports and transport/debug pages were not accepted as replacements for that flow.

The smaller Qwen model and Gemma remain supported. Inference is local; IOU supplies domain semantics. The mixed-precision Qwen distribution was retired. Compatible models can be configured through the validated catalog; unsupported architectures still require runtime implementation. Audio remains optional, with a documented accuracy limitation.

IOU bootstraps an account root, generates additional sheet keys locally and stores encrypted key backups. Remembered devices and ordinary password-manager recovery avoid another VetKD derivation in the tested normal paths. This does **not** mean all operations have zero execution/storage cost, nor that a real-user mainnet recovery cost was successfully measured.

| Current evidence | Exact scope |
| --- | --- |
| IOU source | [`8fd11a3`](https://github.com/ktimam/IOU/commit/8fd11a320c6ffb2591e759e184c34868a66648d9): encrypted code connection fixes |
| APK source | [`8946db226`](https://github.com/ktimam/open-chat/commit/8946db226f3de1d947cf09542733da9596f1c8ab): scoped-check repairs after the functional code-flow build |
| Subsequent OpenChat main | [`1fc6860b6`](https://github.com/ktimam/open-chat/commit/1fc6860b6021e09c53159d768525f0485522affc): release/advisory decision documentation |
| Published Android artifact | `openchat-private-0.1.0-aarch64.apk`; ARM64; package `io.github.ktimam.openchatprivate`; 80,331,752 bytes |
| APK SHA-256 | `5d6d791147184b42b8e11befa40a027e368f33eec1c2c5ef545a977b01574dd4` |
| Physical-phone live acceptance | Preceding functional source `54f3307` plus current IOU: code connection, Arabic 12,900 EGP proposal, one delivery and matching live Pending item |
| Fresh published APK | Independently verified source, signing identity, package, embedded assets, ABI and passkey association; **no fresh device inference on this exact artifact** |
| Release qualification | Functional checks passed; dependency advisory job remained failed under explicit finding-specific user deferral |

The phone delivery was left **pending**, not saved into the ledger. Sent, Pending and saved are three different states.

## 2. How to read this history

Repeated retries, approvals, reconnects and status questions are grouped by cause rather than counted as new features. The companion export preserves available visible exchanges chronologically, subject to privacy redaction.

Four distinctions govern the conclusions:

1. A user report establishes an experienced symptom, not necessarily its cause.
2. Source, served web bundle, installed APK and deployed canister are separate artifacts. A commit updates none of the others automatically.
3. GPU execution and valid JSON do not establish correct amount, currency, date, Type or note.
4. Historical passes qualify their recorded builds. Combining different builds' results does not create a new end-to-end pass.

Older documents sometimes say “current” about an August/September checkpoint. Those statements are historical. The evidence index below identifies current guidance and superseded designs.

## 3. Original integration and environment — August

### 3.1 The actual first task: security review and two-PR plan

The conversation began with a **read-only review of the entire IOU application and only the user's OpenChat fork changes**, using code, documentation and existing project-chat history as evidence. It did not begin as a model-only task. Historical chat assertions were treated as hypotheses, not proof. The initial response proposed numerous small PR stages; the user clarified that delivery should be exactly two main PRs: local models, and generic app/cards interfaces. Subsequent planning retained security gates inside those two slices.

The initial review found production sheet creation/recovery key mismatch, closed-sheet key authorization problems, same-browser-profile account/key isolation defects, plaintext closing balances, weak initialization/registration ownership binding, malformed-entry UI failures, unbounded storage/query work and CSV formula risks. Fork findings included forged card delivery destinations, mutable published manifests, a verifier-await race, registry name squatting, model-deletion path traversal/collisions, unbounded privileged downloads and fail-open browser model integrity handling. These were findings against the then-current branches, not a statement that all remain present in the release.

The four-user development setup used **four separate persistent profiles**. After the user clarified this, the review corrected its scope: separate profiles did not leak local keys between those users; switching principals inside one profile and losing a profile still needed protection. Development-only plaintext test-key storage was not treated as the production design. This correction matters: the retrospective does not repeat the broader initial severity claim without its stated conditions.

The earliest test evidence was also limited: 493 IOU frontend tests and 19 Rust tests did not exercise the actual production create/reload/member key lifecycle. The E2E harness could exit successfully when its replica was unavailable. Some model tests existed only as untracked or uncommitted work, so their local pass did not establish branch/CI coverage. Those gaps motivated adversarial key-lifecycle, profile-isolation, exact-routing, concurrency, download/deletion and cross-language fixtures. August hardening is recorded in `db7db41` and the [security review](../SECURITY-REVIEW-2026-08-01.md); current acceptance must still be read from the later source-bound records, not inferred from the original audit list.

### 3.2 Security, app cards and chat routing

Early work reviewed card provenance, exact payload collection, encrypted delivery, permissions, batch imports and per-chat routing. The original PR used custom OpenChat registry, key-linking, card-attestation and ActionInbox APIs. It worked in the co-deployed development stack but was not available on unchanged official backends.

Trusted cards became values-first: the host verified app/revision/action/content, displayed the app presentation and owned confirmation. The iframe was isolated rather than given ordinary same-origin access. Account-level linking and a chat's sheet assignment were separate lifecycles. Tests matured from hydration and mocked imports into authenticated routing, exact-sheet pending visibility and atomic multi-entry saves.

Fixes included Candid `nat64` vectors, matching client/backend validation bounds, caller-keyed chat routes and linked-sheet authorization. IOU commits `17a9287`, `22db337`, `7f1d19f`, `ce4f39b`, `4297711` and `3216379` record that work. Some established behavior was later lost during the fork transition and had to be restored. See [historical linking](../openchat-linking.md) and [August review](../SECURITY-REVIEW-2026-08-01.md).

### 3.3 Starting the whole environment reliably

PC restarts repeatedly left incomplete environments: a frontend without its worker, unavailable IOU, stale app registration, stopped routes or incomplete PocketIC checkpoints. A page rendering was not proof that its dependencies were ready. Parameterized, identifier-free scripts added actual restarted-frontend and fail-closed readiness checks (`8a4b34b`, `e27c62f`, `aa223e9`).

The user required project-specific temporary storage on the selected temp drive. Model artifacts, WSL builds, caches and agent diagnostics accumulated substantially. Cleanup needed inventories and ownership checks, not removal of active models or databases. Windows locks sometimes required controlled server/emulator stops. Incomplete local state used approved backup-first recovery, not silent canister/data resets.

The unofficial client later stopped requiring the original full local OpenChat stack. Its restart sequence must not accidentally start the legacy profile. The [runbook](../local-dev-runbook.md) and current private-import guide distinguish them. These operational fixes restored availability; they did not independently fix model accuracy or provider authentication.

Earlier sustained CPU use had a concrete watcher-scope cause: Vite watched rebuildable Rust/Android output, profiles and other large trees. Narrowed watchers, native events and strict port checks removed that loop; a historical warm sample recorded roughly 0.08% of one core per Vite process. Separate evidence implicated a third-party GlassWire process-tracking/log loop in memory growth. Restarting it relieved the symptom, but narrowing Vite watchers was not claimed to repair that third-party application. Browser-control failures also had their own causes, including excluded debugging-port ranges and later extension/control timeouts. They were not evidence that the app's sign-in or model was broken.

Developer/end-user architecture illustrations and guides were created in the respective OpenChat/IOU documentation areas. Multiple versions and stale current-status wording later confused the handoff. The enduring requirement is one clearly identified current guide plus dated historical evidence, not more competing UI designs or unlabelled diagrams. This retrospective adds that index without regenerating artwork or changing application behavior.

## 4. Models, images and WebGPU — late August to September

### 4.1 Earlier compact-model and runtime searches

Before the final all-WebGPU path, the chat included a wider search through native/browser/Wllama and compact extraction approaches. The following are historical screening outcomes, not a new evaluation of current upstream models. Published benchmark scores were used to select candidates, but real application cases determined whether they qualified.

| Candidate / approach | What was tried and reported | Decision at that checkpoint |
| --- | --- | --- |
| Qwen3.5 0.8B multimodal | Smaller model/projector, reduced or quantized context/cache and phone input limits | Failed source accuracy, including amount scaling and missing/invented dates; initial recommendation was withdrawn |
| Qwen2.5 0.5B text | Fast compact text extraction | Dropped notes/date and selected wrong direction; not qualified merely for speed |
| Qwen2.5 1.5B | Download initially failed; retry completed and verified, then ran real cases | Accuracy still failed despite roughly 7.5–10.3-second runs; download recovery did not make the model acceptable |
| SmolVLM 500M / SmolVLM2-500M V2 | Small direct vision models through actual production-seam cases | Amount/date/cardinality failures; the V2 screen failed every model-mediated case |
| InternVL3.5-1B | Pinned language/projector files, full prompt and shorter-prompt experiment | Five of six cases failed at the recorded screen; invented note/date content and collapsed multiple entries; compact prompt did not rescue it |
| NuExtract-1.5-tiny after OCR | Tesseract text followed by one purpose-trained schema pass; template then purpose-field variant | Good speed/amount/currency on simple text, but wrong semantic field then missing purpose; rejected instead of weakening required fields |
| Tesseract / Granite-Docling / GLM-OCR | Specialized local-reader/OCR alternatives screened on receipt cases | Tesseract plus source-grounded processing became a useful explicit reader path; no blanket qualification of the other candidates |
| LFM/LLaVA and early Gemma/Qwen native paths | Additional compatibility, memory, latency and accuracy screens | No general mobile-browser approval at those early checkpoints; later runtime/prompt work superseded early Gemma/Qwen verdicts |

Some early recommendations said not to use Qwen on the mobile browser or proposed OCR as the practical replacement. Those statements were later superseded by the user's explicit requirement to fix model-only WebGPU and by successful source-bound Qwen/Gemma runs. They must not be quoted as the current catalog policy. Likewise, early Gemma-native failures and test-harness corrections did not establish that the later WebGPU build was broken. The [August transcript](../../chats/2026-10-19-openchat-iou/visible-chat-2026-08.md) preserves the changing evidence and decisions.

### 4.2 OCR success was not model success

The Arabic receipt showed **12,900 EGP** and a date. Model proposals initially invented USD amounts, misplaced digits, omitted dates or read the wrong date. OCR eventually worked while model inference still failed. The user explicitly required the model path, including the 2B decoder, to use WebGPU; OCR was not an acceptable undisclosed fallback for a Model only test.

Distorted chat images, missing suggestion buttons, inference crashes and wrong extracted dates were separate faults. Work separated model input resizing from display dimensions, repaired worker loading/app availability, exposed model settings and retained OCR/local-reader as an explicit option. UI v1, UI v2 and APK all needed corresponding checks; one surface's success did not qualify the others.

A model-only acceptance therefore had to use the selected model, actual image bytes, GPU execution, app processing and final card. Mocked extraction/OCR results could test downstream validation but not this inference path.

### 4.3 Phone GPU and repeated-use failures

Symptoms included a black flash, destroyed/lost WebGPU devices, `vkQueueSubmit` during `embed_tokens`, and a first image succeeding while a second crashed. These were runtime/lifecycle failures, not adequately explained by model hallucination.

Corrections covered session/device retirement, worker ownership, bounded image sizing, cache/version consistency and submission/readback sequencing. Gemma required tensors from the correct WebGPU ONNX runtime, reusable embedding pipelines and serialized asynchronous pipeline compilation. A Qualcomm-crashing FlashAttention route was avoided while retaining expected attention semantics through checked shader behavior. OpenChat commits include `c7299aa11`, `b01216b94`, `42e519e10` and `97ab1e985`.

Repeated proposals, model switching and residual-worker/resource checks became explicit acceptance gates. Successful initialization once was insufficient. An emulator lacking a usable WebGPU adapter was not made to pass by bypassing the check; emulator UI/auth/delivery coverage is not physical-phone GPU coverage.

### 4.4 Download readiness, cache retention and optional audio

Downloading only when proposing an image, repeated update prompts and misleading unsupported-image errors made model state unclear. Readiness/download handling moved into model management, downloaded models were retained when switching, and base artifacts were separated from optional modalities. Reconnect should not unnecessarily extract an image twice.

The user required audio to stay optional. Tests exercised voice-message transport, decoding, optional downloads and real-recording transcription. One cached test concealed an uncached audio download failure. Later, a real recording worked while a synthetic voice case failed despite valid decoded input. The user accepted documenting that limitation; audio was neither removed nor declared generally accurate.

The validated model catalog controls compatible IDs, revisions/hashes, precision, capabilities, optional audio and generation settings. Compatible additions/removals/configuration do not require source changes. New architectures, tensor contracts or larger safety limits still require adapter code. See [OpenChat model catalog](https://github.com/ktimam/open-chat/blob/1fc6860b6021e09c53159d768525f0485522affc/docs/webgpu-model-catalog.md).

### 4.5 Qwen correctness and common-prompt experiments

GPU completion still produced semantic errors: shifted decimal amounts, guessed currency, wrong Type and headings used as notes/dates. Export/runtime defects were investigated separately from prompts. Corrections included interleaved mRoPE, missing DeepStack mergers/residual injections, decoder position-table bounds and input geometry. Those improved execution fidelity without proving all extracted fields correct.

Common-prompt candidates repeatedly traded failures between Gemma and Qwen. Shorter prompts, stricter output formats, larger token limits and normalization could finish JSON while losing a date, misclassifying a range or adding unrelated text. Interrupted comparisons did not count as both-model passes. Failed candidates were not accepted by weakening expectations.

The eventual approved choice was **app-owned per-model prompts** selected through generic configuration. IOU owns transaction instructions; OpenChat is not a Reservation detector or IOU date parser. See [prompt sensitivity investigation](../model-prompt-sensitivity-investigation.md) and [source-bound readiness](https://github.com/ktimam/open-chat/blob/1fc6860b6021e09c53159d768525f0485522affc/docs/releases/model-app-readiness.md).

### 4.6 Mixed precision was not the final distribution

A mixed FP16-embedding/q4-decoder Qwen candidate improved some examples and was exercised through repeated phone proposals/cache switching. It did not eliminate broader corpus failures, and package size/hosting requirements conflicted with the user's preferences.

The approximately **1.7 GiB all-q4 Qwen** worked with the tested app prompt and was chosen. Mixed-only artifacts/profile/route/phone cache were retired while shared assets and historical evidence remained. Three consecutive phone proposals passed at the September checkpoint, including repeating the first image without restarting; no weights were downloaded during inference.

A source/card screen still retained a receipt-note heading/subtitle mismatch, recorded as **9/10**, not complete accuracy. The user accepted keeping that tested prompt with the limitation. October live acceptance likewise proved the reference amount/currency/date and delivery, not universal note accuracy. Neither model is qualified on every image.

## 5. App ownership and why tests missed failures

### 5.1 IOU owns the semantics

The user repeatedly rejected host declarations of IOU fields and hard-coded Reservation logic. IOU supplies prompts, labels, schema, saved Type choices, currency interpretation and direction defaults. Other apps can process different images. OpenChat supplies generic inference, constrained processor/card interfaces and consent controls.

IOU's existing `$` mapping was approved for images as well as text/OCR. Saved Type direction had to match “Owed to you” / “You owe.” Range notes needed real endpoints, not “From Reservation to Total Payout.” Constructing a range note before validating endpoints was an app bug, not just model uncertainty.

The distinct `/ai` / Process with AI feature was restored when lost during integration. Local inference does not grant an app unrestricted history; input scope and outbound sharing still require boundaries. See [app boundary review](../openchat-app-boundary-review.md).

### 5.2 Concrete gaps in earlier verification

| Gap | What escaped | Correction / acceptance rule |
| --- | --- | --- |
| Fixture supplied model output | Real phone output was malformed or factually wrong | Add actual inference and source-field assertions; retain deterministic contract tests for their own purpose |
| Runtime/JSON pass treated as accuracy | Wrong amount, date, currency or note | Score execution, semantic correctness and delivery separately |
| Wrong image / narrow corpus | A pass did not exercise the reported Arabic receipt | Identify exact fixtures and expected fields |
| Incomplete CI discovery | Eight named tests omitted worker/runtime triggers; packaging suite excluded | Inventory actual tests/paths and test discovery itself |
| Stale worker or APK | Source changed while old runtime still executed | Rebuild watched helpers and compare built/served/installed hashes |
| Form tested without backend | Actual initial payload included interval/evidence fields rejected by Rust | Exact-byte cross-repository fixtures through real builder, processor and deserializer |
| Narrow focused tests | Mobile auth translations, profile/license bindings failed later | Full relevant frontend and scoped release checks |
| Emulator mistaken for physical GPU | Different adapter/shader/lifecycle | Record hardware/provider and unsupported capabilities explicitly |
| Sent mistaken for saved | Missing in the inspected sheet, or only Pending | Verify destination; distinguish delivery, review and ledger Save |
| Mixed artifacts combined into a pass | New APK labelled tested using an older phone run | Bind every claim to source, bundle, deployment and device |

The lesson is not that testing has no value; green tests were being used to answer questions outside their coverage. This report keeps failed/incomplete results visible rather than rewriting them as successes.

## 6. PR branches to one unofficial-client main

### 6.1 Changed backend constraint

Originally the two PR slices covered local models and app/card interfaces, including custom OpenChat backend APIs. When upstream PR acceptance ceased to be the shipping plan, the user requested a single fork main, upstream merges and an unofficial client using official chat/identity services unchanged.

User-facing workflows could be preserved, but not all backend semantics. Official clients do not acquire the fork's private cards; the fork cannot invent official app attestations or membership proofs. Client-local cards and app-owned services replaced those custom dependencies. This was not merely a build flag. The [release plan](../unofficial-openchat-client-release-plan.md) records that distinction.

Consolidation preserved the feature stack and stopped treating old development branches as shipping heads. The October upstream merge is `5a77b86fd`, incorporating upstream `11ed95078`. Historical branch names remain evidence, not the current development model.

### 6.2 Authentication detours and actual RP regression

Local experiments proved explicit linking could preserve the existing OpenChat identity. They also introduced a separate bridge/test page and short memory-only session. The user rejected those as normal product flow. Original onboarding/native Credential Manager and the persistent authentication lifecycle returned. Approved thirty-day delegation still has expiry and logout semantics.

Emulator debugging authorization, navigation, PIN/provider state and KeePassDX vault/passkey confusion caused repeated intervention. KeePassDX was only an emulator alternative to a Google account; physical Google Password Manager compatibility remained mandatory. A credential listed by a provider did not prove signing or backend account restoration.

Later APK comparison found the working PR APK used a configured Tailscale relying-party host; a later fork forced `oc.app`. A different package/signer cannot assume official association. Explicit RP and matching Digital Asset Links fixed that mismatch. Tailscale association-only hosting enabled interim tests; production uses a public ICP association origin and stable signer, with original account-linking UI rather than a browser bridge.

Edge/Codex-browser control faults were separate. One passkey failure was isolated to the controlled browser; another Microsoft/Windows provider error cleared after restarting Edge. Neither justified deleting credentials or resetting keys. Older `LOCAL_TEST_APK_AUTH.md` statements about `oc.app` are superseded by the artifact comparison in OpenChat's `unofficial-local-client.md`.

### 6.3 Unwanted UI detours and restoration

Technical Private apps pages, mandatory JSON/processor imports, generic draft/card managers and handoff metadata pages were introduced during the fork migration. The user repeatedly rejected them: the requirement was PR behavior on main, not another product UI.

Apps/AI Apps discovery, source-linked proposals, app-owned inert presentation and the normal IOU review/add form were restored. Normal use no longer depends on importing files or viewing transport metadata. These were corrections, not desired extra features.

A small private-card count limit also blocked new proposals and reprocessing old messages. The eight-card count ceiling was removed while collection/per-card byte bounds remained. Viewing a card does not infer again; proposing again creates a fresh draft without silently destroying the old one; delivery retry keeps the original request identity. Restored cards never restore approval or send automatically.

## 7. Encryption, delivery and reconnect

### 7.1 Encryption must precede transmission

The user challenged sending complete extracted fields to an app backend for verification before approval. In the original PR, attestation prevented forged/misleading cards but involved its own disclosure boundary. Restricting card visibility to its initiator did not prevent data transmission.

An early fork handoff also sent plaintext to an app-owned page and encrypted only at IOU Save. That **did not satisfy the existing requirement**. The correction encrypts approved fields in OpenChat before IPC/HTTP/postMessage. Locally encrypted sender cards, recipient-encrypted delivery and encrypted ledger storage are different protections.

Local encryption does not protect against malicious client code already able to use the local key, nor make setup metadata chat-encrypted. Warnings cannot replace enforcement. Apps receive the selected/approved scope, not automatic entire-chat access. See [private import](../openchat-private-import.md) and [OpenChat encrypted delivery](https://github.com/ktimam/open-chat/blob/1fc6860b6021e09c53159d768525f0485522affc/docs/private-app-encrypted-delivery.md).

### 7.2 Durable inbox restored asynchronous Pending

Window handoff depended on IOU being open and did not preserve the original pending workflow. Android could also freeze the APK's loopback listener while the browser was foregrounded. A bounded service lifecycle fixed that historical callback freeze, but did not make window transport the desired durable architecture.

IOU's existing backend now persists recipient-scoped ciphertext before acknowledging delivery. No separate inbox canister is needed; IOU need not be open. The correct recipient can review later on the linked sheet and another device with its keys. Identical delivery and final Save retries are idempotent. Pending items and acknowledgement tombstones have documented **30-day retention**, not immediate deletion or indefinite retention.

Local acceptance covered closed receiver pages, identical replay, browser restart, a fresh profile and save/readback. An early test used a production-transport harness, not the inline OpenChat UI; later phone acceptance used the normal UI. These results are complementary but not interchangeable.

### 7.3 Reconnect versus chat setup; identity continuity

The user objected when reconnect repeated every chat's sheet selection. Account Connect/Reconnect now preserves mappings; a chat's Open setup changes only its destination. Valid matching grants are reused where appropriate, and cancellation releases the attempt rather than restarting it silently.

Localhost/Tailscale changes also made data appear missing: the phone used one origin/principal/sheet while Edge inspected another. The same Internet Identity anchor does not guarantee the same application principal at arbitrary origins. A phone's localhost is not the PC's server.

Approved plaintext sheet export/import provides an explicit migration route. Imported data is encrypted with the destination's key. This does not migrate credentials, membership, pending cards, chat bindings or original audit authorship/history. The readable export remains sensitive. See [sheet migration](../sheet-backup.md).

### 7.4 Pending latency, network errors and incomplete drafts

Memoizing only a successfully validated recovered delivery key reduced repeated work while retaining authoritative backend key/epoch/ciphertext checks. A visible checking state explains pending retrieval. No retained numeric before/after result supports an exact speedup claim.

The local/Tailscale “query response did not contain any node signatures” failure required environment/trust correction, not global weakening of mainnet verification. Direct sheet links also needed usable sign-in controls rather than just sign-in text. Currency conversion was repaired separately: a failed external rate request must leave manual conversion available, and its checkbox/label layout was corrected.

A missing date should block incomplete final Save, **not opening review**. Pending drafts now open the normal form with a blank date, survive Cancel/reload and save once after explicit correction. Tests did not silently fill today's date or acknowledge an unsaved draft.

### 7.5 Return to the familiar code connection

Loopback/framed setup could select the wrong password-manager context on the phone. The latest correction opens IOU at its own published origin and restores Copy code / Open app / Check connection / Cancel. Its existing canister hosts a bounded encrypted setup exchange; official OpenChat canisters remain unchanged.

The code is a temporary setup capability, not an Internet Identity login or recovery password. Separate derived keys protect context/response, with creator/claimant checks, expiry and exact retries. A nine-minute client lifetime leaves headroom inside the ten-minute server maximum for modest clock skew. Initial code creation and retry failures were fixed/tested rather than treated as a reason to keep generating codes.

Matching backend/frontend/catalog/client passed physical-phone connection and **12,900 EGP proposal → Sent → live Pending**. Pending count rose by one; the matching item appeared once. No paid recovery, key reset or final ledger save was used for that acceptance.

## 8. Mainnet deployment, signing and operational costs

### 8.1 Dedicated authority and guarded upgrades

Deployment preparation used a dedicated web-linked CLI identity, keeping passwords/private keys out of source and command output. Provider sign-in and deployment authority were separate steps. Old-cycle recovery encountered depleted canisters, wallet failures and encrypted identities needing local unlock. Unknown transaction outcomes were reconciled before retry/deletion.

The user selected minimum viable canister funding and later approved a bounded backup/upgrade top-up. **Funding is not an upgrade fee**: unused cycles remain in the canister. This history does not prove every old balance was recovered, or justify adding approximate chat balances into a current total. Transaction receipts are authoritative.

Production safeguards separate test and production VetKD keys, preserve existing IDs/stored keys on upgrades, and prevent a second frontend build from dropping production flags. IOU uses backend/assets; discovery and Android association are separate infrastructure. Official OpenChat canisters are not redeployed. See [deployment and costs](../06-deployment-and-costs.md).

### 8.2 Initial publication was not final acceptance

Public assets/discovery could pass while restore or inbox readback remained blocked. An emulator retained unsuitable DNS from local testing; restarting the same AVD with the active resolver restored connectivity without clearing data. A later mainnet inbox check was blocked by backend cycle balance. These remain time-specific historical failures, superseded by later acceptance rather than erased from receipts.

Signing-wrapper preflight/build failures also delayed delivery. The final APK uses the existing release key, production application identity and explicit RP/association; official-client OTA replacement is disabled. Independent verification checked 1,725 embedded non-map frontend assets plus WebGPU/license inventory, not merely that an APK existed.

## 9. Account vault and recovery experiments

### 9.1 Avoid repeated derivation

Earlier recovery depended on paid VetKD-derived keys too often for the intended experience. The accepted architecture bootstraps one deterministic account root, generates independent sheet keys locally, keeps protected device access and saves encrypted online backups/envelopes. Normal connection/reconnection reuses the existing consumer delivery key, not one derivation per sheet/chat.

Inactivity logout was disabled and access retained over reload/browser restart, subject to actual delegation expiry. Explicit logout removes protected local access. Remembered sign-in is not permanent authentication, nor automatic access to an encryption key from any device.

Schema 19 → 20 → 20 tests preserved original keys, ciphertext, vaults and pending request state. Paid-capable RPC counts were separated from ordinary encrypted reads/writes. Initial account bootstrap is distinct from creating more sheets, reloading, reconnecting and new-device recovery.

### 9.2 PRF encryption passkeys failed on the tested Microsoft provider

An early follow-up required a WebAuthn PRF encryption passkey. Ordinary authentication and PRF encryption output are different. The affected Microsoft-synced credential authenticated selection but returned no PRF result in Edge and InPrivate: `results-absent`.

A compatibility attempt changed PRF request shape and added bounded fallback. Virtual-authenticator tests passed; actual Microsoft attempts still failed. This did not establish a working fix or identify whether Edge, Windows, the provider or credential capabilities were responsible. Retrying the same selection could not invent encryption output.

Encryption-passkey controls were removed from the normal UI. Historical backups/compatibility data remained intact rather than deleting keys. Google Password Manager compatibility remains required for OpenChat native authentication; other supported providers are not excluded, and switching providers was not imposed as the solution to IOU recovery.

### 9.3 Ordinary password-manager recovery

Internet Identity authenticates. Separately, IOU prepares a random high-entropy recovery secret and encrypted online root backup. The secret is saved as an ordinary password-manager credential. Retrieval/autofill and decryption of the original root are verified independently from a storage API reporting success.

Preparation is automatic for an unlocked account lacking a verified entry. It reuses the candidate on retries, preserves verified backups and does not trigger paid fallback when saving fails. Saving, retrieval and cloud synchronization are different facts. API success is not proof of a second-device Microsoft/Google copy.

This is not II-only recovery or derivation from an ordinary passkey signature. Another device needs the saved recovery credential, a device retaining the original key, or explicitly authorized emergency recovery. Credentials for localhost do not automatically apply to the production origin.

### 9.4 Automatic migration only with the genuine key

Older sheets automatically migrate their key envelope when the original key is available; no Settings detour is needed. If it is missing, the sheet explains that and asks separately before paid recovery.

Historical placeholder wrapper/name keys must not override the key that encrypted entries. Migration validates candidates across bounded entry/history evidence and never invents a replacement for existing ciphertext. Failed backup persistence offers a no-VetKD retry using the recovered session key rather than another derivation.

### 9.5 Cost evidence and cancelled work

The documented estimate was approximately **26.15 billion cycles / US$0.036 per production VetKD derivation**, not every reload or the entire recovery session's cost. Ordinary storage/execution still consumes cycles when the VetKD count is zero.

Local real-crypto tests observed one bootstrap per synthetic account and no additional paid-capable calls in normal remembered-device, manager recovery, invitation, inbox and reconnect paths. Deliberate emergency/legacy tests used isolated test-key backends, not real charges. Request IDs, receipt reconciliation, rate bounds and cooldowns avoid blind redispatch on uncertain outcomes.

The real-user mainnet measurement remained incomplete: the saved recovery entry was not available/autofilled in the capture context. Therefore no measured zero-VetKD mainnet outcome or exact total dollar cost is claimed. A future capture must reconcile methods/receipts/balances and disclose unrelated background costs.

The user explicitly **cancelled two-option UI and user-paid ICP emergency recovery**. Neither is implemented or approved follow-up scope. Current emergency recovery remains explicit and canister-funded. See [vault design](../account-vault.md), [protocol validation](../account-vault-validation.md) and [browser evidence](../account-vault-browser-validation.md).

## 10. Final checks and accepted deferrals

The latest scoped repairs addressed stale reviewed upstream inventories, formatter evidence, production-profile coverage, historical/current contract assertions and a test-only type problem. They did not change model weights/prompts/runtime features/dependency versions to manufacture green results. Negative tests and historical proofs were retained. No core OpenChat audit was run for this documentation task or included as part of those scoped repairs.

| Layer | Recorded result | Qualification |
| --- | --- | --- |
| OpenChat frontend | 7,290 passed; one existing skip | Local source-bound suite, not thousands of phone scenarios |
| Lint/types | Passed with existing warnings | Not warning-free |
| Scoped offline contracts | 849 passed, no skips | Scope/format/pins/contracts/license evidence, not a core audit |
| Hosted frontend | Four jobs passed | [Release-commit workflow](https://github.com/ktimam/open-chat/actions/runs/39164532047) |
| Hosted scoped functional jobs | Six passed, including actual small-model inference and native/platform checks | [Workflow](https://github.com/ktimam/open-chat/actions/runs/39164532063); small fixture is not full Qwen/Gemma phone accuracy |
| Dependency advisory job | Failed | Explicit finding-specific deferral; not suppressed or clean |
| IOU account-vault checkpoint | 3,925 frontend / 134 Rust tests across configurations; 27 deployment guards | October 13 architecture checkpoint, not final suite totals |
| IOU manager/review checkpoint | Canonical 4,149 tests / 188 files; both TypeScript configurations passed | Production-preserving snapshot separately retained three inherited model-profile assertion failures |
| IOU browser/emulator cases | Recovery, restart/logout, migration, inbox and review passed in recorded environments | Synthetic auth/autofill and test-key backend, not real provider-sync proof |
| Live phone | Code connect and reference receipt delivery to live Pending passed | `54f3307`, pending not saved; no paid recovery/reset |
| Published APK | Signing/source/assets/RP/package/ABI verified | `8946db226`; no new inference run on this exact build |

Eleven newly returned exact findings were deferred: `sharp` 0.35.4 / GHSA-wq5f-xc86-pv6w; `sprintf-js` 1.1.3 / GHSA-hp3w-g68c-fv3c; five `quinn-proto` 0.11.16 findings RUSTSEC-2026-0338 through -0342; four `rustls` 0.23.45 findings RUSTSEC-2026-0346 through -0349. Earlier deferrals remain distinct. Deferral is a risk decision, not remediation, a scanner exemption or authority for unrelated upgrades.

The public [release-info.json](https://github.com/ktimam/open-chat/releases/download/openchat-private-v0.1.0/release-info.json) and [SHA256SUMS.txt](https://github.com/ktimam/open-chat/releases/download/openchat-private-v0.1.0/SHA256SUMS.txt) bind the artifact and explicitly separate prior phone acceptance from the fresh build.

## 11. Future plan: bounded follow-up, not redesign

The first release is published. This list is a follow-up plan, not authorization to deploy, spend cycles, mutate user data or reopen cancelled work.

| Priority | Follow-up | Completion evidence |
| --- | --- | --- |
| 1 | Exact published APK on supported phone | Hash/version; existing restore/restart; code reconnect preserving routes; both models/repeated inference; one encrypted pending delivery |
| 1 | Real mainnet recovery-cost capture | Existing account/entry; no new bootstrap/reset; method/request counts and before/after cycles reconciled with background activity |
| 1 | Real password-manager cross-device continuity | Same production origin, actual save/sync/retrieval and original-data decryption; no synthetic autofill presented as provider proof |
| 2 | Broader semantic/lifecycle corpus | Arabic/Latin receipts, currencies/dates/ranges/user Types/unreadable fields; field assertions and repeated/model-switch runs |
| 2 | Note and optional-audio limits | Reproducible improvements without regressing amount/date/Type or making audio mandatory |
| 2 | Exact deferred advisories | Narrow affected-feature remediation and compatibility/packaging/license checks; preserve old release's honest record |
| 2 | Inbox lifecycle bounds | Offline receipt, multi-device review, replay/expiry, logout/reconnect, wrong account/sheet rejection and once-only Save |
| 3 | Reproducible upstream/releases | One fork main, reviewed merges, source/served/APK hashes, scoped discovery checks, documented startup and backup-first recovery |
| 3 | Storage hygiene | Remove only owned unused temp/build data; preserve active model caches, signer material, backups and acceptance evidence |

Out of scope: technical end-user panels, another card redesign, mandatory loopback setup, custom official OpenChat canisters, silent OCR in Model only, reintroducing mixed weights, core OpenChat audits, automatic paid recovery, key resets and cancelled ICP-payment/two-option work.

## 12. Lessons and evidence index

The duration came from overlapping real GPU faults, extraction errors, mismatched contracts, changing distribution architecture, origin-specific auth, lost UI parity, environment repair and encryption/cost redesign. Some detours were avoidable. Exposing diagnostics as normal UI and treating partial tests as full acceptance caused repeated work and user intervention.

Future changes should preserve explicit invariants: official backend unchanged; app-owned semantics; original card/connection presentation; encryption before sending; destination/key continuity; no automatic paid recovery; separate idempotent delivery and Save within documented request/retention rules. Name the invariant and its test before implementation.

“Done” must identify commit, served/deployed build, installed artifact, device/provider, fixture and expected receiver state. Use failed, blocked, passed-in-scope and deferred accurately. Deterministic tests, emulator UI journeys and live phone observations add different evidence; none substitutes for all the others.

| Evidence | Role |
| --- | --- |
| [Sanitized chat](../../chats/2026-10-19-openchat-iou/README.md) | Requirements, symptoms, approvals/cancellations; historical visible claims are not automatically current facts |
| [Summary tables](openchat-iou-summary-2026-10-19.md) | Chronological workstream/outcome matrix |
| [August review](../SECURITY-REVIEW-2026-08-01.md), [linking](../openchat-linking.md) | Original PR card/routing architecture |
| [Boundary review](../openchat-app-boundary-review.md), [prompt investigation](../model-prompt-sensitivity-investigation.md) | App ownership and extraction/runtime comparisons |
| [Private import](../openchat-private-import.md), [sheet backup](../sheet-backup.md) | Current code flow, inbox and migration; historical transport corrections |
| [Vault](../account-vault.md), [validation](../account-vault-validation.md), [browser validation](../account-vault-browser-validation.md) | Key protocol, tests, provider limits and incomplete cost capture |
| [Deployment](../06-deployment-and-costs.md), [release plan](../unofficial-openchat-client-release-plan.md), [records](../../deployments/) | Guarded deployments and time-specific blockers |
| [OpenChat readiness](https://github.com/ktimam/open-chat/blob/1fc6860b6021e09c53159d768525f0485522affc/docs/releases/model-app-readiness.md) | Source-bound GPU/prompt/device evidence |
| [Fork history](https://github.com/ktimam/open-chat/blob/1fc6860b6021e09c53159d768525f0485522affc/docs/unofficial-local-client.md) | RP/auth comparison, UI restoration and native lifecycle |
| [Scoped CI](https://github.com/ktimam/open-chat/blob/1fc6860b6021e09c53159d768525f0485522affc/docs/unofficial-ci-migration.md), [release](https://github.com/ktimam/open-chat/releases/tag/openchat-private-v0.1.0) | Final checks and immutable artifact metadata |

Private screenshots, bank/receipt identity details, codes, credentials, browser storage and signing secrets are intentionally excluded. The retained session is larger than the public transcript because tools/internal execution and private material are not exported. Some temporary experiments were removed during approved cleanup, so not all can be rerun from those files. Where cause, cost or success is unproven, this report leaves that uncertainty explicit.
