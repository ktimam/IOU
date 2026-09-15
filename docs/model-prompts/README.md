# Model-specific IOU image prompts

Created 10 September 2026 at the user's request for separate model prompts. These are
**not release-qualified prompts**. The original candidates
and the latest raw-evidence candidates are retained separately; experimental revisions and
their results are recorded below. None has passed the complete activation gate.

## Current selection and latest rejected experiment

The active smaller-Qwen profile remains v20 (`qwen3-vl-2b-total-row-image.txt`), and Gemma
remains v15 (`gemma-4-e2b-split-image.txt`). The local v21 heading experiment did not change
either active prompt, model weights, server registration or APK. It was rejected after
eight of ten cards matched the frozen expectations: the receipt heading still included its
printed subtitle, and a synthetic agreement's kind regressed. See the
[v21 qualification record](qwen-upper-heading-v21-qualification.md) for the retained result.
The successful v20 phone sequence below remains valid; it is not a v21 result.

A fresh unchanged-v20 desktop control on the same current worker completed all ten requests
without runtime errors and matched nine cards exactly. All money, currency, date and kind
fields were correct; the only mismatch remains the receipt's printed subtitle being included
in the note. The workshop kind was correct with v20. The control and candidate results are
retained separately in the qualification record; the active configuration remains unchanged.

The user explicitly accepted this one receipt-note limitation for release on September 15:
keep the phone-tested prompt and document the printed subtitle being included in that note.
It is no longer a release blocker for this selected profile. The retained 9/10 result and
first-line expectation remain unchanged; this is not a 10/10 accuracy claim or an exception
for wrong amounts, currencies, dates, kinds, private Types/directions or other image outputs.

## September 15: fresh smaller-Qwen phone sequence — three passes

After the cleanup APK's in-place update, the phone's diagnostic catalog was replaced through
the normal UI with the packaged two-model catalog. Only the mixed model's retained cache was
removed. Smaller Qwen's old cache required an incremental update of two packaged graphs and
the missing DeepStack tensor; unchanged large weights and Gemma's download were retained.

The user then proposed the Arabic 12,900 image in the physical APK with smaller
`qwen3-vl-2b-instruct-q4` selected and Model only enabled. Read-only inspection of the actual
app-authored frame confirmed all six expected fields: `12900`, `EGP`, `Settlement`, no saved
type, `2026-08-14`, and note `تمت العملية بنجاح`. The direction displayed `Owed to you`;
this image does not supply the separate saved-type direction oracle. The host enabled
confirmation, but the card was left unsaved and delivery was not exercised.

The current packaged worker is SHA-256
`04ebc7bcb6a5385745a095ace2ba87e3e474775775dbae31f74d165433b39bd8`.
One normalized image input, successful WebGPU embedding/vision/decoder execution, completed
prompt-session and decoder retirement, and zero remaining page workers were observed. No
weight download was observed during inference. The runtime's “cached CPU facade” label refers
to token-ID bookkeeping and a temporary shape-carrier tensor; subsequent embeddings are
calculated inside the WebGPU decoder, with CPU execution-provider fallback disabled.

The private local receipt is `admin/phone-smaller-qwen-arabic-result-20260915.json`; its screenshot
is `output/playwright/phone-smaller-qwen-arabic-card-20260915.png`, SHA-256
`f84d166cb38e6b97e3e623e6c8bc24707438d152c5c8437e8a39f00030d62928`.
A separate WebRTC navigation error before inference remains recorded; this is not a claim
that the whole app is error-free. Historical mixed-model results remain distinct.

The second proposal, without restarting or changing Qwen, passed all seven range-image checks:
`1912.15 USD`, `IOU`, saved Type `Reservation`, direction `You owe`, `2026-07-19`, and
`Reservation | From Sun, Jul 19 to Thu, Aug 6`. The third proposal repeated the Arabic image
and matched all six original fields. Both also rendered app-authored cards with confirmation
enabled. All three cards remain unsaved. The sequence contains three image inputs and three
completed decoder retirements, zero remaining page workers after each completion, no model
warning/error logs, and no model-weight downloads during inference. The previous repeated-use
crash did not reproduce in this three-run sequence; this is not proof it can never recur.

Per-case receipts are `admin/phone-smaller-qwen-range-result-20260915.json` and
`admin/phone-smaller-qwen-arabic-repeat-result-20260915.json`. The actual runtime evidence is
`admin/phone-smaller-qwen-runtime-evidence-20260915.json`, SHA-256
`f1287a2e187e38eb7a97190dde59a256855b2449a7449e1cf2ce0932cda1c37b` (signed URL queries omitted).
This qualifies the requested three-run phone check only. The known desktop receipt-note
mismatch, broader accuracy, optional-audio and final release checks remain separate; no
historical failing report was converted into a pass.

## September 14: mixed-precision diagnostic retired

The user requested removal of the mixed weights and continued release preparation.
Only `qwen3-vl-2b-instruct-q4` and `gemma-4-e2b-it-q4` remain in the active IOU
prompt configuration. The smaller Qwen's exact v20 prompt and all-WebGPU settings
are unchanged. The local app registration and matching verification binding were
updated together. Existing accounts may need the normal reconnect flow.

The isolated mixed delivery package's generated weights, graphs, old worker and
import catalog were deleted (628,814,036 bytes); its historical manifests, receipts
and reproducibility scripts remain. All nine shared files referenced by that package
were hash-verified unchanged. Its obsolete HTTPS download route was removed without
changing OpenChat, IOU or replica routes. Disconnected phone caches were not modified.

Historical mixed-model captures retain their original IDs. The current host/app replay
now uses the actual smaller-Qwen captures (ten, including two repeats) plus eight Gemma
captures: all 18 integration paths and five negative controls pass, while full card
accuracy remains 17/18 because of the known receipt-note mismatch. Its overall result
and exit code remain failing, not silently converted into an accuracy pass. The earlier
16/16 mixed/Gemma replay is historical and is not current smaller-model qualification.

## September 14: keep the smaller Qwen with the tested complete-row prompt

At the user's request, `qwen3-vl-2b-instruct-q4` now explicitly selects the unchanged
Qwen v20 complete-row profile in IOU's `modelImageProfiles.json`. Its prompt SHA-256 is
`2d73ebab0701a7adb4256072ef4625c30964b46766172bae05602bc72e045cc8`.
The 1,836,691,582-byte (about 1.7 GiB) model, pinned upstream revision, all-WebGPU
settings and existing downloads are unchanged. No custom model hosting is introduced.
Gemma and the diagnostic mixed-Qwen mapping are retained for compatibility; this does
not select or download the mixed model. Unknown model IDs still use the generic fallback.

The same small model and current worker were tested first with the generic prompt,
then with this exact profile on eight images plus two repeats. Complete card fields
improved from **4/8 to 7/8** unique images; both repeats passed. Amount, currency, date
and kind were correct on all eight. The remaining receipt note combines the printed
heading and subtitle (`RIVER MARKET SERVICE RECEIPT` rather than `RIVER MARKET`).
The source expectation is not relaxed to count this as a pass. Generic-baseline dates
were rescored through the actual canonical normalization path: initial empty dates
in that diagnostic were a harness omission, not model output failures.

`test/fixtures/openchat/model-acceptance/qwen-q4-v20-app-replay.json` retains the actual
smaller-model outputs, source expectations and known miss independently of historical
mixed-precision captures. Its source report SHA-256 is
`eb1d6ec15f38f28536e21d83c1c4e049f73383bdaa63c9de1ee131d9ef396432`.
All ten hardware inferences completed and their GPU-buffer retirement checks passed,
but 30 test-server stream-close warnings remain in the raw report: the runner is not
reported fully clean or release-qualified. These were desktop tests, not fresh phone
inference. Passing replay tests characterize the known miss; they do not prove 8/8 accuracy.

The local registration was updated with the matching backend verification binding,
without upgrading canisters or changing OpenChat source. An existing account may need
the ordinary IOU reconnect flow for the new app revision. No APK rebuild or model
re-download is needed for this app-owned prompt mapping.

## September 14: local activation and initial-card attestation regression

The configured profiles and matching frontend were activated in the local test environment
on September 13; that is not production publication or phone qualification. The following
September 13 source-integration checkpoint describes the checks before local activation.

The first Gemma phone proposal after reconnect was rejected because IOU's Rust initial-card
deserializer did not recognize `image_heading`, which the current IOU image processor emits
for private saved-Type matching. Reconnecting cannot resolve that payload-contract mismatch.
OpenChat preserved the app payload and enforced attestation correctly; no host or prompt
change is needed for this failure.

Earlier offline replays checked extracted fields and the editable/final form but did not call
the backend attester. The form intentionally drops this evidence field, hiding the mismatch.
The replay script now optionally exports exact initial cards and final confirmations as
`test/fixtures/openchat/model-acceptance/configured-model-attestation-cards.json`. Rust tests
consume all 16 cards through the real attestation predicate; the profile tests bind their
payloads back to current IOU normalization and confirmation projection.

All 16 cards failed backend attestation before the fix and pass after it. The fix accepts only
bounded, nonempty, trimmed image-heading evidence on initial cards; it remains forbidden in
final confirmation. Unknown/duplicate fields and altered public rows still fail. All 103 Rust
unit tests pass, along with 88 targeted frontend tests and both TypeScript configurations.
These are captured-output/backend checks, not a fresh phone success.

With explicit approval, the existing local IOU backend was upgraded in place on September 14
(local time), from schema 18 to schema 18. A pre-upgrade canister snapshot and exact previous
Wasm are retained. Its configuration response is byte-identical before/after, controllers are
unchanged, and the published response schema and app binding still pass the strict readiness
check. The installed module hash is
`02d9fb03fe21808a6c47cf29ab8e76042678adee5b65813a28a585dcad9296ae`.
No state reset, OpenChat canister upgrade, registration change or APK update was performed.
The subsequent fresh Gemma proposal on the physical APK now opens the app-authored card without
the verification error. Read-only host/frame inspection confirmed `12900`, `EGP`, `2026-08-14`,
Settlement, and the source Arabic heading as the note. The card was left unsaved; delivery was
not exercised. A second fresh Gemma proposal on the reservation/range image also opens correctly:
`1912.15 USD`, date `2026-07-19`, private saved Type `Reservation`, direction `You owe`, and note
`Reservation | From Sun, Jul 19 to Thu, Aug 6`. Both cards remain unsaved, with no verification
error. These verify two phone cases, not Qwen, delivery, or the full phone acceptance matrix.

## September 13 source-integration checkpoint (before local activation)

September 13: IOU's source manifest now selects the tested Gemma v15 and mixed-precision
Qwen v20 profiles from `src/features/openchat/modelImageProfiles.json`. The processor page
uses the same configuration's explicit complete-row option. The prompt strings are byte-for-byte
identical to the tested files below. The older all-q4 Qwen ID is not assigned the mixed-precision
profile. Unknown IDs retain the existing canonical fallback.

This is source integration for subsequent local testing, not publication or phone qualification.
Change model IDs/templates in that IOU JSON file, deploy the IOU frontend, and re-register its
manifest together. Removing every template restores the legacy prompt-only manifest; use
`processorOptions.rawImageMoneyFormat: "strict"` to restore the strict money profile too.
The host's canonical numeric schema is unchanged. No prompt or IOU fields are added to OpenChat.

The matching configured host and processor must be deployed together: older hosts ignore the
version-2 per-model extension. Do not publish this configuration until the matching host, local
processor, phone inference and live attestation/private type/direction/delivery gates pass.

Current checks: **1,661 IOU feature tests**, both TypeScript configurations, and an isolated
production frontend build pass. `scripts/live/verify-configured-model-prompts.ts` replays the
16 retained Gemma/Qwen captures through the actual current registered response schema, host
parser/runner, configured IOU normalizer and card functions: **16/16 pass**, with five negative
controls. It uses the original image bytes but returns captured answers, not fresh inference.
No test prompt is injected into the registered schema. Each case has exactly one inference
callback and one normalization; network use is forbidden.

The current offline report is project-temp
`output/iou-registered-model-profile-final-replay-20260913.json`, SHA-256
`3f5f037b4c8a2c471c0277f3a50aa2917bbfbff0e73f83066c5e4889be0e0868`.
An earlier harness attempt compared a decoded JSON object to the host's null-prototype object;
its failed report is retained. The final check compares exact serialized payload bytes and
every expected canonical field, without changing source/card expectations.

The configuration supports up to eight exact model IDs, 4 KiB per prompt and 16 KiB for the
extension. The complete registered response schema must also remain within the host's 16 KiB
limit; the feature tests check the current schema. Empty `templates` removes the extension.
Each entry declares `output: "app"` for IOU-owned raw normalization or `"canonical"` for
direct canonical fields, plus the exact prompt and whether to include rule guidance.
Run the IOU feature tests after editing configuration, and qualify new model/prompt combinations
on representative images before publishing. Changing a prompt mapping does not download models.

September 12 latest checkpoint: [Gemma v15](gemma-4-e2b-split-image.txt) gets the money,
currency, heading and kind correct on all eight exposed images. Its original strict prompt
contract is still **6/8** because two complete date spans use alternate formatting. An explicit
IOU date-format adapter replays all eight captures into the correct app fields. A fresh
eight-call repeat reproduces every raw answer, and the new generic host-to-app handoff now
passes **8/8 offline card-field replays**, without changing the strict score. No activation,
physical-phone or live attestation/delivery qualification is claimed. Qwen's
[complete-row prompt with the v20 IOU profile](qwen3-vl-2b-total-row-image.txt) now passes
**8/8 exact source checks and 8/8 offline host/app card-field checks** in a fresh desktop
WebGPU run, using the mixed-precision candidate. See [the explicit app format](total-row-format.md).
Qwen v10 remains the best original q4 baseline at **6/8**; the earlier mixed-precision v17
checkpoint reached **7/8** but omitted the receipt currency. The earlier currency-first/boolean revision, v15,
scores **4/8** and is rejected. The question-style v14 scored **3/8**; the earlier
six-field, Gemma-text and kind-first controls were also rejected.
These exposed-source scores are not broad accuracy or release qualification.

The earlier weight-only controls reproduce the workshop error in the original implementation
when both text-weight groups use converted q4 values. Either group alone passes that case.
Original embeddings/output head with q4 decoder layers are therefore a candidate precision
intervention. It passes this case using verified converted vision features in the original
decoder. A chunked FP16 embeddings/head prototype now also passes in the actual converted
native runtime, including offline app/card replay. Its new graph operations now pass three
small hardware-WebGPU checks after an exact token-range predicate adjustment. A full
eight-image run at that stage completes on the catalog-enabled WebGPU worker, but still scores
**6/8** for both source facts and offline app card fields: the workshop is corrected, the
English transfer heading regresses, and the receipt failure remains. It is not activated.
Phone qualification remains open. No production model assets or prompts have changed.

The latest exact-input reference check separates Qwen's remaining failures: the paper
receipt is wrong identically in original FP32 and WebGPU; the workshop's payment kind is
correct in original FP32 but identically wrong in converted q4 on both CPU and WebGPU.
Restoring only the original vision position table does not fix that case. A subsequent
original-vision/converted-decoder isolation run still gets its payment kind wrong. See below. This
does not change the saved WebGPU score or qualify either candidate for activation.

| Model | Latest candidate | Verified source accuracy |
|---|---|---|
| Qwen3-VL 2B | [Complete-row prompt / v20 profile](qwen3-vl-2b-total-row-image.txt) | 8/8 source and offline host/app card fields on the final desktop WebGPU worker with FP16 embeddings/head; not the older all-q4 weights or phone qualification |
| Gemma 4 E2B | [Split-image v15](gemma-4-e2b-split-image.txt) | Two eight-image WebGPU runs; 8/8 app-compatible fields and offline host/app card replay; original strict formatting remains 6/8 |

### September 12: v20 configured complete-row profile passes the eight-image screen

The unchanged original-key v18 prompt copies complete total rows. IOU's explicit
`rawImageMoneyFormat: "total-row"` profile parses them without relaxing its strict
default parser, changing OpenChat, or supplying missing currency. The fresh hardware run
passes all eight source/card cases. Complete JSON fences are still returned (JSON-only
0/8), and are accepted by the existing strict host envelope parser.

The v19 experiment renamed only the key to `total_row`; it regressed Arabic payment kind
and receipt heading and is rejected at 6/8. The v18 diagnostic's original 3/8 money-only
contract result is retained, not retroactively relabeled as passing. Its captured answers
fit the newly declared profile offline; the v20 result is a separate fresh eight-call run.

Actual captures are saved in the test-fixture directory with nine regression tests.
The complete IOU feature suite passes **1,622 tests**, and both TypeScript checks pass.
At that checkpoint the model table was diagnostic/in-memory. It was subsequently materialized
and tested through native browser caches (see `total-row-format.md`). Prompts/profile were
not deployed, and there was no server/APK/phone claim.

- Policy: `4c0cae4300f71df01309bc596cb3a44024a6da3e2937c3a1fe9ea8357f829e28`.
- Runtime: project-temp `output/playwright/catalog-qwen-row-8HVeSi/result.json`,
  `c5404f050bbd50953dd69b67ffaf201964eb50f27dc9e064be69f7c3c7555b3d`.
- Assessment: `ab0902f12750b129154ff706f1d7c2236de43e3f4849d75133f9a90da53c3579`.

### Previous September 12 checkpoint: v17 reaches seven of eight, not qualified

The v17 candidate changes only the heading and total-row declarations from v16: constrain
the title to its top line and explicitly inspect currency printed beside a row label.
It fixes the English transfer's appended amount without regressing the other images.
All eight headings, dates and kinds pass; seven monetary strings pass. The paper receipt
still returns `350.00` without EGP. Its unchanged source and offline card-field checks fail.
No default currency or text repair is supplied to make the result pass.

The exact eight-image run uses the final catalog-bootstrap worker
`131557a3edb11a51f227c7cca76e4d90739d14a0152ba0e517cbefffd68916be` and the same diagnostic
FP16 embeddings/head plus q4 vision/decoder, 96-token cap and one pass per image. Runtime,
GPU retirement, clean browser/server/child exit and source identities pass. Complete JSON
fences remain 8/8; JSON-only compliance is still 0/8. The existing source/card oracles are
unchanged; the separately versioned scorer only updates its exact permitted worker hash.

- Prompt: project-temp `admin/new-model-prompts-20260910/qwen-image-v17.prompt.txt`,
  SHA-256 `2afafd7ddcb4e75f5f89214d43baac799561c5d34db211618bdff79bbe13cd89`.
- Runtime: `output/playwright/catalog-qwen-f16-candidate-N1RPhK/result.json`,
  SHA-256 `432f2ceb947b58bdf17e42722c97c43d2769adddf55f65c41dc43f35f994716d`.
- Assessment: `assessment.json` in that directory,
  SHA-256 `b484c84a29bfe4357a584b45009b98e832cf8600defa7c045e3bc34ef2a0af49`.

This checkpoint is **7/8 source and offline card fields**, not activation or phone acceptance.
The prompt, raw-output parser, source expectations and production registration were not changed
to hide the remaining omission. No new weight files or downloads were created.

### September 12: full mixed-precision Qwen WebGPU screen, not qualified

Two further full-image prompt checks on the same mixed-precision runtime remain unqualified.
V16 replaces exactly one v10 heading declaration with the direct top-line question; a
byte-reversal test also caught and removed an unintended trailing blank line before inference.
The paper heading becomes correct, but its currency remains missing and the English heading
still includes the amount. Full question-style v14 restores all headings but loses currencies,
copies total labels and misclassifies the workshop again. No scored output is repaired.

| Prompt on the same FP16-head configuration | Headings | Monetary strings | Dates | Kind | Source + offline card fields |
| --- | --- | --- | --- | --- | --- |
| Unchanged v10 | 6/8 | 7/8 | 8/8 | 8/8 | 6/8 |
| V16, heading declaration only | 7/8 | 7/8 | 8/8 | 8/8 | 6/8 |
| Existing full question-style v14 | 8/8 | 4/8 | 8/8 | 7/8 | 3/8 |

Both new eight-case runs pass runtime and GPU retirement, with clean browser/server/child
exit and no transport errors. All outputs remain complete fenced JSON; requested key order
passes 8/8. The data-configured runner accepts only a hash-bound four-field prompt experiment,
retaining the fixed images, current worker, precision, 96-token cap and separate unchanged
source/card scorer. Six new preflight/negative tests cover exact prompt changes, digest
rejection, preserved GPU controls and the actual English/receipt failures. This comparison
shows that a locally effective wording change does not qualify the complete prompt or make
mixed precision a general fix. No candidate was activated or copied into the production prompt.

- V16 result: `F:/Temp/OpenChat-IOU/output/playwright/catalog-qwen-f16-candidate-zP8G3S/result.json`,
  SHA-256 `5c7de7dbec4da309c239d49eebcf849424eaf294ffaf98b06954afed6030bbde`.
  Assessment: `assessment.json` in that directory,
  SHA-256 `aab2819986d6c6e8b848fc71c2479ab25baf0d82d506e280480e0d0377997c3b`.
- V14/FP16 result: `F:/Temp/OpenChat-IOU/output/playwright/catalog-qwen-f16-candidate-rmJc22/result.json`,
  SHA-256 `68db683ef4385dd9be2075b5a78d91db322d64ca74f98b01d2fd4c6bb6ef8377`.
  Assessment: `assessment.json` in that directory,
  SHA-256 `70b728069d576101883eca7d2520fb7f4fabf2256cc55d047641e47caa1a402d`.

The current catalog-enabled production worker accepts a configuration-supplied model ID,
chunked FP16 embeddings/output head and the unchanged q4 vision/196 decoder matrices.
Eight original images run once each with the unchanged v10 prompt and 96-token cap, each
in a fresh worker. No OCR, crop, retry, second image pass, model fallback or raw-answer repair
is used. All runtime and GPU-retirement checks pass, with no browser or transport errors.

Exact source and actual offline host -> IOU processor -> card-field gates both score **6/8**.
Dates and payment kinds pass 8/8, monetary strings 7/8, and headings 6/8. The workshop now has
the correct `iou` kind. However, the English transfer includes `13,500 EGP` in its heading;
the paper receipt still merges its subtitle and loses EGP. The unchanged card expectations
catch both failures. Every replay performs one retained-result callback and one app-owned
normalization using the new model ID. JSON-only remains 0/8 because all complete outputs
are fenced; requested key order passes 8/8.

The preceding one-image full-model run passed the workshop case. Its initial test-only
transport failed on two eager cache-existence probes that abandoned HTTP bodies; a separately
versioned lazy transport fixes that harness issue without changing the model or worker.
The failed receipt remains retained; the successful eight-image run uses the lazy transport.

- Full runtime result: `F:/Temp/OpenChat-IOU/output/playwright/catalog-qwen-f16-eight-3MQidZ/result.json`,
  SHA-256 `4d6e4375e7f53744004fad9a9fb9e0d3ea433b8d25ebcd9704d922d64628dfed`.
- Source/card assessment: `F:/Temp/OpenChat-IOU/output/playwright/catalog-qwen-f16-eight-3MQidZ/assessment.json`,
  SHA-256 `8112098cdd5b565724ff42ddd1122961eff38a512fcc9da52996b8f58f75904b`.
- Worker SHA-256: `e2d09f941f5643706622e51f6f7b40db34b336997784bca2f8e0cf1413433d08`.

Six runner/assessment tests cover image identity, reversible test-only changes, exact output
binding and GPU-retirement failures. This is not untouched holdout accuracy, real CacheStorage,
same-worker reuse, phone memory/repeats, live attestation/private Type/direction or delivery.
The FP16 table exists only in diagnostic memory; no new model weights were downloaded or
copied to disk. No app prompt/registration/model configuration was activated and no server
or APK updated. Continue app-owned prompt work; this precision change alone is insufficient.

### September 12: new FP16 operations qualified on small hardware-WebGPU graphs

The first GPU probe rejects session creation because the pinned runtime has no WebGPU
kernels for INT64 `Less`/`GreaterOrEqual` range predicates. CPU fallback remains disabled.
The diagnostic graph now casts only those predicates to FP32: every valid Qwen token ID
and chunk boundary is exactly representable, while lookup offsets remain INT64 and the
learned table/head remain FP16. Boundaries outside the exact integer range are rejected.

Three hardware-WebGPU cases pass with bit-exact outputs against native FP16 oracles:
chunk-boundary/repeated-token lookup, empty cached-token lookup, and the output head at
the real 2048-element hidden width. Synthetic tables have only 33 rows and nine chunks
(135,168 bytes), so these are not full-vocabulary, model-accuracy or phone-memory tests.
Nonempty lookup/head issue 65/20 GPU dispatches; the empty case correctly issues none.
All three session options confirm disabled CPU fallback. All observed GPU buffers are
explicitly destroyed, each device loss is an acknowledged intentional retirement, and
the owned browser, local server and child close cleanly.

An intermediate run had correct outputs but failed its strict console check because verbose
shader-source dumps use the error channel. Its failed receipt remains unchanged. A fresh
run disables optional shader dumps, preserving native E/F and unclassified-error detection,
GPU error checks, identical graphs and expected outputs. Six added focused tests cover the
native oracles, exact-range constraint, log classification and reversible adapters.

- Passing GPU result: `F:/Temp/OpenChat-IOU/output/playwright/qwen-head-f16-operators-v3-KaYTSf/result.json`,
  SHA-256 `9c9503b4bdae16b52dd0f62c15ea36a445673ffe8a7dfd192369d50f33d4880d`.
- Assessment (also binds both earlier failures):
  `F:/Temp/OpenChat-IOU/admin/new-model-prompts-20260910/qwen-head-f16-webgpu-assessment.result.json`,
  SHA-256 `73bb9fc87b0f0bc030e65b26c72d03407b953e92926498189827198cf46a6b36`.

Full graph construction with the same range predicates passes exact byte reversal and
decoded-graph agreement. The resulting decoder SHA-256 is
`2e5a0e72fe387a5b561629bd53346c57e0ebb48ff3ec79ad8c02e7e03d51e767`; embedding graph is
`cc0b287963d7581a9fefd8b609dccca4a7f6d991107dba47390c2b02a79d0d60`. All 196 q4 decoder
matrices remain unchanged. These earlier operator-only checks did not run full image inference;
the subsequent eight-image screen is recorded above.
No real model weights were downloaded/copied or production runtime/server/APK updated.

### September 12: chunked FP16 embeddings/head in the converted native runtime

The current converted vision and decoder now run the captured workshop image with the
original shared embeddings/head rounded from BF16 to FP16. All 196 q4 decoder matrices and
the converted vision graph/weights remain unchanged. The FP16 table is split into ten row
chunks, each at most 64 MiB; lookup and output projection keep FP32 public interfaces. This
is FP16 head arithmetic, not an assertion of numerical equivalence to original FP32.

The result has the correct `iou` kind, `1,912.15 USD`, heading and both dates. The unchanged
source gate and actual offline host -> IOU processor -> card-field replay pass **1/1**. One
generation call completes at EOS after 68 tokens, with the same captured tensors, v10 prompt
and generation controls as the q4 baseline. All three native sessions are released, the owned
child exits zero without timeout, and input/source hashes remain unchanged.

The first attempt stopped before decoder creation because the staged facade admits exactly
one decoder weight shard. A separate diagnostic adapter now admits exactly the two pinned
files, retaining the original failure receipt. The prototype's graph preflight also exposed
protobuf repacking of unchanged tensor dimensions; wire-level splicing now preserves unrelated
bytes, with exact reversal and decoded-graph agreement. Eight focused tests cover wire
preservation/rejection, chunk bounds, native lookup/head operators and adapter admission.

- Successful result: `F:/Temp/OpenChat-IOU/output/qwen-v10-head-f16-native-v2-da2kJv/result.json`,
  SHA-256 `1f69f5e8457993d3d9a5ade5218857b573b5a98c418ac45af9c112df1e9cf60d`.
- Assessment: `F:/Temp/OpenChat-IOU/admin/new-model-prompts-20260910/qwen-v10-head-f16-assessment.result.json`,
  SHA-256 `f7f44169aef1bde8160dad9e8440b8e00797bf80c189b71d1381ffc7acdacb8a`.
- Initial loader rejection: `F:/Temp/OpenChat-IOU/output/qwen-v10-head-f16-native-iGakD5/result.json`,
  SHA-256 `e83a453e37a8e8c7f07260b1d05bc03404a5fef9e3f0705ceda5753d8b8f01ea`.

Elapsed time is 82.4 seconds including preparation/verification; peak native-process RSS is
approximately 8.19 GiB. The 622,329,856-byte FP16 table is created in memory only, with no new
weight download or disk checkpoint. In-memory preparation/copies inflate this RSS; it is not
a phone memory estimate. Lookup tests cover valid vocabulary IDs (including boundary,
repeated and empty cached-token inputs), not invalid-ID behavioral equivalence.

This is **not an all-WebGPU fix or a new full-corpus score**. Native FP16 execution does not
prove GPU numerical behavior or phone memory fit. Actual WebGPU execution, the full corpus,
the separate paper-receipt failure and repeated physical-phone inference remain open. No
prompt activation, production loader change, server deployment or APK update occurred.

### September 12: mixed text precision with verified converted vision

One standalone native pass through the current converted vision graph reproduces all four
feature hashes from the earlier native baseline exactly. It uses the current production
geometry/session wrapper and the captured pixel/grid tensors, not a different processor.
It saves only four `[154, 2048]` float32 feature tensors (5,046,272 bytes); no decoder is
loaded and no text generation occurs in this step.

The original decoder then generates once with those verified converted features, 196 q4
decoder matrices and original embeddings/output head. Its vision callback supplies the
features exactly once and verifies the actual input tensors; no original vision forward or
second image pass runs inside generation. Matrix hashes, all generation controls and the
input IDs/mask match the prior q4-layers-only control. The answer has the correct `iou` kind,
money, heading and dates. Both the frozen source gate and actual offline host/app card-field
replay pass **1/1**. Complete JSON fences remain, as in the other reference outputs.

This is a useful precision candidate, **not an all-WebGPU fix**: the decoder implementation
is still the original CPU reference. The converted runtime, full corpus, phone memory/repeat
tests and the separate receipt failure remain open. No model variant is activated or packaged.

- Converted vision: `F:/Temp/OpenChat-IOU/output/qwen-v10-converted-vision-BNnVtW/result.json`,
  SHA-256 `3e8d22fc2eb799b4446adac41849f5dac46e7b4a1a5c9e4b3de7da8ae2e905cf`.
  Elapsed 15.8 seconds including verification; peak RSS approximately 1.90 GiB.
- Mixed-text generation: `F:/Temp/OpenChat-IOU/output/qwen-v10-original-q4-text-9jl3h_s9/result.json`,
  SHA-256 `24f68cf93611a46400f1ccce9587fdd6618679311848e5f3f30067ca4f9b9547`.
  Elapsed 41.3 seconds including load/verification; 68 generated tokens and EOS.
- Assessment: `F:/Temp/OpenChat-IOU/admin/new-model-prompts-20260910/qwen-v10-mixed-vision-assessment.result.json`,
  SHA-256 `a0fa95386ac415196e69aac16b633cdb0d7b7ad50997587fdd30788684b605b2`.

Two positive/negative feature-admission tests pass before generation. Both owned children
exit cleanly, the native vision session and original model are released, and all source,
input and feature hashes are verified. There are no new model downloads or weight copies.
At the time of these diagnostic tests, the externally configurable model catalog was only
a proposal. It was subsequently authorized and implemented in OpenChat; these earlier tests
do not establish catalog correctness or qualify additional models. Application prompts remain
owned by this repository, independently of OpenChat's declarative model catalog.

### September 12: converted text-weight values isolated in the original implementation

The original eager CPU implementation now runs the same workshop input with the exact
converted q4 text weights expanded into FP32 **in memory only**. A current-graph manifest maps
197 matrices and 113 unquantized normalization parameters. The latter match the original
values before intervention. Complete packed/scales/zero-point payload hashes prove that the
prompt embedding and output head contain identical tied weights. Three small native ONNX
operator probes validate the unpacking formula (maximum absolute difference below 3e-7).
No new checkpoint or dequantized weight file is written.

All controls keep original FP32 vision, the original implementation, captured inputs and all
generation controls unchanged. Each generates once within the 96-token cap and finishes at
EOS. The unchanged source and actual offline host/app card-field gates give:

| Text-weight values | Workshop kind | Source/card result |
|---|---|---|
| Original embeddings/head and decoder layers | `iou` | Pass |
| Converted q4 embeddings/head and all decoder layers | `settlement` | Fail |
| Converted q4 embeddings/head only; original layers | `iou` | Pass |
| Original embeddings/head; converted q4 layers only | `iou` | Pass |

Both partial controls reproduce the original answer byte-for-byte. Their copied matrix
hashes match the corresponding matrices in the all-q4 run. This shows that the converted
text-weight values are sufficient to reproduce the error without OpenChat's runtime, and
that the two groups interact on this particular prompt/image. It does not identify one
broken layer or explain the separate receipt failure. Restoring the original embeddings/head
is a candidate to test with converted vision and runtime, not a production fix or a new
full-corpus accuracy score.

- All-q4 text result: `F:/Temp/OpenChat-IOU/output/qwen-v10-original-q4-text-fa__sx4o/result.json`,
  SHA-256 `839c64b5d69f24536b4f6701ee62bbc17592262aed8f5e52e2a2b8d87e791178`.
- Q4 head only: `F:/Temp/OpenChat-IOU/output/qwen-v10-original-q4-text-r9lq5548/result.json`,
  SHA-256 `a7de018d3c7caf72b2eede68638d77f25b8a738163b270362fb5a18d0831ec45`.
- Q4 layers only: `F:/Temp/OpenChat-IOU/output/qwen-v10-original-q4-text-afjw53vx/result.json`,
  SHA-256 `eaec0f1687fc41dbe107528c582415b11e417f1d063f9524ab9999e0a673ebcc`.
- Current weight/operator manifest: `F:/Temp/OpenChat-IOU/admin/new-model-prompts-20260910/qwen-text-weights-current.manifest.json`,
  SHA-256 `2f051f85d53486bbaec8770f7d6a5f3e77748794ab834a1991535286eb6b123c`.
- Assessment: `F:/Temp/OpenChat-IOU/admin/new-model-prompts-20260910/qwen-v10-text-weight-isolation-assessment.result.json`,
  SHA-256 `d6e48d914246168c0f756fbfd3a5b4fc305d86cb017d959beff08f215cc0fc14`.

Four unpacking/composition tests and two partition-admission tests pass. A metadata preflight
initially omitted the export's differently named final normalization parameter; its exact
observed name was mapped, retaining the 113-parameter requirement, before any operator/model
run. All three owned generation children exit zero without timeout, release their models and
verify source/input identity. No prompt activation, server/APK update or live acceptance occurs.

### September 12: original vision into the converted text path

A fresh, isolated forward through the cached original FP32 vision model produces its main
image features and all three DeepStack outputs from the exact v10 workshop pixel/grid tensors.
All 315 vision parameters are loaded strictly from the original checkpoint. No text decoder
or image processor is loaded in this step. Four finite `[154, 2048]` float32 tensors are saved
(5,046,272 bytes total); the inputs and pinned sources remain unchanged.

The native reference then performs one generation with those four original feature tensors
substituted for the converted vision outputs. All three converted stage graphs and weight
bytes, text embeddings, 46 generation controls, input IDs, mask and 96-token cap stay identical
to the native baseline. The unchanged staged transport receives the replacement features.
The output still says `settlement` instead of `iou`; money, heading and dates remain correct.
Its JSON whitespace changes, so this result is **not byte-identical** to the baseline.

The unchanged source oracle and actual host/app offline card-field replay both reject it.
Restoring the complete vision output is insufficient on this case; the remaining converted
text-embedding/decoder/transport path must also be investigated. This does not isolate
quantization from export/runtime effects or prove a decoder-only defect. There is no full
corpus rerun, production patch, prompt activation, server/APK update or phone qualification.

The converted versus original main features have cosine similarity 0.8613 and relative RMSE
0.5223. The three DeepStack cosines are 0.9456, 0.8634 and 0.8788. These quantify differences,
not a predeclared numerical acceptance threshold or proof of their cause. No weight files
were downloaded or duplicated; the new binary artifacts are only the roughly 4.81 MiB features.

- Original-vision receipt: `F:/Temp/OpenChat-IOU/output/qwen-v10-original-vision-cpqptno6/result.json`,
  SHA-256 `7e9aab80f0714da7169eb11097c1dac807d9ac88b83cacffa1b2cf1093678642`.
  One vision forward; 18.1 seconds including verification; owned child exits successfully.
- Hybrid receipt: `F:/Temp/OpenChat-IOU/output/qwen-v10-original-vision-native-Svi1ok/result.json`,
  SHA-256 `07164f038f705f9ce9e802574978528d9f30e4d0eb22dd5856e13f5ff62e662b`.
  One generation; 113.0 seconds including verification; peak RSS approximately 4.48 GiB.
- Assessment: `F:/Temp/OpenChat-IOU/admin/new-model-prompts-20260910/qwen-v10-vision-isolation-assessment.result.json`,
  SHA-256 `af81ba39facd640a1811e59a33eb96c45da47bc27f97da549f1cc0156e9414bb`.

Two original-feature contract tests and two native substitution/comparison tests pass before
inference. All native sessions are released, the owned child exits cleanly, and feature,
source and input hashes are verified. The 45 scoped IOU prompt/replay/saved-Type tests also
pass after this turn's first documentation update; these are not model-accuracy acceptance.

### September 12: converted CPU reference and position-table intervention

The current staged facade, published graphs, external weight bytes and exact captured v10
workshop inputs were reused in a bounded native ONNX CPU reference. This is not a run of
the stale September 9 driver: only its frozen tensor/facade helpers were reused. All 46
effective generation controls match the WebGPU capture; generation remains greedy and
limited to 96 new tokens. The native answer is **byte-identical to WebGPU**, including the
incorrect `settlement` classification. Original FP32 gives the correct `iou` on those inputs.

A second isolated native run restores only `model.visual.pos_embed.weight` from the cached
original checkpoint, expanding BF16 values exactly into an in-memory FP32 table. Four
quantized position reads become ordinary Gather reads; all other learned weights and graph
bytes are preserved, with exact reversal checked. The answer remains **byte-identically
wrong**. Do not activate this intervention: this one table is not a demonstrated fix.

The converted-model error therefore does not require WebGPU. Wider weight quantization,
export and runtime differences remain unresolved; this does not prove quantization alone.
These are one-case diagnostics, not a new corpus score or CPU app fallback. The source and
actual host/app offline card-field oracles reject all three converted answers and accept
the original reference, without changing expected facts or production normalization.

- Native baseline: `F:/Temp/OpenChat-IOU/output/qwen-v10-native-onnx-dJnxsC/result.json`,
  SHA-256 `3f1b245dff594abe40fcb429843dc5bffa9090d5b807d342b628131cc5f8821d`.
  Elapsed 82.6 seconds; peak RSS approximately 4.48 GiB.
- Table-only variant: `F:/Temp/OpenChat-IOU/output/qwen-v10-position-f32-native-vHANEr/result.json`,
  SHA-256 `66129b11d5c46411c3b267fddc2abdf5ff066e2d6da26521a17c2e9fc83b0765`.
  Elapsed 112.7 seconds; peak RSS approximately 4.48 GiB.
- Comparison: `F:/Temp/OpenChat-IOU/admin/new-model-prompts-20260910/qwen-v10-native-comparison-assessment.result.json`,
  SHA-256 `f3b93c5b8fdf70bfc44bed16f9294a72ed39d04104057c432f9b09cd9a9bb47e`.

Two native admission tests and the position-intervention proof test pass. An initial
preflight check incorrectly compared duplicate TensorProto offsets; bounded reads proved
their actual payloads identical, and the corrected assertion verifies structure excluding
only offsets plus every payload hash. No inference ran during that failed preflight.
Both final children exit cleanly, all three native sessions are released, inputs and sources
stay unchanged, and no new model download, checkpoint copy, production change or APK occurs.

### September 12: Qwen explicit payment-completion contract v15, rejected

Following the matched-original evidence, this candidate replaces the app enum with an
explicit JSON `payment_completed` boolean and requests currency first, separately from the
numeric amount. Heading and date instructions remain generic; there are no document names,
example amounts, app-selected types or image-specific terms in the prompt.

Eight fresh calls on the unchanged production-96 WebGPU worker complete. The unchanged
source oracle scores **4/8**: the Arabic and English transfers, Spanish paid receipt and
unpaid hire pass. Dates pass 8/8. Currency passes 7/8, headings 7/8, literal amount strings
6/8 and payment classification 6/8. The model now supplies the receipt's printed EGP, but
still merges its two heading lines. It invents USD on the currency-free estimate, classifies
both agreements as paid, and removes printed grouping commas on those two amounts. Removing
those commas does not change the numeric amount; it still violates the declared transcription
contract and is recorded separately from the substantive currency/payment errors.

All eight outputs fit the proposed wire grammar, but that is **not** accuracy acceptance.
The boolean-to-kind adapter is a diagnostic prototype only, never added to the production
processor. Source expectations were derived from the same frozen currency/amount/heading/
date/payment facts, not from this candidate's outputs. Reject v15 without modifying those
oracles or replacing the saved v10 prompt. JSON-only remains 0/8 (complete enclosing fences).

- Prompt `F:/Temp/OpenChat-IOU/admin/new-model-prompts-20260910/qwen-image-v15.prompt.txt`,
  1,271 bytes, SHA-256 `41f593260e400e595744d4f7c844d1c550ea3e34c7014718240fec6648696db8`.
- Specification `qwen-image-v15.experiment.json`,
  SHA-256 `c60e214b23d2206c20bd75db568f5245b18d61d22fe2f0c4bd55630940778d1f`;
  plan `7d4d0191a8e71d7e0fb9f394b1accec6c39b46618c0aa29b6a8313b751b1d402`.
- Result `F:/Temp/OpenChat-IOU/output/playwright/qwen-raw-contract-eight-production96-dTHzzW/result.json`,
  SHA-256 `00226d536386005df78400f9a7760f3765ec73205babd94991570600d8a87d2e`.
- Frozen source assessment `F:/Temp/OpenChat-IOU/admin/new-model-prompts-20260910/qwen-image-v15.assessment.result.json`,
  SHA-256 `a6a6fd265c6b60a4b3d4fc4e1748f0567741dc308f88808de548840ad7ce42b6`.
- Full console: 3,330 records / 1,078,296 bytes,
  SHA-256 `aa3efa45cd8cf607332345f7709d154196475bde6059f81f85993d5d0426ed4b`.

One harness admission test and two positive/negative source-contract tests pass before
inference. Runtime/cache/retirement/owned-browser cleanup gates pass; no OCR, retry,
download, account access, production adapter change, activation or APK update occurred.

The local converted model inventory contains existing q4 artifacts, not a cached
higher-precision converted variant. The subsequent no-download native reference and
position-table-only experiment are recorded above; historical driver results are not
substituted for those current-graph comparisons.

### September 12: best Qwen v10, matched original-model comparison

Two fresh WebGPU calls with the unchanged v10 prompt reproduce both previously failing
answers byte-for-byte. Observation-only instrumentation captures `input_ids`,
`attention_mask`, `pixel_values` and `image_grid_thw` at the actual `model.generate`
boundary, forwards the same argument object once, and verifies every tensor after generation.
Each input has 409 text/image tokens and 616 raw image patches (154 merged image tokens).
The compiled production worker is unchanged except for that reversible observation hook;
the app's 96-token generation setting and all-WebGPU configuration remain unchanged.

The cached original checkpoint then consumes those exact tensors in two sequential,
isolated CPU/FP32 reference runs. Original tokenization matches the captured IDs, all 46
captured generation controls match, both outputs end at EOS (59/73 generated tokens),
inputs remain unchanged and both owned children exit cleanly. These are diagnostic runs,
not app fallbacks. No new model download or checkpoint copy was made.

| Case | Converted q4 / WebGPU | Original FP32, same inputs |
|---|---|---|
| Paper receipt | Merged heading; `350.00` without the printed EGP | Byte-identical answer, including both errors |
| Workshop agreement | Correct money/dates/heading; wrong `settlement` | Correct money/dates/heading and `iou` |

The unchanged source oracle and current host/IOU offline card-field replay score **0/2**
for these WebGPU failure cases and **1/2** for original FP32. These are the two selected
failure cases, not a new eight-image accuracy score. Neither output format passes the
JSON-only instruction because both models produce complete enclosing fences.

This rules out conversion/WebGPU as a necessary cause of the receipt failure, but does
not distinguish prompt interpretation from insufficient input detail. The workshop result
implicates the combined converted-weight/runtime differences; it does **not** isolate
quantization from implementation. Therefore, do not claim that changing a prompt or a GPU
setting alone fixes both. Do not add image-specific corrections, retries or OCR in OpenChat.

Evidence (all under `F:/Temp/OpenChat-IOU`):

- WebGPU receipt: `output/playwright/qwen-v10-paper-input-capture-OC1Q0b/result.json`,
  SHA-256 `ccfc0105289084537333999deb96f52ac85b9802fd8e91f79512c10734da37aa`.
- WebGPU workshop: `output/playwright/qwen-v10-workshop-input-capture-WeNXTA/result.json`,
  SHA-256 `f97edf2315dd4425133ca9d664c1bf919be81fe177149fd2da7cb372784b16f4`.
- Original receipt: `output/qwen-original-captured-v10-ui7o33es/result.json`,
  SHA-256 `47ec5cf948cd902281cd6d5c0eee3843e9ad8a15ed5f8207f92833ac45ce8ac3`.
- Original workshop: `output/qwen-original-captured-v10-e8kq6uxs/result.json`,
  SHA-256 `53317b81984095516416ffecad96e609b94d9dfb2eff7ca51441977350869d26`.
- Frozen-source/app comparison: `admin/new-model-prompts-20260910/qwen-v10-matched-reference-assessment.result.json`,
  SHA-256 `8a3bd8d543d564cf6d45fced3bb12e23b5fe709ad2c73edebc388fdd6b480fe6`.

The capture adapter's offline composition/admission test and two reference admission tests
pass. The corrected capture admission test was rerun after both references; all 45 scoped
prompt-template, raw-output and saved-Type card replay tests also pass. One initial
CLI-admission error stopped before browser launch; the corrected adapter
completed both actual captures. No prompt activation, server/APK update or live card delivery
occurred. Further work must keep input-detail effects separate from converted-model effects,
and rerun the unchanged full corpus before promoting any candidate.

### September 12: Qwen question-style v14, rejected

V14 retains v10's heading-first four-field contract and date array, but uses direct
questions to ask for each field. Eight fresh production-96 WebGPU calls complete without
GPU errors. Headings and dates pass **8/8** each, including the previously merged receipt
heading; money-string fields pass **4/8**, and payment classification passes **6/8**.
The complete source and current-host/IOU card-field gates both score **3/8**. Reject v14;
neither the source oracle nor IOU's money grammar was loosened to promote it.

The payout image loses `$` and is wrongly classified as completed payment; the paper
receipt still loses EGP; the workshop is also wrongly classified as paid. Two other answers
copy the printed `Total:` label into the monetary-value field, so IOU rejects those whole
raw candidates. Those label copies are a field-format/contract failure, not invented money.
The Arabic transfer, English transfer and unpaid hire pass. Requested field order is 8/8;
JSON-only is 0/8 because the complete answers are fenced.

The reusable candidate runner accepts a hash-bound, eight-case prompt-only specification;
it cannot alter the existing source facts, model, images, generation budget or app expectations.
Its preflight test and two positive/negative source/app tests pass. Runtime receipts verify
16 devices / 39,976 retired buffers, 14 unchanged cache bodies, the full console, and closed
owned browser/page/proxy. No OCR, extra image pass, retry, download, account action, activation,
server deployment or APK build occurred.

- Specification `F:/Temp/OpenChat-IOU/admin/new-model-prompts-20260910/qwen-image-v14.experiment.json`,
  SHA-256 `3320fcae2fff2863a89c45c4bfc0bfc4f8bf1c06d89c34c9a4ef2ab8b4bb6e4d`;
  prompt 1,154 bytes, SHA-256 `939c81ae84aad89254266b1e4cc38e04a1776ae73f155a684a206492d2a7193b`.
- Predeclared plan `6063f1008f392a4ee210409271c431ba22c4b1a77c5345b4e6ec421143b7f065`;
  runner `qwen-four-field-candidate.mjs` SHA-256 `7c91cd5523577d5c71bd561748958449599206bba060f93b1d0e138afff991e0`.
- Result `F:/Temp/OpenChat-IOU/output/playwright/qwen-four-field-candidate-eight-production96-QdnXtN/result.json`,
  324,970 bytes, SHA-256 `bced944f1598ecb201abbc2460bce4c501fe27287a7ab372cb5cfa4e7acb98f8`.
- Console 3,206 records / 1,037,530 bytes,
  SHA-256 `e0d120511a25e0e85818905cbfcd4ad14274c4ed3bb36487b1e8b783db4cbd2b`.
- Frozen assessor `qwen-four-field-candidate-assessment.mts`
  SHA-256 `f15c48c20cc6fe86f5013b1749b48ff7ba7862b83ab7fd70c7bf70b4eca0d153`;
  saved `qwen-image-v14.assessment.result.json`
  SHA-256 `714eaf35c4e4d8775a0af60910f4bb93e22668b6a591305d46afd62d6df7dd9b`.

The subsequently completed best-prompt original FP32 comparison is recorded above.
The earlier matched-input v7 evidence below concerns a different prompt/image case and must
not be substituted for those fresh v10 results. All CPU references remain isolated
diagnostics, never an app fallback or a change to all-WebGPU.

### September 12: Qwen kind-first order-only control, rejected

Qwen v13 moves exactly one complete declaration line from v10: `kind` becomes first,
followed by `heading`, `total_text`, `dates`. All other prompt bytes, four field definitions,
image identities, existing source oracles, generation settings and the production worker
remain unchanged. Preflight checks prove the exact line move; the prompt remains 1,189 bytes.
This is a controlled order-only regression, not proof of a particular internal model
mechanism or exclusion of every possible source of inference nondeterminism.

All eight fresh calls complete, but **source accuracy and current-host/IOU card-field replay
both score 4/8**. Qwen follows the requested key order on 8/8 but still uses JSON fences on
8/8 (JSON-only 0/8). The original receipt heading/currency and workshop classification failures
remain. Two new regressions are an amount appended to the English transfer's heading and
the entirely unprinted date `2023-04-05` on the date-free estimate. The original source
images were visually rechecked; no date was added to the expected values or repaired out of
the model answer. Reject v13 and retain v10, whose recorded source result remains 6/8.

Evidence in `F:/Temp/OpenChat-IOU/admin/new-model-prompts-20260910`:

- Prompt `qwen-image-v13.prompt.txt`, SHA-256 `85460dd075481a399d1827d3dc2805e7a475e16883a929cfaa73bcd77f57e62b`.
- Runner `qwen-four-field-order.mjs`, SHA-256 `e4b6c1ac15db427c6d538584522fd809411242f92583cbd0c090a85b27cd6278`;
  predeclared eight-call plan `731620f29fa7781880ba43b4e65b8d85253f8a9c655979446ad946ccc993903e`.
- Result `F:/Temp/OpenChat-IOU/output/playwright/qwen-four-field-order-eight-production96-QBh2OE/result.json`,
  327,680 bytes, SHA-256 `1c166c53e96e2b2d5b7d19eeaad8847f0ffc898edf45d75a603e2ea497e0dee3`.
- Complete console: 3,176 records / 1,027,764 bytes,
  SHA-256 `9a2e1e606e722b27cbced1bb40164971a21d5b799aaa7d807471d3e47065d038`.
- Frozen assessor `qwen-four-field-order-assessment.mts`,
  SHA-256 `ac5957121b4e6c1220ef5b1cecf6577193da976b0754ada914b6c30eb06d5e07`;
  saved assessment `qwen-four-field-order-assessment.result.json`,
  SHA-256 `1748d9638e20cc8b73e90f0d2fbe69324a2ee9503bf3fd1dd4478ddee27b58b7`.

Runtime checks cover 16 devices / 39,772 retired buffers, all 14 cache bodies, full console,
unchanged sources/cache, and owned page/browser/proxy cleanup. No GPU errors, downloads,
OCR, retry, extra image pass, account operation or submission occurred. The runner's one
preflight and the assessor's two positive/negative tests pass; the accuracy CLI correctly
exits 1. The current host/app replay body is reused without changing its assertions.

Five new generic host dispatch tests separately verify exact-once caption forwarding,
preservation of raw app fields, and canonical fallbacks for unknown/absent model IDs and
text-only requests. The scoped host suite now passes **473 tests** across six files; the new
test file passes scoped TypeScript checks and ESLint. These are interface tests, not model
accuracy or a new audio/device acceptance result. No production source or prompt registration
changed. The app adapter documentation was corrected to reflect the already-implemented,
not-yet-activated `normalize_raw` integration.

The subsequent question-style Qwen v14 screen is recorded above. Its rejected prompt is
retained only in project temp, not the manifest or repository's saved best prompt.

### September 12: exact Gemma-text control on Qwen, rejected

The five-field Gemma v15 prompt was submitted byte-for-byte to Qwen on the same eight
previously exposed images, using the unchanged production 96-token WebGPU worker. The
strict field oracle, existing IOU `labeled-values` date adapter, and expected card fields
were frozen before inference. No OCR, crop, second pass, retry, downloads, model switch,
account access or app action was used. All eight fresh calls completed; runtime checks,
14 cached artifact body receipts, GPU retirement and owned-browser cleanup passed.

The result is **3/8 strict source passes and 3/8 current-host/IOU card-field passes**.
JSON-only formatting separately fails 0/8 because Qwen adds complete JSON fences (which
the host accepts). The actual five failed cases are:

| Image | Failure in the raw model answer |
|---|---|
| Payout range | Missing `$`, omitted amount grouping, no date separator, and incorrect completed-payment classification |
| English transfer | Memo chosen instead of the required top heading |
| Tilted paper receipt | Subtitle chosen instead of the heading; missing EGP |
| Workshop agreement | Incorrect completed-payment classification |
| Unpaid hire | Incorrect completed-payment classification |

The Arabic 12,900 EGP transfer, currency/date-free estimate and Spanish payment pass.
The payout's malformed date causes app normalization to reject the whole candidate; other
complete but inaccurate answers can form cards and are still explicitly failed by the source
oracle. Runtime success, valid JSON and schema conformance are not factual verification.
No app keyword correction or source-specific fallback was added to make these answers pass.

Evidence under `F:/Temp/OpenChat-IOU/admin/new-model-prompts-20260910`:

- `qwen-five-field-control.mjs` SHA-256 `76dd83222f339f043426dc277e0f6f7a233821b511198d3d92f952183847919c`.
- Predeclared eight-call plan `be3c790497223f3be99e015d6948562a950bc16d5dbb7883e043c25c6a07e142`.
- Raw result `F:/Temp/OpenChat-IOU/output/playwright/qwen-five-field-eight-production96-fe8HqW/result.json`,
  319,613 bytes, SHA-256 `ce45631e42e69980b7aaf620311ff157bc7155325a2947afb9f65d23a658c82f`.
- Complete console: 3,274 records / 1,059,818 bytes,
  SHA-256 `2f16aed5bbaf33cac6031fba69508e626dba7fe8056f48c446d311ef84007f66`.
- Frozen current-source assessor `qwen-five-field-assessment.mts`,
  SHA-256 `168b9877655df3bf27a05e2dc8a95b5a712ca93a09b881496637a3734598aada`;
  saved assessment `qwen-five-field-assessment.result.json`,
  SHA-256 `26a0544487090e65d667ca7ae159195cf1526d4f8098a4c0ee882e3b40545b1c`.

The new runner preflight passes one test; the pre-inference assessor checks pass two tests,
including deliberately wrong money, missing dates, duplicate keys and incomplete JSON.
Historical assessors and their older host pins were not rewritten.

Added 17 IOU saved-Type replay tests use the unchanged eight Gemma captures through the
actual local processor and card hydration. Both account-local direction defaults retain
amounts, currencies, dates, notes and missing evidence; rendered labels and confirmation
payloads use `You owe` / `Owed to you`, and manual direction edits survive hydration refresh.
Together with the existing direction/event tests, these are 34 passing unit tests. This is
not a live private-grant/reconnect or delivery test and performs no inference or submission.
The focused eleven-file IOU suite passes 399 tests; the new file has no scoped TypeScript
diagnostics. The first combined run caught a documentation assertion expecting the original
unqualified-candidate warning; that warning was restored without weakening the assertion.

Nothing was activated, registered, deployed, built into an APK, committed or pushed by this
control. Gemma v15 and Qwen v10 remain distinct saved candidates, with Qwen accuracy still
the blocker to model-pair activation. Fresh integrated inference, broader/caption/multi-entry
cases and physical-phone acceptance remain required.

The retained four-field baselines, Qwen v10 and [Gemma v12](gemma-4-e2b-raw-image.txt),
both omit the currency printed across the tilted receipt's total row. Qwen also merges that
receipt's subtitle into its heading and classifies a workshop confirmation as completed
payment. Neither prompt is ready to activate. All eight date cases pass for both models;
successful inference is not counted as source accuracy. The follow-up wording revisions were
retested and rejected: both scored 5/8. They remain in project temp; the repository prompt
files retain their exact, better recorded results.

The newer split-money Gemma v14 has now completed all eight exposed source cases: **7/8**.
It recovers the receipt currency but invents `$` on the currency-free estimate. Qwen v12
remains 1/2 in its targeted screen. A subsequent unchanged historical six-field Qwen prompt
passes those same two cases on the current worker, including the receipt's heading and
currency. The subsequent remaining-six screen below rejects that Qwen control. None is activated.

The four-field baseline files remain exact copies of their tested templates, not silent
replacements. Qwen v10 copies `heading`, `total_text`, `dates`, and `kind`; Gemma v12 copies `note`
(the heading), `total_text`, `date_text`, and `kind`. Both preserve printed money and date
evidence. IOU must render Gemma's one `{{currency_symbol_policy}}` placeholder using its
existing policy before inference. The four cases are exposed development examples, not an
unseen-image accuracy estimate. Qwen emits fenced JSON; the existing strict host parser accepts
it, but its JSON-only instruction still fails separately. Gemma v12 emits JSON-only singleton
arrays rather than the requested single object.

Do not register these raw formats in the existing per-model v1 prompt map. IOU's canonical
schema still requires numeric `amount`, and normalizing after host conformance would lose or
reject raw fields. Activation needs a generic, explicitly opted-in app-normalization stage
before canonical validation, coupled atomically to prompt selection. Older clients must retain
their canonical-compatible prompt. IOU alone must strictly validate and convert raw money,
dates, headings and private-Type evidence; canonical validation must remain unchanged.
Broader sources, captions, multiple transactions, repeated requests, real cards and the
physical phone remain separate gates. These files do not change the app registration or APK.

### Broader production96 source screen

The additional four rasters were independently viewed and their literal expectations frozen
before either model ran: tilted paper receipt, ISO-date workshop range, Spanish completed
payment, and unpaid equipment hire. This policy retains printed currency order/grouping and
allows only the explicitly listed complete dates or timestamps. No result repair or changed
oracle was used. The assessor CLI exits nonzero for both failed broader runs despite runtime
completion. All eight new requests completed; source/cache identity, complete native console,
buffer retirement and owned browser/worker cleanup passed, without downloads or OCR.

- Policy: `F:/Temp/OpenChat-IOU/admin/new-model-prompts-20260910/v10-v12-broader-source-policy.json`,
  SHA-256 `8976d80f0fb979745a91ca58ded1881fa89540ea62c2404611b8a861971a9f52`.
- Qwen result: `F:/Temp/OpenChat-IOU/output/playwright/broader-four-production96-qwen-MPmDSe/result.json`,
  SHA-256 `724c28d1734b464cf5d0f0aa31f640a625f3e543b8a49fd3da181a429bf3e4e4`.
- Gemma result: `F:/Temp/OpenChat-IOU/output/playwright/broader-four-production96-gemma-PFb3DD/result.json`,
  SHA-256 `23f0da43155883bb2f3c3e9feff3ef590e55460efa9e12db10aee7ce6cfa6536`.

Eight selector tests and seven assessor tests pass; they validate the diagnostic machinery,
not the rejected answers. The older eight-image corpus contains three real user images and
five synthetic images. Historical `holdout` IDs are not claims of unseen real-world accuracy.

### Rejected follow-up wording revisions

The next frozen screen changed Qwen v10's heading, money-row and payment-proof instructions
(v11), and changed only Gemma v12's money-row instruction (v13). Neither changed the date
instructions, images, expected source facts, actual production 96-token worker or runtime.
These were not replacements for the saved repository templates.

| Experimental prompt | Original four | Broader four | Total | New regressions |
|---|---|---|---|---|
| Qwen v11 | 3/4 | 2/4 | 5/8 | Appended the English transfer's amount to its heading. Existing receipt currency/heading and workshop kind failures remain. |
| Gemma v13 | 3/4 | 2/4 | 5/8 | Included the estimate's total label, and the hire document's total/date labels. The receipt's currency is still missing. |

All 16 requests completed, with runtime/source/cache identity and owned browser cleanup
checks passing. Each of the four independent accuracy-assessor invocations exits nonzero.
Qwen still used enclosing Markdown fences; Gemma used JSON-only singleton arrays. No
label-stripping, missing-currency defaults, changed expected values, OCR, retry, fallback or
second inference was used to turn these failures into passes. Qwen's dates remain correct
on all eight; Gemma's hire date value now contains labels and fails the unchanged contract.

- Frozen policy: `F:/Temp/OpenChat-IOU/admin/new-model-prompts-20260910/v11-v13-followup-policy.json`,
  SHA-256 `7ac3e9de30556944cc5df5062f72b16a1f5be7d5f79aaa536c8d339c2d3baa8e`.
- Qwen original result: `F:/Temp/OpenChat-IOU/output/playwright/followup-production96-qwen-original-jT7R1N/result.json`,
  SHA-256 `93987aeb62d63c9101ae06c25e3c92083e94e821d9c76a201b46158d07db1a6c`.
- Qwen broader result: `F:/Temp/OpenChat-IOU/output/playwright/followup-production96-qwen-broader-SIgq0g/result.json`,
  SHA-256 `a8873ee724ad362a132ecff2e808556dc656a2f8b5cb1c1499405a5b0aa907f2`.
- Gemma original result: `F:/Temp/OpenChat-IOU/output/playwright/followup-production96-gemma-original-ULhyEI/result.json`,
  SHA-256 `9e5dbb923d06ecbb1ba37059d7509a6bd9810846c7077bff29adcb957026fcb0`.
- Gemma broader result: `F:/Temp/OpenChat-IOU/output/playwright/followup-production96-gemma-broader-QCzGo7/result.json`,
  SHA-256 `e6a9b4906f341672ddcf0951a5ee1aabe8fb10e6ad4b9cff0eab134e45171b03`.

Thirteen selector tests and six assessor tests also pass. These test the experimental
machinery, not model accuracy. The retained v10/v12 prompts remain the better candidates.

### Currency omission: evidence for the next isolated test

Historical runs on the same receipt copied `EGP` when currency was requested in a separate
field; a combined-money prompt omitted it. The separate-field Qwen result is
`F:/Temp/OpenChat-IOU/output/playwright/qwen-production-full-model-20260909-LBSCcX/result.json`
(SHA-256 `c53f23e3189f9d332ac6c904fd51517274fd890d536ec86366e72f889e3f532b`),
and the combined-money comparison is
`F:/Temp/OpenChat-IOU/output/playwright/qwen-production-full-model-20260909-d7ssp9/result.json`
(SHA-256 `fa44d4adcf8ecdd0c77773ebda5084c76224837ff477dee8374b501437137287`).
Gemma also copied the separate currency in
`F:/Temp/OpenChat-IOU/output/playwright/gemma-retained-cache-20260909-MRJHTg/result.json`
(SHA-256 `423f590bf9117b957d9c1f545e4df5cb28a59214e7da02d742c11430c5073dcf`).

These used an older worker (`5c86880afd9105ca2f5fd26427420a702ff6719e46397e4f7fb08909c5ca38ea`),
and their prompts have other differences. They support testing output-field selection;
they do not prove a single-variable cause, current-runtime equivalence or whole-corpus
accuracy. The historical prompts also have other source failures. The bounded screen below
separates raw currency/amount while retaining the saved candidates' date formats on the
actual current worker; its results are scored independently.

### Split-money targeted screen: Gemma improves; Qwen remains incomplete

Qwen v12 derives from saved v10, and Gemma v14 derives from saved v12. Only the combined
`total_text` declaration is replaced with `currency_text` then `amount_text`, plus the
necessary key count, closing references and Gemma list numbering. Heading, date and kind
instruction content is unchanged. These are five-field formats, now supported by the
unwired app adapter below. Both prompt files remain diagnostic artifacts in project
temp and are not registered with OpenChat.

| Model | Tilted receipt | Workshop confirmation | Targeted source score |
|---|---|---|---|
| Qwen v12 | Still omits `EGP` and joins heading with subtitle; amount/date/kind correct | All five fields correct, including the previously wrong kind | 1/2 |
| Gemma v14 | All five fields correct, including the previously missing `EGP` | All five fields correct | 2/2 |

This establishes that Gemma can read the missing currency on the current worker with this
representation. Splitting the money fields alone does not resolve Qwen's receipt errors.
It does not establish which individual token or clause caused the change. No result was
repaired, and no unsupported conclusion about phone accuracy or unseen images is drawn.
All four requests completed without runtime errors; source/cache and cleanup checks passed.
Qwen's accuracy CLI exits 1, Gemma's exits 0. Qwen still encloses JSON in fences; Gemma still
returns singleton arrays. No OCR, second pass, retry, budget increase, model download, app
action or production edit occurred.

- Policy: `F:/Temp/OpenChat-IOU/admin/new-model-prompts-20260910/v12-v14-split-money-policy.json`,
  SHA-256 `534f53af2b260ab201c863bd928b888e2b64b7191d14eb96a420f3c46ff93241`.
- Qwen prompt: `F:/Temp/OpenChat-IOU/admin/new-model-prompts-20260910/qwen-image-v12.prompt.txt`,
  SHA-256 `075995da5f54dacfd8951680ae06692de8673e9cfff423d7cfd8806c4b51dbb4`.
- Gemma template: `F:/Temp/OpenChat-IOU/admin/new-model-prompts-20260910/gemma-image-v14.prompt.txt`,
  SHA-256 `a07475840ae4b2834fdb245cb3d29cead9823206947acdc2fb606b1ed8ba1578`;
  rendered SHA-256 `c2a93ab3861e4f375daebaa3f7c913f2005797db5d1df1956a094f2f4b8f55a0`.
- Qwen result: `F:/Temp/OpenChat-IOU/output/playwright/split-money-production96-qwen-x0Ndct/result.json`,
  SHA-256 `3c9dd82cc6a17a7de14b48bf85540632e63ab96dfe1dfc31d63bb3d8cee3e9ee`.
- Gemma result: `F:/Temp/OpenChat-IOU/output/playwright/split-money-production96-gemma-MldZe4/result.json`,
  SHA-256 `207c4a45623ac73437b1a23cd960bc9c027b80287cb4f62d961b5eb506533535`.

Seven selector tests and eight assessor tests pass. Before inference, the selector's tests
caught a stale Gemma template/sequence binding; the binding was corrected, not bypassed.
The selector preserves the prior run bodies except for two-case counts and output identity;
the cache/bootstrap/retirement functions remain unchanged. The assessor preserves the
original exact source facts and runtime checks except for the explicit two-case inventory.
The 236 focused IOU artifact/conversion/date/schema tests also pass; none are substitutes
for model accuracy. All diagnostic browsers/workers are closed and caches retained.

### September 12: Gemma full screen and Qwen historical-prompt control

Gemma v14's remaining six requests completed on the same production96 worker. Five pass
all source fields; the currency-free estimate returns `currency_text: "$"` instead of the
required empty string. Combined with the prior two distinct cases, this is **7/8**, not 8/8.
All eight amounts, headings, date cases and payment kinds pass, but the invented currency
still rejects activation. The three user images retain the correct original amounts,
currencies and dates/range. The current raw result was not repaired or mapped to absence.

- Six-case policy: `F:/Temp/OpenChat-IOU/admin/new-model-prompts-20260910/v14-remaining-six-policy.json`,
  SHA-256 `6cae7f6f039cf633c20eddc99ad5f049ea7d864c31da2237cb89aa4dae6e197c`.
- Result: `F:/Temp/OpenChat-IOU/output/playwright/gemma-split-money-six-production96-2JKAf1/result.json`,
  SHA-256 `bae2885aedfadaf95bd16775f2e6ca66b2de91fc61de030aeafb7d8b05163a91`.
- Four selector and five assessor tests pass; the actual accuracy CLI exits 1.

The Qwen control then used the historical six-field prompt **byte-for-byte unchanged**
(`0ba65e0875aad21b7c5a60d7f145db66f2768bfef6fa55a5316a25ccbd00be3d`) on the current
worker and same two receipt/workshop rasters. Both pass all six source fields, including
`RIVER MARKET`, `EGP`, numeric `350`, and the workshop's unpaid classification and dates.
Numeric amounts are checked as numbers under the predeclared historical contract, not
coerced from strings. Whole-object parsing, duplicate rejection and candidate counts remain
strict. Markdown fences still fail the separate JSON-only instruction.

This current-worker control removes the earlier worker-version confound for these two
examples: the current image/runtime path can recover the receipt's heading and currency.
The changed prompt/output contract is implicated. It does not isolate which clause, field
order or representation causes the sensitivity; nor does it qualify the historical prompt
on the other six images. Historical failures on other images are not erased.

- Control policy: `F:/Temp/OpenChat-IOU/admin/new-model-prompts-20260910/qwen-canonical-six-control-policy.json`,
  SHA-256 `f4624d9a2f2d6623c7e8cd1b9be0fe628e2dfd736bd810596aaf52d7ada78f34`.
- Result: `F:/Temp/OpenChat-IOU/output/playwright/qwen-canonical-six-production96-wg8hgp/result.json`,
  SHA-256 `4fc6e3d801aa19cbef04120612b66fd11115a264ddb9e37aae0590f397c33c51`.
- Three selector and four assessor tests pass; the actual source/runtime accuracy CLI exits 0.

All eight new requests completed with no runtime errors, all source/cache checks passing,
and owned browsers/workers closed. The app adapter's final focused regression selection
passes **307 tests**, including 208 raw-evidence tests; scoped TypeScript has no diagnostics.
The partially completed parallel work was inspected and finished locally. No model assets
were downloaded, no cache was deleted, and no app registration, server or APK changed.

The subsequent continuation below completes these two experiments. Generic pre-conformance
app normalization, canonical card/reconnect checks, repeated requests and the physical phone
remain release gates. Do not promote a two-case pass or combine different prompt versions
into a full-screen success.

### September 12 continuation: Qwen control rejected; Gemma date-format compatibility

The historical six-field Qwen prompt passed only **1/6** remaining cases, for **3/8** with
its previous two distinct controls. Failures include wrong payment kind on the Arabic transfer,
missing reservation endpoints, substituted English heading, invented USD on the currency-free
estimate, and `84265` instead of `842.65` on the hire. This is not a replacement for Qwen v10.
All six requests completed without a runtime error; complete fences still fail JSON-only.

Gemma v15 removes only v14's redundant currency mapping sentence. All eight amounts,
currencies (including absence), headings and kinds now match the pinned sources. The original
strict contract still passes **6/8**: the reservation uses ` - ` instead of ` | `, and hire
includes `Start:`/`End:` labels. Both retain the correct complete endpoint values. Neither raw
answer nor the pre-inference oracle was rewritten to change that score. All eight outputs
are complete JSON-only singleton arrays.

- Frozen policy: `F:/Temp/OpenChat-IOU/admin/new-model-prompts-20260910/continuation-six-eight-policy.json`,
  SHA-256 `071d88bf1270966b7931f9d6c48ee2051cb693ec4566023ee760be830cb143ba`.
- Qwen result: `F:/Temp/OpenChat-IOU/output/playwright/qwen-continuation-six-production96-M1yIJf/result.json`,
  SHA-256 `e0e6e90ce70007f16bcf1aa5faba4eb85554cfb84c3dac5502c0ae1229299b44`.
- Gemma result: `F:/Temp/OpenChat-IOU/output/playwright/gemma-continuation-eight-production96-29T4AC/result.json`,
  SHA-256 `22448763bbed88906ac2042c530300457c92d1c97061daac8dea2b50a9a68bad`.
- Saved Gemma v15 bytes: 1573; SHA-256
  `a84d35c89fb8f3c91979a1954051769417109bb4f6785fea4fea3a3ad72048d8`.

IOU now has an explicit, still-unwired `labeled-values` date-text option. It accepts only
complete calendar values/pairs, exact spaced pipe/dash separators, and bounded alphabetic
colon labels. Labels are structural, not a list of app or image keywords. Invalid chronology,
incomplete/label-only endpoints, clock-only values, extra dates, trailing text and unsafe
controls reject the entire candidate. No date is scanned from arbitrary text or completed
from another field. The original strict default, array format, money grammar and canonical
required fields remain unchanged; no OpenChat runtime logic changed.

`rawImageModelReplay.test.ts` replays the eight unedited captures in
`test/fixtures/openchat/model-acceptance/gemma-v15-app-replay.json` through the opt-in adapter,
IOU post-processing and card-field projection: **8/8 correct app fields**, including empty
unsupported currency and the full reservation/hire ranges. This is a post-inference app-only
compatibility test, not a fresh eight-case inference under the expanded contract, generic
host integration, private-account/card attestation, phone, unseen-image or release pass.
The original strict result remains recorded as 6/8 in the fixture and tests.

The focused app suite passes **363 tests**, including 42 date-grammar tests and nine capture/
replay tests. Scoped TypeScript checks for the changed source and tests pass. Two selector
and three assessor tests also pass; both actual strict-accuracy CLIs correctly exit 1. The
14 model calls use the unchanged production96 WebGPU worker, no OCR/retries/downloads,
and retain all caches. Owned browsers/workers/proxies closed; no server, registration or
APK changed. Next gates: repeat Gemma under the declared app-compatible contract, finish
the generic pre-conformance app-normalization seam, and improve Qwen without promoting
the failed historical control.

### September 12: fresh repeat and generic host-to-app card replay

After freezing the `labeled-values` grammar and eight expected app field sets, a fresh
Gemma v15 run completes eight new production96 WebGPU requests. All eight raw answers are
byte-for-byte identical to the preceding run. Runtime/cache/source/cleanup checks pass,
the unchanged strict contract remains **6/8**, and the declared app-compatible check is **8/8**.

- Repeat result: `F:/Temp/OpenChat-IOU/output/playwright/gemma-continuation-eight-production96-r3QNSl/result.json`,
  SHA-256 `1c0a5a26baca4028a6b0f12c457c1fe8dfa85e5da7415d40b6d7a3a759f5dde1`.
- Repeat assessment: `F:/Temp/OpenChat-IOU/admin/new-model-prompts-20260910/gemma-v15-repeat-assessment.result.json`,
  SHA-256 `b1ffd7f3d71cb365e4c98fdf77a46dc64324911f193cb526321153ce50a7b5e7`.

OpenChat PR2 now implements atomic per-model prompt-map version 2 with generic
`output: "app" | "canonical"`. Raw output uses whole-JSON parsing and is sent once to the
registered app processor **before** canonical post-rules/conformance/required checks. IOU's
new image-only `normalize_raw` operation owns the raw evidence/date conversion. Success
returns explicit `sourceIndexes`; both transport and host validate the ordered binding and
host normalization requires the original count. Invalid output, context change, timeout or
app rejection builds no card and does not repeat inference. Legacy paths remain unchanged.
The app manifest is unchanged: this capability is implemented but no raw prompt is registered.

The direct offline replay uses the actual current host, actual IOU processor, canonical card
builder and IOU form/confirmation helpers on the fresh captured outputs. **8/8** match the
predeclared amount/currency/date/note/kind fields, with exactly one retained-response callback
and one normalization per image, unchanged canonical required fields, and zero network calls
or submissions. The host's requested 256-token cap resolves to the recorded 96 under the
actual browser settings resolver; no model runtime or user setting was modified. A first
replay assertion incorrectly compared object prototypes across JSON serialization; it was
corrected to exact serialized payload-byte comparison. Values and source expectations were
not relaxed. The replay is not fresh integrated browser inference, private saved-type/direction
hydration, live attestation, delivery, rendered iframe, or physical-phone qualification.

- Host/app replay: `F:/Temp/OpenChat-IOU/admin/new-model-prompts-20260910/gemma-v15-host-app-replay.result.json`,
  SHA-256 `280d436f62eb3ae36128a982162bc66d1b23a8249c0e18817c717060d19ac26b`.
- Host/shared/runner/processor focused suites: **468 passing tests**; scoped types and lint pass.
- IOU focused suite: **365 passing tests**; actual raw processor is exercised by the eight
  captured-output tests. No server, registration, APK, branch publication or model cache changed.

Remaining release gates include Qwen accuracy, integrated browser/emulator/phone inference,
private type/direction, reconnect and delivery checks, and fresh local test builds. Historical
assessors retain their original source pins; do not silently update those hashes to claim
that a past run qualified this new host integration.

### App-owned raw evidence adapter (not activated in the manifest)

`src/features/openchat/rawImageEvidence.ts` adds a pure IOU adapter for the exact saved
four-field formats and the separate five-field currency/amount formats. Its 208 tests pass.
The new fields must be independently complete: amount is never scanned or joined with
currency, and missing/unknown/aliased/mixed evidence is rejected without a default. The
existing four-field grammar and exact-cent safety remain unchanged. It validates whole money strings and date fields,
uses IOU's existing printed-currency policy, preserves missing evidence and rejects malformed
candidates. It does not inspect images, repair wrong model values, infer direction or private
Types, hydrate cards, change the manifest or activate either prompt. Numeric `amount` remains
required by the canonical schema. IOU's local processor now imports the adapter for the
explicit image-only `normalize_raw` operation, paired with OpenChat's generic version-2
pre-validation handoff. Neither candidate is activated in the manifest; fresh integrated
inference and compatible registration/build deployment remain acceptance gates.

## Original candidates and experiment history

| Model ID | Candidate | Deliberate difference |
|---|---|---|
| `qwen3-vl-2b-instruct-q4` | [Qwen3-VL 2B](qwen3-vl-2b-image.txt) | Direct field instructions, amount before currency, note after dates, no currency-choice list. |
| `gemma-4-e2b-it-q4` | [Gemma 4 E2B](gemma-4-e2b-image.txt) | Retains payment-proof framing and early note ordering from the strongest recorded shared candidate, with IOU's declared symbol policy. |

These changes target observed errors, but the first actual image screen **failed** on both
models. Earlier successes under different prompts do not qualify these texts.

## First image screen

Both candidates used the unchanged assembled WebGPU worker and existing 96-token cap,
with no OCR, crop, retry or model download. The fixed image order was Arabic transfer,
date-range image, English transfer, then a synthetic estimate with no printed currency/date.

- Qwen reached the output-token limit on the first image, returning no partial result.
  Its remaining three cases were not attempted.
- Gemma completed the first three, but none passed source/card accuracy. It selected the
  Arabic total label as the memo, selected the range total label and omitted both range
  dates, then selected the English amount label and emitted only a year in both date fields.
  Its fourth request reached the output-token limit.
- All 28,011 observed GPU buffers were explicitly freed; no unexpected device loss or
  native error was observed. Model caches were verified unchanged and owned browsers closed.

The separate scorer replays completed answers through the actual host parser and IOU
normalization/card/confirmation functions. It preserves optional heading evidence, safe
absence, and the approved currency mapping; wrappers are scored separately from factual
errors. Eight scorer tests and nine runner tests pass, which validates the diagnostic
checks, not the rejected model answers. Neither candidate is activated.

Evidence: `F:/Temp/OpenChat-IOU/output/playwright/model-specific-prompt-assessment-20260910-QflqJz/result.json`.

### Qwen completion-limit diagnosis

A separate one-image rerun observed the generated tokens immediately before the unchanged
worker's completion check. Qwen copied the correct heading and 12900 EGP, then filled `note`
with sender/payee/account details instead of the labeled memo. The response stopped inside
that string at 96 generated tokens, without an end token. This is direct evidence of wrong
field selection plus truncation, not a GPU crash; a larger output limit alone would not make
the observed note correct. No partial answer was returned as an action.

The diagnostic cleanup check passed: the worker resumed, all 7,248 observed buffers were
explicitly freed, the browser closed, and cached model/source bytes stayed unchanged. Five
offline diagnostic tests also passed. This observation does not qualify model accuracy.

Evidence: `F:/Temp/OpenChat-IOU/output/playwright/qwen-new-model-prompt-token-capture-20260910-EGyjlv/result.json`
(SHA-256 `dbbce482475b17e862321479055717a68a83bd29106f5c2b35cb3062f0ee98c9`).

### Formatting-only follow-up: still rejected

The next diagnostic revision quoted the seven field declarations and separated the two
date declarations. No field meaning, expected source value, native worker, image setting
or output budget changed. These experimental revisions remain in project temp; the two
repository templates above were not silently replaced or activated.

| Model | Completed / planned | Result |
|---|---|---|
| Qwen | 0 / 4 | First image reached the 96-token completion limit; three cases unrun. |
| Gemma | 3 / 4 | All three completed cards still failed accuracy; final image reached the limit. |

Gemma now copied the English date correctly (`13 Aug 2026`, empty single-date ending),
instead of two year-only values. It also included the Arabic heading. The Arabic and
English notes still contained amount labels rather than their memo values. The range
answer was byte-identical to v1: `Total Payout`, with both dates empty. In the actual IOU
replay, that also prevented saved-Type matching and its intended direction default.
One improved date does not qualify the whole prompt.

Six runner tests and eleven offline acceptance tests passed. Root also reran the 88 IOU
template, currency-policy and heading/Type regression tests. These are separate from the
failed image-accuracy gate. All 28,333 observed buffers in this follow-up were explicitly
freed; no unexpected GPU/device error was observed. Existing model caches stayed unchanged,
and both owned browsers closed. No phone qualification, registration, deployment or APK
build followed these failed candidates.

Evidence: `F:/Temp/OpenChat-IOU/output/playwright/model-specific-prompt-v2-assessment-20260911-NRETwB/result.json`
(SHA-256 `05166533bbc62d290b7d72f77617092f4f06ff89c888dfd4ae5831d494db26f9`).

The next investigation must address source-field selection and completion feasibility,
not assume more field-formatting edits or a larger token cap will make wrong notes correct.
The actual completed answers reached editable cards, so parser/card readiness must remain
distinct from comparison with independently transcribed source values.

### Shorter payment-purpose instructions: partial improvement, not qualification

The third diagnostic pair shortened the instructions and explicitly distinguished the
payment-purpose/memo value from monetary labels and party/account details. Caption, memo,
then heading precedence and the seven existing app fields remained unchanged. Neither
prompt contains a transaction-specific keyword, amount, date or private type roster.

With the original 96-token worker, Qwen again stopped at the first image's completion
limit. Gemma completed three images: the English transfer now passed the full source/card
comparison, including `Living Expenses` and its date. The range heading and start date
were correct, but its ending was `null`; the Arabic answer regressed to a year-only date
and a `null` ending, retaining the wrong total-label note. Gemma's fourth image again hit
the completion limit. Overall qualification still failed: 0/4 planned Qwen cases and
1/4 planned Gemma cases passed; three Qwen cases were not run.

The six runner and eleven offline acceptance tests passed independently. All 27,543
observed buffers were explicitly freed, the caches were unchanged, and the owned browsers
closed. These are desktop results, not physical-phone acceptance.

Evidence: `F:/Temp/OpenChat-IOU/output/playwright/model-specific-prompt-v3-assessment-20260911-bBdJQW/result.json`
(SHA-256 `079dd6ba68b7f45795071f7269307a2df12ae5cc22220e9421edf8d5d51fe7e0`).

Source inspection also identified two independent Qwen generation limits: the worker's
output clamp and the generation runtime's decoder-call count. A direct-worker 192-token
experiment must change both, while preserving `inputTokens + outputTokens - 1 <= 1024`
and requiring an actual end token. The resulting maximum input length is 833 tokens.
That is a context-bound calculation, not proof of accuracy or phone stability. Shared
UI/text/audio settings and production sources have not been changed for this diagnostic.

### Qwen at 192 output tokens: completion fixed, accuracy still rejected

The same third Qwen prompt completed all four original images with a separate diagnostic
worker whose two output ceilings and Qwen decoder-call ceiling were raised to 192. The
context guard, original images, greedy decoding and actual-end-token requirement were
unchanged. This is not the production worker or a qualified APK.

- Arabic transfer: correct amount, currency and transaction date, but the note copied a
  sender identifier and the ending repeated the single transaction date.
- Range image: correct amount and both endpoints, but `kind` was `settlement` instead of
  `iou`, and the note combined the heading with status/occupancy text.
- English transfer: correct amount, currency, memo and date, but the ending again repeated
  the single date instead of being empty.
- Currency-free estimate: correct amount and heading, but invented `USD` and classified
  the unpaid estimate as `settlement`.

All four source/card comparisons failed. Thus the larger limit resolves this batch's
truncation, not its field-selection or missing-evidence errors. All 25,306 observed GPU
buffers were explicitly freed; caches and baseline sources stayed unchanged, the owned
browser closed, and no unexpected device loss/native error was observed. The 12 offline
assessment tests pass separately; they do not make these model answers accurate.

Evidence: `F:/Temp/OpenChat-IOU/output/playwright/qwen-v3-192-assessment-20260911-ZsYlUD/result.json`.
Original run SHA-256: `4a7f140e97a63e42f4ac81865460210ff7db0695896664ad5252eb4e31c3a466`.

### Gemma at 192 output tokens: wrong content persists after completion

The matching four-image Gemma run also completed with the separate 192-token diagnostic
worker and unchanged third Gemma prompt. Its first three response strings are exactly
identical to the 96-token run: the English transfer is correct, while the Arabic transfer
still has a total-label note, year-only date and null ending; the range still lacks its
ending date. Increasing the ceiling did not repair those already-completed answers.

The previously truncated currency-free estimate now finishes, but invents `$`, returns
two transactions for one estimate, and adds an undeclared `iou` key with status text.
These are content/structure failures, not harmless formatting differences. The larger
budget permits completion; it does not qualify either model's prompt for activation.

The original run completed four requests without unexpected native failures, preserved
the cache and baseline sources, retired/terminated every worker, and closed the owned
browser and proxy. No model download, phone run, server update or APK build followed.
Run: `F:/Temp/OpenChat-IOU/output/playwright/gemma-image-v3-192-20260910-S9rUPw/result.json`
(SHA-256 `04b114e83e527cc9d3147fb0be4e411bb05a9df3a7074f463da6d2e95970c4e2`).

The independent replay through the actual host parser and IOU normalization/card/confirmation
functions passes only **1/4** images (English). The report verifies 21,077 explicitly freed
GPU buffers and the unchanged cache/source/console records. Twelve offline assessor tests
pass, including wrong monetary/date/memo values, duplicate keys, incomplete output and
diagnostic-identity negatives; this is separate from the failed model acceptance result.
Report: `F:/Temp/OpenChat-IOU/output/playwright/gemma-v3-192-assessment-20260911-Li6h4H/result.json`.

### Fourth candidates: explicit defaults, date pairs and source boundaries

The next pair retains the same seven app fields and independently transcribed four-image
expectations, using the existing 192-token diagnostic worker. Qwen restores an explicit
default `iou`, with settlement requiring completed movement. Both candidates distinguish
a separately printed ending from a single transaction date, reject null date fields,
and keep captions/memo values separate from neighboring fields. Full captions/memos are
preserved; the first-line stopping rule applies only to standalone headings. Gemma also
explicitly forbids turning status lines into transactions or new JSON keys.

Both include a synthetic CHF/absent-currency contrast, explicitly not image evidence.
This technique already helped one earlier Qwen absence case but failed in another prompt
context. Several rules also overlap earlier rejected candidates. This new combination is
not an isolated causal test or a claimed accuracy fix. The fixed source expectations are
unchanged, and copying an example value into an answer is an accuracy failure.

The reusable runner supports both models with one source-bound prompt input, preserving
the existing images, native options, cache, completion and cleanup safeguards. Its six
offline tests pass; they do not count as model inference. Candidate template hashes:

- Qwen: `0f8364a00efeee67bee72a09a02af8aa5a389c3725574264aa4d99e8fab93ebd`.
- Gemma: `292c776a110c3d99760218dc0b97ef075ffdab528dd7e86aaa6e5583b0ff239b`;
  submitted after IOU policy rendering: `51f05b8c18465fc18c8e656f92704031b7267b438cd0620133157ddcc1f601d1`.

Both four-image runs completed, but each passed only **1/4** actual source/card comparisons:

- Qwen passed the range image, including saved-Type selection, `You owe`, the date and
  full range note. The Arabic result was correct except for a misread memo word; the
  English result was correct except for `kind: iou`; the estimate still invented USD.
- Gemma passed the missing-evidence estimate without invented currency or a duplicated
  transaction. Its Arabic date was fixed but the note still copied the total label. Its
  range answer regressed to settlement/total-label note and omitted the start date; the
  English answer repeated the single date as its ending.

All 45,684 observed buffers were explicitly freed; caches and baseline sources stayed
unchanged and both browsers closed. The reusable assessor's eight offline tests pass.
Field-order reporting now reads each submitted prompt's declared order, rather than
reusing an older Qwen order; this does not change factual/card acceptance. No activation.

Reports:

- `F:/Temp/OpenChat-IOU/output/playwright/submitted-candidate192-assessment-20260911-K8xezB/result.json`
  (Qwen run SHA-256 `4b778fb8cfcde6f839029dd9c9ff21e18d6538ceb2de2d9be93e7726879ffbef`).
- `F:/Temp/OpenChat-IOU/output/playwright/submitted-candidate192-assessment-20260911-hPnZcX/result.json`
  (Gemma run SHA-256 `9bf5ad921f6db995ba0dbf803aa0b8d49115763c4a0956f6dcf2f56d9a9f6cbf`).

### Classification-last comparison

The fifth candidates move only the complete `kind` declaration from first to last.
A byte comparison reconstructs each fifth prompt by that one line move from its fourth
candidate; wording, byte length, field semantics, source oracles and runtime are unchanged.
This tests the effect of declaration/output ordering, not a new payment rule. Templates:
Qwen `6adb1315539bca8d80c0deadb91ac141a0ef91902f73f5c168098357c45b8ef0`;
Gemma `d6a4478c1608de63e234bd4142f99084cd4946565cfe3f4063e587011394ef80`
(rendered `9b70ece1608c0a7bbd2f4be095942e3459f639eaccab2babcd277bd4ae0cad94`).

Both fifth-candidate runs completed. Qwen passed **2/4** factual/card comparisons
(English transfer and currency-free estimate); Gemma passed **1/4** (English transfer).
Both copied the Arabic heading accurately instead of the required memo, and both
misclassified the range image as a completed payment. Gemma invented `$` on the estimate.
The line move changes answers but is not a reliable fix; actual JSON field ordering is
not guaranteed to follow declaration ordering. All 45,408 observed buffers were freed,
source/cache checks passed, and the owned browsers closed. No activation.

- Qwen report: `F:/Temp/OpenChat-IOU/output/playwright/submitted-candidate192-assessment-20260911-NQGaco/result.json`
  (run SHA-256 `99421a75e07748e6a12d819fe0b5e55e2773004de669e3d75ec5d684e67a87a2`).
- Gemma report: `F:/Temp/OpenChat-IOU/output/playwright/submitted-candidate192-assessment-20260911-B1L1kP/result.json`
  (run SHA-256 `0fcae9a0847fd4da86c7d6aaa2dd8aa21d88526893b893409f56e5aeec0561c0`).

### Classification-label comparison

The sixth candidates change only the quoted output labels in each fifth candidate:
`"iou"` becomes `"unpaid"` and `"settlement"` becomes `"paid"`. The evidence rule is
unchanged: `unpaid` here means that completed payment is not established, not proof of
nonpayment. A diagnostic clone of IOU's schema must map these labels back to its existing
canonical values through the existing generic enum-alias interface. No raw answer may
be rewritten before replay, and no production schema or OpenChat logic changes.
The same four source/card expectations, original images and 192-token diagnostic runtime
apply. This is an unqualified enum-vocabulary experiment, not an established cause or fix.

The sixth comparison completed **4/4 images for each model**, without unexpected device
loss. Qwen passed **3/4** source/card comparisons: range, English transfer and missing
evidence. The Arabic transfer has the correct amount/currency/date but an incorrect
`unpaid` classification and the accurate heading instead of the required memo.
Gemma passed **1/4** (English transfer); its Arabic note still uses the heading, its
range classification is `paid`, and its currency-free estimate invents USD. The same
fact failures remain visible after actual host aliasing and IOU card/confirmation replay.
All prompt, runtime and source identities were checked; this does not qualify the phone,
the default 96-token production worker or a production schema change.

| Candidate | Template SHA-256 | Source/card result |
| --- | --- | --- |
| Qwen v6 | `e509d1fb9184a1824062d5b5ff64226aed788a6167d7f7af079a66b235c594d1` | 3/4 |
| Gemma v6 | `1969e08076bcb07335cbf3ff2f7c97b7ec8f9ff2a7bf74794b7454a36f1ca1ee` | 1/4 |

Gemma's rendered prompt SHA-256 is
`12960a2c8bb1db46eadd4a2aada87e1273fd69147938d065fa1b777ed2825220`.
The diagnostic assessor's six offline tests pass independently; constructed positives
are not counted as actual model accuracy. Canonical facts remain unchanged. An old
canonical output label would be a label-instruction failure, not necessarily a wrong
card; these actual failures include wrong canonical classification or source content.

- Qwen report: `F:/Temp/OpenChat-IOU/output/playwright/enum-label192-assessment-20260911-aseTrj/result.json`
  (run SHA-256 `52050d8339073d5e85eee333c0485dfd27e5211dd88b513e26130ffff00ffa79`).
- Gemma report: `F:/Temp/OpenChat-IOU/output/playwright/enum-label192-assessment-20260911-0xTm5A/result.json`
  (run SHA-256 `b82c11c09fcf44064f72f25bc3e8173c1cf229078303aaf2f897ff0aad088055`).
- Assessor: `F:/Temp/OpenChat-IOU/admin/new-model-prompts-20260910/enum-label192-assessment.mts`,
  SHA-256 `988803dddc091f3bf1ed3c84a44f0af766cf89268f7b799d4010a34dcc618048`.

The first Qwen launch ended before inference when its sandboxed browser exited and
the CDP connection was refused. That failed receipt is retained at
`F:/Temp/OpenChat-IOU/output/playwright/candidate-image-192-qwen-DJqRcw/result.json`;
its owned browser and proxy closed. The reported four-image Qwen result is the separate
normal-desktop run, not a relabeled success from that failed launch. No model was
downloaded or copied, and no live server, APK or app registration changed.

### Memo-only reading control

The subsequent local, unpublished full-image/region diagnostic completed four
calls but extracted no correct memos. Existing cropping and a shorter question do not
by themselves fix the Arabic field-selection failure. This does not activate production
cropping or change full-card acceptance requirements.

A follow-up inserting the Arabic label `ملاحظة` explicitly also passed runtime checks
but failed all four exact-memo comparisons. Qwen returned that label for both images;
Gemma retained the total label/full image and note label/region answers. The retained local
diagnostic records both controls separately. Neither result is a qualified model prompt.

A short Arabic question then made Qwen copy the correct memo **within an overbroad region
answer**, together with the reference/date/labels. That is useful reading evidence, not a
correct note. Gemma chose an account identifier or an explanatory sentence instead. This
additional four-call control also fails all exact-memo checks; the report does not trim
the wrong answer into a pass. Runtime/source/cache checks passed, with no activation.

### Compact per-model full-image screen (v7): rejected

After the isolated memo controls, a new pair shortened the full extraction instructions,
removed fictional monetary examples, restored canonical `iou`/`settlement` output labels,
and explicitly included successful transfers in completed-payment evidence. These combined
changes are a new candidate screen, not a single-variable causal experiment. The original
seven-field meanings and independently transcribed expectations were unchanged.

Both models completed the same four original full images using the existing 192-token
diagnostic worker, fresh workers and retained model caches. No OCR, crop, retry, second
pass or download was used. The raw-source comparison rejects both candidates:

| Model | Source-fact matches | Remaining errors |
| --- | --- | --- |
| Qwen | 1/4 (range image) | Arabic note contains account text; English heading includes the neighboring amount; currency-free estimate invents USD. |
| Gemma | 0/4 | Arabic/English notes use headings instead of memos and omit the required empty ending; range note is a total label and both dates are empty; estimate invents `$`. |

All eight amounts and payment classifications are correct in this particular run. Qwen's
date fields are correct; Gemma's transfer calendar dates are correct, but its date-pair
contract is incomplete, and the range dates regressed. These are not GPU failures or card
rendering errors: the wrong or missing values are present in untouched terminal answers.
Valid JSON alone does not pass the factual gate. Formatting, repeated headings and field
ordering remain separate instruction checks.

Six reusable runner tests passed. Independent receipt review rehashed 89 Qwen and 59 Gemma
source/artifact pins, verified unchanged model caches and complete console records, and
confirmed all 41,292 observed buffers were retired. Both browsers/proxies closed, with no
model HTTP request or unexpected native/GPU error. The current host parser reads all eight
untouched replies as single transactions; that does not make their field values correct.
No new app/card replay was claimed after the failed
source comparison; historical assessors' old host pins were not bypassed. This does not
qualify the production 96-token path, captions, multiple entries, phone or APK. The two
repository candidate templates remain unactivated; no live registration or server changed.

- Predeclared screen: `F:/Temp/OpenChat-IOU/admin/new-model-prompts-20260910/v7-screen-plan.json`,
  SHA-256 `d3d738ddcb9e8832c31b1f3c25577236bae840a0377f4ae0fdf18bcfa330862a`.
- Qwen template: `F:/Temp/OpenChat-IOU/admin/new-model-prompts-20260910/qwen-image-v7.prompt.txt`,
  SHA-256 `a920d54777ea1f30e08e979498d9db022bbb3e41a04bfc43833a9af63eec5bdb`.
- Gemma template: `F:/Temp/OpenChat-IOU/admin/new-model-prompts-20260910/gemma-image-v7.prompt.txt`,
  SHA-256 `f590cf8769b8efaeb2f0a943e7d8444aafd52d740aa54faa18efbd45ad65380b`;
  rendered prompt `3b0e579637b4ab13b040d4d4fc5139e4dd108d73cc934d154542221b85e0dbc2`.
- Qwen run: `F:/Temp/OpenChat-IOU/output/playwright/candidate-image-192-qwen-SQ3yxs/result.json`,
  SHA-256 `9d4cb34124a2ab643699f25d9cea4be7fe08d67a7ea9f1a63c32149a83e934cc`.
- Gemma run: `F:/Temp/OpenChat-IOU/output/playwright/candidate-image-192-gemma-IyvP05/result.json`,
  SHA-256 `46525e2ae4becbdb809f48b216d78ba1ec4e6bd0d505d63efdda59d6bb27b267`.

## Matched-input Qwen v7 reference: failure also exists outside WebGPU

One additional Arabic-image request captured the four actual `model.generate` tensors,
formatted prompt and effective generation controls from the 192-token diagnostic worker.
The observation-only worker change forwarded the same model and argument object. Its answer
is byte-identical to Qwen's earlier v7 answer: correct amount/currency/transaction date,
but account text selected as the note. All 6,011 observed buffers were explicitly freed;
cache bodies stayed unchanged, no model HTTP occurred, and the owned browser/proxy closed.
The first sandbox launch exited before connection and ran no inference; the reviewed
owner-context rerun produced the completed capture below. Neither launch changed app data.

The cached original Qwen checkpoint then processed those exact four tensors on CPU FP32
with eager attention, matching all 439 input token IDs and 46 captured generation controls.
Only the verified serializer-version and remote-code metadata differences were reported
separately; remote code remained disabled. The original completed one request with 111 tokens
and an actual EOS. It also selected sender text instead of the memo, put the transaction
time into `printed_end_date`, and misspelled the heading; amount/currency/start date stayed
correct. Its raw answer differs from the converted model's answer, so this is not a claim
of numerical equivalence or identical errors.

This establishes that WebGPU execution and quantization are **not necessary** for this
v7 case's source-selection failure. It does not separate the shared image preprocessing,
resolution, prompt or model limitations, and does not qualify Gemma or any production/phone
path. The reference is an isolated diagnostic, never a production CPU fallback. No new
model download/copy, prompt activation, registration, server update or APK build followed.

Root reran 9 capture tests and 18 reference-admission tests, verified 101 GPU-source/artifact
pins, then streamed all 128 reference bindings through SHA-256 and compared the actual
tensor/prompt hashes independently. An initial whole-file verification attempt exceeded
Node's 2 GiB read limit on the existing checkpoint; the successful streaming check avoids
that allocation. Both inference processes exited successfully, with source hashes unchanged.
Passing these checks establishes diagnostic integrity, not correct extraction.

- GPU: `F:/Temp/OpenChat-IOU/output/playwright/qwen-arabic-v7-input-capture-zlWy9p/result.json`,
  SHA-256 `1e7df87dd0d4733360544a90636e4be6fee997a869e2610aaa16b5fc71fa8d70`.
- Original CPU: `F:/Temp/OpenChat-IOU/output/qwen-original-captured-v7-65ez0vbx/result.json`,
  SHA-256 `19508982afa97bdd3dffec3d18936c70bf9ecd94b9576f786672952094c19c58`.

## Matched Qwen v7 detail comparison: improvement, not qualification

A preprocessing-only browser comparison reused the original Arabic JPEG and v7 prompt.
The baseline's four tensors were byte-identical to the actual GPU capture above before
the higher-detail worker started. Only two diagnostic layout limits changed: maximum
frame edge 512 to 960 and raw-patch cap 640 to 2,048. The unchanged layout algorithm
produced a 544-by-960 frame, 2,040 patches and 789 input tokens instead of 320-by-512,
640 patches and 439 tokens. All 279 non-image tokens and the formatted prompt stayed
identical. This changes detail, patch geometry and alignment resampling together;
it is not a pure legibility experiment.

The same cached original FP32 CPU model then completed one higher-detail request with
92 tokens and EOS, retaining all 46 effective generation controls and the 192-token
diagnostic allowance. It returned 12,900 EGP, `14 Aug 2026`, an empty end-date string,
and the exact visible heading. Compared with the earlier original-model baseline,
the erroneous time-as-end-date and heading misspelling disappeared. The note became
the real heading rather than sender text, but still did not select the labeled memo
requested by v7; it also redundantly repeated the same heading in `image_heading`.
This is improvement, not a full pass against the unchanged candidate expectations.
The active heading-only note policy is distinct from v7's prospective memo precedence.

The result supports image detail/geometry contributing to this example's output, while
showing that increasing detail alone does not resolve the candidate's source-selection
contract. It does not qualify the converted WebGPU model, Gemma, unseen images or phone
memory. The production 640-patch ceiling, 96-token output ceiling, active IOU manifest,
optional audio and app registration were not changed. No model download or cache copy
was needed. The browser attempted no GPU/WASM/model calls, disposed all eight tensors,
terminated both workers and closed its page/browser/proxy; the CPU child exited zero.

Root reran eight preprocessing tests and fourteen CPU-reference admission tests. These
checks establish input/completion integrity, not product accuracy. The paired tensors
occupy 16,485,616 bytes in the existing project temp directory.

- Input pair: `F:/Temp/OpenChat-IOU/output/playwright/qwen-arabic-v7-detail-inputs-Hd8khS/result.json`,
  SHA-256 `f8d76b9bd40ba8594b82a3ce19b5a591730ed47858123762655def8515f1ff26`.
- Higher-detail original CPU: `F:/Temp/OpenChat-IOU/output/qwen-original-higher-detail-v7-prlb_osm/result.json`,
  SHA-256 `c232d578a8a38a87da2f5d4e20b4dab59696559b82123f442e9206b7fe07d4c2`.

## V8: active heading-only policy, eight new WebGPU requests

The next two candidates made exactly two edits to their respective v7 prompts: replace
the note declaration with IOU's current heading-only instruction and remove the separate
`image_heading` declaration. Both edits reverse byte-for-byte to v7. This is a newly
predeclared six-field test, not a rescore of the prospective memo-policy runs. All monetary,
date, classification and missing-evidence expectations remain source-transcribed; no old
response or golden was changed. Gemma still receives IOU's existing visible-symbol mapping.

Both models completed four fresh WebGPU requests at the existing production image sizes
with the same isolated 192-token diagnostic worker. All eight runtime checks passed; the
source/cache checks and browser/worker cleanup passed, without OCR, model downloads,
cache copies, retries, app actions or prompt activation. Runtime success is not accuracy.

| Original image | Qwen v8 source fields | Gemma v8 source fields |
| --- | --- | --- |
| Arabic 12,900 EGP | Pass: full printed date, explicit empty end, correct heading and kind | Correct amount/currency/start/heading/kind, but missing required ending-date key |
| Payout date range | Pass: correct total, currency, heading, kind and both endpoints | Wrong heading and completed-payment classification; no dates |
| English 13,500 EGP | Correct amount/currency/date/kind; memo instead of requested heading | Correct amount/currency/start/heading/kind, but missing required ending-date key |
| No printed currency/date | Invented USD; empty date keys also violate omission instruction | Invented `$` |

Therefore Qwen passes 2/4 source-field cases and Gemma 0/4 under the declared contract.
All Qwen replies are complete fenced objects, accepted as single objects by the actual
current host parser; they fail strict JSON-only formatting separately. Gemma returns
singleton arrays despite the one-object instruction. Neither formatting acceptance nor
correct-looking subsets make these qualified prompts. Qwen's console records 75/66/64/54
decoder completions and its pinned worker enforced EOS; raw token-ID arrays are not
separately persisted, so this is not a raw-token dump or a production-96-token test.

The missing-end rejection is intentional: after generic host conformance removes malformed
optional values, IOU cannot distinguish genuine omission from a rejected ending. The empty
ending string is its explicit single-date sentinel. Preserving a partial start while warning
about an incomplete range would be a separate product-policy change, not proof that the
model obeyed the prompt. No parser guard or historical test was weakened here. The v8
transfer headings are correct under the active policy, unlike the earlier memo-first target.

At the end of the v8 model batch, no full card replay was claimed: retained full-card helpers
still pinned older host source and were not bypassed. The subsequent direct current-source
replay below covers its two passing Qwen responses only. Physical-phone checks, captions,
multiple transactions and untouched holdouts remain required. These four images are a
development screen, not unseen-image evidence.

- Policy plan: `F:/Temp/OpenChat-IOU/admin/new-model-prompts-20260910/v8-active-policy-plan.json`,
  SHA-256 `03be71590e9648080e1f6015ffc55d5e2f891da4c2958631577209cf74954a42`.
- Qwen prompt: `qwen-image-v8.prompt.txt`, SHA-256
  `fc47d7ae2223d5c4d5b1193efc146e54ad83f44cecc7ffa2416052e3332b7625`.
- Gemma template: `gemma-image-v8.prompt.txt`, SHA-256
  `d24612dc7fa4a98754dd2976070327c1885d896303cc4dbcee80f81f75763ef4`;
  rendered SHA-256 `182f3cbef8a9377aac509014a27ae0f212338f1caa00743a36d91e1e8e2211c8`.
- Qwen result: `F:/Temp/OpenChat-IOU/output/playwright/candidate-image-192-qwen-L6lfpm/result.json`,
  SHA-256 `4616491a985657a52904344821ef7bf31e8e256b8c55c46225e3384900daea96`.
- Gemma result: `F:/Temp/OpenChat-IOU/output/playwright/candidate-image-192-gemma-ButTbK/result.json`,
  SHA-256 `8c6ec87686d238580080df9b9674df72ee585ce1d0636c7bb2adf3e52fb8495a`.

The separately built `OpenChat-local-test-prompts-20260911.apk` includes the generic
per-model interface, not these unqualified app prompts. It passed an installed-emulator
cold-start/26-asset/worker smoke, with the welcome screen ready at 5.7 seconds; that smoke
did not run image inference or verify account/model retention. Its production output and
phone image limits remain unchanged. The emulator was stopped without clearing app data.

### Current-source replay of the two passing v8 responses

A new direct offline helper bound the current generic host (`52d824b8...`) and actual IOU
normalizer/card functions. It did not patch or import the stale replay loaders. Both the
Arabic and range responses passed host parsing, IOU normalization, app form initialization
and confirmation-payload checks. The Arabic date remained `2026-08-14`; the range form and
confirmation retained `2026-07-19` and `Reservation | From Sun, Jul 19 to Thu, Aug 6`.
Raw responses were not repaired, and their fenced-JSON instruction failures remain failures.

The first replay attempt failed a diagnostic assertion comparing JSON's ordinary object
prototype to the host's intentionally null-prototype object, despite identical fields.
Only the diagnostic was corrected to compare exact serialized payload bytes. A new regression
test rejects changed, missing, extra and duplicate fields; all nine offline helper tests pass.
The first attempt is not retroactively a pass. The separately rerun replay passed with 104
source bindings unchanged, zero network attempts, zero model calls and zero app submissions.
It does not verify private saved Types/directions, account defaults, iframe rendering,
capability signatures, delivery or physical-phone behavior. Its callback observes the host's
256-token request but returns the retained 192-token diagnostic completions; it does not
qualify either the current 96-token runtime ceiling or fresh inference.

Evidence: `F:/Temp/OpenChat-IOU/output/v8-current-card-replay-oOjFGc/result.json`, SHA-256
`4cac8e994698ae00b4c783f23de455df93653c1a4857bc3d7f94ca09d012bb70`.

## V9: prospective raw monetary evidence and a date array

Two new four-field prompts request `note`, `total_text`, `dates` and `kind`. The total is
copied literally, including its visible unit; one array represents no date, a single date
or both period endpoints. This removes numeric-amount duplication and the empty-end-key
sentinel. Wording and field order also changed, so this is not a single-variable causal test.
The previously tested combined-money prompt retained numeric duplication and split date
keys and had dropped visible currencies; its results did not qualify this new format.

The source facts and date alternatives were frozen before the eight new requests. Literal
money comparison preserves commas, decimals, currency spelling and placement. Whitespace
normalization trims outer whitespace and collapses existing runs to one space; it does not
remove a number/unit gap. Gemma still sees the downstream symbol map with an instruction
not to apply it, which is a remaining prompt-design cue, not independent visual evidence.

| Original image | Qwen v9 | Gemma v9 |
| --- | --- | --- |
| Arabic 12,900 EGP | All four source fields pass | Correct money/heading/kind; clock time incorrectly becomes a second date |
| Payout date range | Money/dates correct; heading includes following status line and kind is wrong | All four source fields pass |
| English 13,500 EGP | Money/dates/kind correct; memo instead of heading | Correct money/heading/kind; clock time incorrectly becomes a second date |
| No printed currency/date | All four source fields pass, no invented currency | Correct money/heading/kind; `Not paid` incorrectly becomes a date |

Both copied all four monetary totals and visible/absent currencies correctly in this screen.
Qwen's dates pass 4/4, headings 2/4 and kinds 3/4, giving 2/4 complete source passes. Gemma's
headings and kinds pass 4/4 but dates 1/4, giving 1/4 complete source passes. No date array
was filtered, concatenated or repaired to turn these failures into passes. All four Qwen
answers are fenced; Gemma returns four singleton arrays, with the sole source-correct range
answer fenced. Neither candidate has a response passing both its full source and requested
format contract across this screen.

The actual current host parser agrees with all eight complete objects/singleton arrays;
no partial JSON or wrapper recovery was needed. All eight WebGPU runtime/cleanup checks
passed, with 39,324 observed buffers explicitly retired. Retained model caches and sources
were unchanged; no download, OCR, crop, retry, second pass or app action occurred. This is
still the isolated 192-token worker, not a production-96 or phone qualification.

This prospective format is **not compatible merely by replacing the registered prompt**:
the current IOU response schema requires numeric `amount` at the host's generic readiness
check before IOU normalization. Any future
adapter must be app-owned and explicitly distinguish transport requirements from the
existing canonical text/OCR schema. The host carries nested arrays but does not enforce
array item/max-length schemas; IOU must validate an entire 0–2-item date array without
dropping malformed entries. Existing strict money, currency and date policies must not be
weakened. No schema, normalizer, registered prompt, production setting or APK changed here.

- Frozen policy: `F:/Temp/OpenChat-IOU/admin/new-model-prompts-20260910/v9-raw-evidence-plan.json`,
  SHA-256 `73b177428d1d86a679908548ca1e86ff52d7fafe1ecf99da55936e5c0f7d7766`.
- Qwen result: `F:/Temp/OpenChat-IOU/output/playwright/candidate-image-192-qwen-VndQkU/result.json`,
  SHA-256 `352573746610b3c986cda21a29716d34d4bcac8ea09ce90142b2866315f18093`.
- Gemma result: `F:/Temp/OpenChat-IOU/output/playwright/candidate-image-192-gemma-uLSoev/result.json`,
  SHA-256 `1013917af7fa52325be5acf561ccb95d3da374e5205c4a71cff75928727ddbb6`.

## V10: isolated output-key changes

The next pair changed exactly one declaration key per template, with byte-for-byte reversal
to v9: Qwen `note` → `heading`; Gemma `dates` → `calendar_dates`. Instructions, field order,
values, images, preprocessing, weights and the diagnostic 192-token worker were otherwise
unchanged. The model-specific oracles rename that key only; old results are not rescored.

| Model | Complete source passes | Outcome of the one-key intervention |
| --- | --- | --- |
| Qwen | 4/4 | Both heading errors and the range-kind error disappeared; all money/date values stayed correct |
| Gemma | 1/4 | Both clock-as-second-date failures remain; missing-date output changed to `No visible date`, still not the required empty array |

All sixteen Qwen field values match the predeclared facts. This supports the exact `heading`
intervention on the four exposed cases, not a universal prompt or unseen-image guarantee.
Its four responses remain fenced, a separate JSON-only instruction failure. Gemma's money,
headings and kinds still pass 4/4, but its date-key rename did not fix date extraction. Its
four responses are singleton arrays and the only source-correct range response is fenced.

The actual current duplicate-rejecting parser agrees with all eight complete replies. All
eight runtime/cleanup checks passed; 39,191 observed buffers were explicitly retired, with
unchanged retained caches and complete error-free native consoles. No OCR, download, retry,
app action or production change was made. Qwen's full source pass justifies further testing,
not activation: the actual production 96-token worker, broader sources, safe app-owned raw
evidence integration, card behavior and physical phone remain separate qualification gates.
The existing canonical amount validation must not be relaxed merely to accept this format;
older-client behavior needs an explicit compatibility decision before transport changes.

- Frozen policy: `F:/Temp/OpenChat-IOU/admin/new-model-prompts-20260910/v10-key-name-plan.json`,
  SHA-256 `380828f09719156f609feeeadff86ad74ee437590d17f4242a8323c71c85b07c`.
- Qwen result: `F:/Temp/OpenChat-IOU/output/playwright/candidate-image-192-qwen-aCmuEl/result.json`,
  SHA-256 `9b5efd63629440ad032ba39b293a739d0d56500806c1949c78cab3c1804abf6f`.
- Gemma result: `F:/Temp/OpenChat-IOU/output/playwright/candidate-image-192-gemma-UmGzZc/result.json`,
  SHA-256 `9efa4fb91dbc5c13e7d4c46da82600b9f298fa94d7de838d9be5fcfe5e5a176e`.

### Qwen v10 on the actual production 96-token worker

The same four images were then run with the unchanged production worker `dd107de1...`
(962,323 bytes), byte-identical to the worker in the September 11 local-test APK. This did
not relabel the 192-token artifact: the test used the original current build receipt and
96-token request/worker limits, with the same prompt and production image settings. All
four requests completed successfully and the four raw answers are byte-identical to the
192-token v10 answers. Source accuracy remains 4/4; the separate fenced-JSON failures remain.

Runtime/source/cache checks and owned browser/worker cleanup passed, without model downloads,
OCR, retries or app actions. Four offline adapter tests also passed. This qualifies completion
and source accuracy on these four desktop cases at the actual output ceiling—not broad image
accuracy, a phone run, the new raw-evidence card integration or release readiness. No APK rebuild
or registered prompt/schema change accompanied the test.

Evidence: `F:/Temp/OpenChat-IOU/output/playwright/qwen-image-v10-production96-Ch1AjX/result.json`,
SHA-256 `71d6f89abcfdc37a841f32b1d4d8e995236a792f40442c931b00285609a7f67d`.

## Gemma v11: one atomic date string

The next Gemma-only candidate replaces its numbered date-array declaration with `date_text`:
one complete single date/timestamp, two complete period endpoints joined by ` | `, or an empty
string for no visible calendar date. All other template bytes stay unchanged. The new string
alternatives are mechanically derived from the same frozen source facts, not from prior model
errors. This changes the requested representation and wording, not only a field name.

All four 192-token WebGPU requests completed. Range, English transfer and missing-evidence
cases pass all four source fields: 3/4 overall. Arabic retains correct money, heading and kind
but emits `14 Aug 2026 | `, which fails because the ending endpoint is empty. It is not trimmed
or split into a passing single date. Every monetary value/unit remains correct. Three replies
are JSON-only singleton arrays; the range reply is fenced. No registered schema/prompt or
production settings changed, and this representation is not yet an integrated card contract.

- Frozen policy: `F:/Temp/OpenChat-IOU/admin/new-model-prompts-20260910/v11-gemma-date-text-plan.json`,
  SHA-256 `66cef24cdf9730ba25b56810cb8646df27378186a2cae1e3888487aaa3429144`.
- Result: `F:/Temp/OpenChat-IOU/output/playwright/candidate-image-192-gemma-7oaG4f/result.json`,
  SHA-256 `389f65925b78daabf5e0963774623ca80828aef87cbbac5ff309670803c236b3`.

## Gemma v12: explicit single-date termination

One sentence was inserted into v11's date declaration: `For a single date, do not append a
separator.` All other template bytes, source expectations and 192-token diagnostic settings
were unchanged. All four cases now pass the complete predeclared source checks: Arabic
`14 Aug 2026`, range `Sun, Jul 19 | Thu, Aug 6`, English `13 Aug 2026`, and empty missing date.
Every monetary total, heading and kind also passes. No trailing separator was trimmed or
otherwise repaired. All four replies are JSON-only singleton arrays and agree with the actual
duplicate-rejecting host parser.

Runtime, source/cache identity, complete native console and owned browser/worker cleanup
checks pass, with no downloads, OCR, retries or app actions. This is diagnostic desktop
accuracy, not production-budget, card, phone or release qualification.

- Frozen policy: `F:/Temp/OpenChat-IOU/admin/new-model-prompts-20260910/v12-gemma-single-date-plan.json`,
  SHA-256 `6f344a7a8cc1b4f280752d2eb3a0798bd250c6551d8e793ea937c4ef1f878806`.
- Result: `F:/Temp/OpenChat-IOU/output/playwright/candidate-image-192-gemma-zd5qD4/result.json`,
  SHA-256 `9e7a32c1fd867b682c4158058f8024a08ee22d616dd7434cb6b1952d0295b818`.

### Gemma v12 on the actual production 96-token worker

The unchanged production worker `dd107de1...` then completed all four requests at the
96-token request/worker ceiling. All four raw answers are byte-identical to v12's diagnostic
192-token answers. The pinned offline assessor reports runtime/source 4/4 and JSON-only 4/4.
Source/cache identities, complete error-free native console, buffer retirement and owned
browser/worker cleanup passed. Five adapter tests independently verify the unchanged runtime
functions and production worker. No downloaded model, OCR, retry, registration or APK change
was involved. This qualifies these four desktop cases at the shipped budget, not cards or phone.

Evidence: `F:/Temp/OpenChat-IOU/output/playwright/gemma-image-v12-production96-Lcak7g/result.json`,
SHA-256 `74cd4ca5a79c0ab92cc0c2a14789af026170ca7831a12e28c7085133fae04e8f`.

### Automated raw-evidence acceptance checks

The independently tested offline assessor checks whole parsed replies against the frozen
source facts and pinned runtime receipts. It rejects malformed/duplicate/extra fields,
truncation, wrong money, standalone clocks, fabricated dates and empty range endpoints; it
does not repair values. All eight assessor tests pass. Its actual CLI exits successfully for
Qwen v10 production96, Gemma v12 diagnostic192 and Gemma v12 production96: runtime and source checks 4/4 each.
Formatting remains separately reported (Qwen JSON-only 0/4; Gemma 4/4). These are source
checks, not a replay through the new, not-yet-implemented raw-evidence card integration.

Assessor: `F:/Temp/OpenChat-IOU/admin/new-model-prompts-20260910/raw-evidence-assessment.mts`,
SHA-256 `9be709a869aa80a865c2cbdddfa2f89cc8212c06a364579fb66baffba8134f3f`.

## Preparing model input

Qwen's file is a complete prompt. For Gemma, IOU must replace the single
`{{currency_symbol_policy}}` placeholder with
`JSON.stringify(imageCurrencySymbolPolicy())` from
[currencyEvidencePolicy.ts](../../src/features/openchat/currencyEvidencePolicy.ts).
Never send the unresolved placeholder or substitute a private account's default currency.
Qwen copies the raw visible currency token. The original canonical candidates use IOU's
existing currency normalization after extraction; the new raw formats still need the app-owned
adapter described above. That adapter must preserve the approved visible-symbol mapping
without asking the model to infer a missing currency.

Send the original image and any attached caption as source input through the model's
existing native chat template. Do not substitute source text into prompt instructions.
Do not add OCR, a second inference, model switching or an automatic retry. Text/audio
prompts and optional audio support are unchanged by these image-only artifacts.

## Original candidates: one field contract, two instruction styles

- Exact monetary digits and decimals; missing evidence is omitted, not invented.
- `kind` means completed movement versus an obligation, not a private user-defined Type.
- Both printed-date strings are included for a visible date. A single date has an empty
  ending; a range retains both endpoints. IOU owns date normalization and appending the
  full range to the note. The model must not construct its own From-to sentence.
- Note precedence is transaction-associated caption, then labeled memo value, then heading.
  Preserve source words and language; do not output the memo label or compose a description.
- `image_heading` is optional, separate source evidence only when different from the note.
  IOU owns private saved-Type matching and direction defaults. No private roster, IDs or
  user-defined type names belong in either prompt or in OpenChat's implementation.
- Multiple transactions keep row-local evidence. Repeated displays of one total must not
  create duplicate transactions; separate transactions with equal amounts stay separate.

This is the original candidates' prospective note policy, not the latest raw format or a user-confirmed change to the active
heading-only policy. Copying a real heading instead of the requested memo is a candidate
selection-policy failure, not automatically invented content. The historical expectations
remain unchanged. Existing source fields already support this prospective contract; these
files do not change the manifest, parser, app registration or runtime selection.

## Verification and activation status

The companion template tests check field compatibility, required instructions, omission
rules, symbol-policy substitution and absence of image-specific literals. They do not
execute a model or prove factual accuracy.

Before activation, each candidate needs fresh image inference against source-transcribed
amounts, currencies, dates, notes and missing evidence, plus captions, repeated requests
and multiple transactions. Test existing regression images and untouched holdouts; keep
formatting failures separate from wrong values. Then verify the actual app-authored card,
private saved-Type/direction behavior and phone path. Completion must include the native
end token; never return partial JSON or discard fields to squeeze under a token limit.

No output-budget change is bundled here. The existing 96-token limit may be insufficient
for long captions or multiple transactions, and even compact instructions cannot guarantee
compact model output. Token feasibility and actual completion remain acceptance checks.

OpenChat's PR2 source now implements generic selection through the additive sibling
`x-openchat-image-prompt-by-model`, keyed by the already supplied pinned model ID. Its shape
is `{version:1,templates:{"opaque-model-id":{template,includeRuleGuidance}}}`. It accepts
1–8 entries, up to 4,096 UTF-8 bytes per template and 16,384 bytes for the serialized map.
It retains the exact existing v1 template for older clients, unknown IDs and malformed maps.
Text, OCR/private verification and generation settings remain unchanged. Host-interface
tests pass; that is not evidence that these IOU prompts produce correct answers.

IOU has not registered or activated the rejected candidates in that map. Once qualified,
IOU must render its own currency policy and register its own templates; OpenChat must not
know IOU's fields or prompt contents. Do not insert new keys inside the exact-shape v1
extension: older parsers would reject it. The September 11 local-test APK includes this host
interface, as recorded above; that does not activate these prompts. Server deployment is not
established by this document, and historical tests retain their earlier source identities.

A historical read-only size check of the then-current IOU schema plus the two original
seven-field repository candidates was 12,297 Unicode scalar characters / 12,315 UTF-8 bytes
(that schema alone: 7,943 / 7,952). This does not measure the new raw templates or their future capability.
That fits the existing 16,384-character registration envelope; no backend limit needs to be
raised for this pair. This in-memory check neither registered those failed candidates nor
qualifies their outputs. Recheck the complete schema when qualified templates are finalized.
