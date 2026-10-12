# Image-prompt investigation — 9–11 September 2026

## Status

**Not qualified for deployment.** The strongest shared candidate passed the two original images on both models, including repeats, but failed broader evidence checks. IOU-only optional heading evidence support is now prepared in source and its generated registration reference, but has not been registered or deployed. Subsequent generic completion and duplicate-field guards are prepared in OpenChat source as described below. No APK, production image prompt or interface schema changed. No per-model prompt selection was added.

### Separate model prompts: first screen rejected

At the user's request, separate IOU-owned Qwen and Gemma candidates were created in
[model-prompts](model-prompts/README.md). The first four-image screen used the same
assembled worker, original images and 96-token cap. Qwen stopped on the first image at
the completion limit. Gemma completed three images but failed all three source/card
comparisons, then hit the limit on the fourth. Neither candidate was activated.

A fresh, single-request capture of this **new Qwen prompt** found correct heading,
12900 and EGP, followed by a note copying sender/payee/account details and truncating
inside that string. This differs from the historical duplicate-note prefix below.
The new diagnostic passed its capture/cleanup gate while the original inference still
failed; partial text was not returned as a card. The redundant post-cleanup debugger
command was removed only after a regression test reproduced the detach race. No model,
generation or app logic changed. See the linked guide for exact receipts and hashes.

A formatting-only follow-up quoted field names and split the date declarations. Qwen
again hit the limit on its first image. Gemma corrected the English date but retained
all three wrong notes and the missing range dates, then hit the limit on the fourth
image. The actual IOU card/confirmation replay rejected all three completed answers;
the range answer also failed saved-Type/direction matching. Both new prompts remain
unqualified. The unchanged all-WebGPU runtime had no unexpected device loss in these
runs; completion/content failures were not treated as passing model tests.

Shorter, payment-purpose-focused third candidates improved one completed Gemma card:
the English transfer now has the correct memo and date. Arabic memo/date and the range
ending still failed; Qwen's first image and Gemma's fourth still reached 96 tokens.

A separate 192-token diagnostic then completed all four Qwen images with the same
third prompt. All amounts and visible start dates were correct, but all four cards
still failed: wrong notes, repeated single-date endings, unpaid items classified as
settlements, or invented currency on absent evidence. Completion and extraction are
therefore separate failures in this batch. This worker changes only the two output
ceilings and Qwen decoder-call ceiling, preserves context/EOS guards, and is not a
production build. No prompt, server or APK was activated. Details and source-bound
results are in the [model prompt test record](model-prompts/README.md).

Gemma's matching 192-token diagnostic also completed all four images, passing only the
English card. Its first three raw answers are unchanged from the 96-token run; the
formerly truncated estimate now finishes with invented currency, duplicate transactions
and an undeclared key. The separate source-bound card replay rejects these failures.
Both larger-budget runs closed cleanly with caches preserved; neither is phone or
production qualification.

Fourth candidates completed all eight model/image combinations, but passed only one
source/card comparison per model. Moving only the classification declaration to the end
in fifth candidates improved Qwen to 2/4 and left Gemma at 1/4. Both now copy the Arabic
heading accurately instead of the required memo, and both misclassify the range image
as completed payment. Gemma still invents currency on the currency-free estimate.
These are extraction failures, not GPU crashes; all runs closed cleanly with their
caches preserved. Exact candidates and reports are in the linked model prompt record.
No production prompt, model settings, server or APK was updated by these comparisons.

A sixth controlled comparison changed only the requested classification labels to
`paid`/`unpaid`, using one additional alias in a diagnostic IOU-owned schema clone.
Raw model replies were replayed unchanged through the real generic host and app/card
code. Qwen improved to 3/4, but now misclassifies the Arabic transfer; Gemma remains
1/4, with incorrect range classification and invented currency on absent evidence.
Both finish all four images. Label vocabulary affects results, but this does not
establish it as the sole cause or provide a reliable fix. All candidates remain
unactivated; source-level, factual/card and physical-phone acceptance are distinct gates.

The following [memo-only full-image versus focused-region diagnostic](model-prompts/memo-region-diagnostic.md)
completed all four calls, but neither model copied the memo in either input. Qwen chose
account/party details or the reference number; Gemma chose the total label or note label.
The existing crop and simpler question are therefore insufficient for this case. This
is not a pure-resolution experiment and does not assess cropped payment classification.
No production prompt, schema, runtime or app path was changed.

### Earlier isolated token capture: duplicate notes consume the Qwen budget

The user-approved outside-sandbox diagnostic made **one** Arabic 12,900 EGP request
with the unchanged worker, baseline seven-field prompt and 96-token limit. A temporary
debugger breakpoint read copied CPU token IDs immediately after generation and before
the original completion guard. It did not change generation options, resume generation,
return partial text to the app, or produce a card.

The captured 96-token prefix contains the correct `amount: 12900`, `currency: EGP` and
`printed_date: 14 Aug 2026 09:47 PM`, but writes `note` **twice**: first `12,900 EGP`,
then `البطاقة الإرجالية المدفوع`. Neither is the printed memo `نفقات المعيشة`.
It opens a JSON fence and does not close that fence or emit either configured end token
before the limit. This directly explains this run's completion-limit failure; it does
not establish the underlying numerical cause of prompt sensitivity. More output tokens
alone would not correct the already-generated wrong, duplicate notes.

Inference took 12.98 seconds including debugger observation. The actual worker returned
the original token-limit error, acknowledged disposal, and explicitly destroyed all
7,248 observed buffers across two hardware devices. No unexpected device loss or native
error was observed. All 14 cached model bodies were identical before/after; no model
download, OCR, crop, retry, app action or APK change occurred. The owned browser and
deny-all proxy closed. The eight small receipt/log files total 352,716 bytes; the
existing model profile was reused, not copied.

**The diagnostic itself did not pass.** Its final cleanup attempted a debugger command
while the already-resumed worker was detaching, triggering `Owned debugger worker detached
during a command`. The capture's verified script hash, token hashes and prefix remain
recorded, but both `diagnosticCapturePassed` and `runtimePassed` are false. All four
debugger cleanup acknowledgements are true; the failure has not been suppressed or the
receipt rewritten. Nine offline diagnostic tests passed before this run but did not
cover this real detach timing. This result is diagnostic evidence, not shared-prompt,
card, physical-phone or release qualification.

Evidence under `F:/Temp/OpenChat-IOU/output/playwright/qwen-token-limit-capture-20260910-pZbbrb`:

- `result.json`, SHA-256 `1805cd40c5492d6dd53123d467ddf351b67dec6eea51558dd5e97833f6590945`.
- `token-diagnostic.json`, SHA-256 `29e9a959a3ff2001764613129c357982b70a43038623e74db5992b12220c0572`.
- Complete console: 536 records / 174,136 bytes, SHA-256
  `a4af2e06e5d1ce3d106c652155a28ee4a6a3e5fd3a85c7e9a9c2a59cfccb8d82`.
- Unchanged worker: `dd107de1bc3fc1c91e7ac16165681f51941f8b9503991c443c1cd749394154ed`.

### Earlier unchanged-worker comparison: note order is not a shared fix

The fixed comparison used the same two app-owned prompt texts on both models and four
original, already-used images. The only difference between these prompts was moving the
existing `note` instruction after `image_heading`; no instruction, image, generation setting,
model weight or production source was otherwise changed. Each case used a fresh worker and
the existing 96-token output limit. This tests a diagnostic seven-field contract, not the
current six-field production prompt or a newly qualified holdout set.

The sandboxed Qwen launch ended before browser attachment, with zero image/model requests.
The user-approved outside-sandbox rerun completed four requests, then the Arabic baseline
returned the actual production output-token-limit error. The remaining three Qwen cases
were not attempted. This was **not a GPU crash**: the error path returned no partial text,
acknowledged disposal, and explicitly freed all buffers. Gemma completed all eight fixed
requests (13.3–17.1 seconds each). No request was retried after a model failure.

| Model / prompt | Completed and assessed / planned | Source-and-card passes | Strict prompt passes |
|---|---:|---:|---:|
| Qwen / note first | 2/4 | 1 | 0 |
| Qwen / note last | 2/4 | 0 | 0 |
| Gemma / note first | 4/4 | 1 | 0 |
| Gemma / note last | 4/4 | 1 | 0 |

The incomplete Qwen screen cannot qualify either common prompt. The completed negative
answers also independently reject note-last as a fix:

- Qwen omitted the visible reservation currency under both prompts. Moving note last selected
  the subheading instead of the required heading, both on the estimate and reservation.
- Gemma selected labels instead of the Arabic memo under both prompts. Both returned the
  correct 12,900 EGP and 14 Aug 2026 date, but that does not make the wrong note correct.
- Gemma's reservation baseline retained the right calendar endpoints but omitted their
  printed weekdays. Note-last changed **Jul 19 to Jun 19**, and selected the wrong note.
- Both Gemma prompts passed the English transfer's source/card values. Missing evidence
  remained empty in both models' completed estimate outputs, but wrong note selection still
  failed three of those four cases.

All Qwen completions were fenced objects; Gemma returned singleton arrays. The existing host
can parse those formats. They are counted separately from content errors, never described as
wrong monetary/date values merely because strict serialization failed. Actual host parsing,
IOU normalization, card/confirmation construction and private saved-type hydration were
replayed without editing the recorded answers or saving an entry. The frozen acceptance
adapter's 12 tests and the two runners' 5 + 12 tests pass. These tests correctly detect failed
model answers; they are not model-accuracy passes. The final assessment CLI exits **1**.

Across the thirteen actual attempts, all **72,874 observed buffers** on 26 hardware devices
were explicitly destroyed, including the failed Qwen request. Neither complete console
contained native/GPU errors. The unchanged worker remains SHA-256
`dd107de1bc3fc1c91e7ac16165681f51941f8b9503991c443c1cd749394154ed`.
Before/after body verification covered all 14 Qwen artifacts and 13 required Gemma artifacts;
the entire Gemma key inventory (16 entries) was preserved, including unneeded-for-this-test
extras. No model download, cache copy/delete, OCR, crop, audio inference or app action occurred.
Both owned browsers and deny-all proxies closed; the retained profiles remain reusable.
Logical GPU buffer cleanup is not a measurement of physical phone RAM or VRAM release.

Offline actual-tokenizer checks show that both key orders have identical output counts.
The exact full-timestamp Arabic answer needs 62 Qwen tokens compact or 88 fenced/pretty,
including EOS, so those expected serializations fit 96. That comparison did not expose
the rejected output prefix; the later isolated capture above supplies separate generated
evidence, without changing the historical result or claiming that a larger budget fixes accuracy.
Gemma's corresponding fenced/pretty serialization needs 101 tokens; compact needs 66.
These are feasibility counts, not generated-output evidence or a new output-budget policy.

Evidence under `F:/Temp/OpenChat-IOU`:

- Qwen `output/playwright/qwen-common-note-order-screen-20260910-yRcC1K/result.json`, SHA-256
  `a9d98f71e28f55926c844636207c6695d824b88d7591f110ce026eeacfd538c1`.
- Gemma `output/playwright/gemma-shared-note-order-20260910-4kxJsa/result.json`, SHA-256
  `939376c551ff770bd595341b7794e3d5e389ca77bd9fa71a68541328a2df37e8`.
- Assessment `output/playwright/shared-note-order-assessment-20260910-HGSPmK/result.json`,
  SHA-256 `47e2f91e8d746920bd4dc4bc8358378c8f84cc405f3137074262369fd633f2b3`.
- Prompt identities: baseline `c6f6e06ac495ab0a5df6bbe95c344829443e417480fb1d0cc0964ba69b12d8e7`;
  note-last `91c02ff19c90269d671128796fb26408d1b6b39ef5f0a969307576e24efc2fa5`.

This comparison isolates a field-order intervention, but was neither randomized nor repeated;
it does not identify a universal numerical cause. No common replacement prompt, production
server, registration or APK was deployed. Physical-phone and release acceptance remain open.

### Earlier accuracy record and historical request count

A paired currency-line comparison retained the strongest six-field
prompt's symbol mapping and omission policy. Both baseline and example variant still invented
currency for the currency-free image and scored 2/4 against the unchanged source/card oracle.
The variant was rejected; no shared-prompt replacement was qualified. At that checkpoint,
diagnostics totalled **206 desktop WebGPU requests (61 Gemma, 145 Qwen), in 27 completed
batches plus one aborted memo-only batch**, including the deliberate one-token negative case
below, plus eleven CPU reference
requests. These counts measure work performed, not accepted
extractions. The detailed phase records below retain their original counts and expectations.

[Candidate text](model-image-prompt-candidate.txt) is a diagnostic artifact, not an enabled prompt. Its exact UTF-8/LF SHA-256 is `384c3fae9474a0a6bb996e63b7f106194fa954d53c6e4f4b2289f81bf3c1f2f6` (1,989 bytes). In source, the symbol map must continue to come from IOU's existing currency policy, not a second hardcoded mapping.

## What was tested

### Complete delivered vision encoder — strict initialization failed, configuration-order cause isolated

The next admin-only comparison composes the exact production DeepStack graph patch before
replacing the 24 attention chains. It preserves all four dynamic FP32 outputs, all 550
original initializers, all 524 external weight bindings and the learned DeepStack branches.
The captured current processor inputs remain at 640/640/616 patches; neither images nor
prompts are recaptured or resized. This is an encoder diagnostic, not a full-model prompt test.
Root independently passed 25 graph-preservation tests, four input/asset-admission tests and
eight final runner tests (37 total). The original pre-run runner had seven tests; the eighth
now covers late native console errors after browser closure.

The intended comparison was six fresh worker/device sessions, cold and warm per session,
with all elements of all four outputs checked at the predeclared
`1e-5 + 1e-4 * abs(baseline)` tolerance. **Neither batch reached inference.** Both stopped at
the first unchanged Arabic-image baseline during strict session creation. The grouped graph
was not run, so there is no complete-encoder equivalence, memory or image-accuracy result.
These are two failed initialization attempts, not additional full-model or encoder calls.

Actual NVIDIA Ampere hardware was observed. Native ORT refused session creation because
`session.disable_cpu_ep_fallback=1` prohibited its CPU assignments. Logs identify 64 unique
registry-missing nodes (reported twice) and 25 additional CPU-preferred nodes. This includes
position-coordinate/interpolation and attention-mask calculations, not only dimension
bookkeeping. The 89 names are capability/optimization diagnostics, not a complete final
placement inventory. Device destruction followed initialization rejection and was caught by
the diagnostic; this is not evidence that the historical phone crashes share that cause.

The first run logged native `enable int64: 0`. The pinned WASM contains the exact option
`ep.webgpuexecutionprovider.enableInt64` (byte offset 14,786,349), also documented in the
[upstream provider options](https://raw.githubusercontent.com/microsoft/onnxruntime/main/onnxruntime/core/providers/webgpu/webgpu_provider_options.h).
A separate diagnostic revision requested `1` through the existing generic `extra` mechanism,
without relaxing the CPU prohibition. **The option did not take effect:** native provider
creation still logged `0`, while the later session-settings trace contained the requested `1`.
The installed `lib/wasm/session-options.ts` creates execution providers at line 260, before
applying `extra` at lines 290–293. These logs and code isolate an initialization-order problem
in that configuration route; they do not test whether enabled integer kernels cover the graph.
The next bounded step is to forward the option before provider creation, still in isolation
and still requiring native confirmation and strict CPU rejection. No native library or
production runtime was patched in these two runs.

Both complete weight bodies verified in the browser: 217,952,256-byte base shard and
302,161,920-byte FP32 DeepStack shard. The latter used the unchanged production streaming
transform of the retained BF16 source, consumed through EOF with source/output hashes checked.
No models were downloaded. Each console retained all 400 records with no overflow; both
results bind unchanged inputs/runtime/assets. Feeds were verified on load, not rehashed after
native execution. No execution occurred here. A review found that the first runner's per-case
native-log snapshot could miss late teardown errors; the future runner now also assesses the
complete log after browser closure. The failed original receipt and runner remain unchanged.

Records under the project-temp root:

- Graph helper `admin/qwen-vision-delivered-head-groups-20260910.mjs`, SHA-256
  `f1335119f2d910dcc702409d9c4b4d68c20249da539760e8570580039b86457f`;
  candidate graph SHA-256 `fa82bccef6da52fc60805eb092146e095309aaa4391c2bc51fa3e732afbda905`.
- Input admission helper SHA-256
  `30916bbc72f5817e4b406abc178124a41894d7b5a61264348a06962e984ac193`.
- First result `output/playwright/qwen-full-vision-20260910-AgfUEd/result.json`, SHA-256
  `19db0063650f016d84c3f1d8cb52085d653a6d9728f357060e5227e00ae5094c`;
  plan `53c81beb9395c7b21edccb5296198f119add60b1973fcb1b56e216e68ce38d03`.
- Configuration retry `output/playwright/qwen-full-vision-20260910-zil2Xo/result.json`, SHA-256
  `6ce60a84613555c287c1af22490e1571fab870a60462d2c61c287c96f737dd98`;
  plan `826fd5ec819c7e42e4f6c2a9e0f95452f62808cb571af422860b4c2822cea80d`.
- Retry runner SHA-256 `098cd864346f4a3dd6c4412a9fd0f1b4475f6744bf364f996259f91c5a044852`;
  worker `1c8c7ad3ed2b19bc9d27ede2bce9bc8c60c3ca17e9f4487fd6722fbd3681b07d`.

Both processes exited 1, terminated the worker and closed browser/server. Exact-path cleanup
removed only their two regenerable browser profiles: 386 files, 20,588,681 logical bytes and
20,885,504 observed free bytes reclaimed, not sent to the Recycle Bin. Receipts, console logs,
archived diagnostic sources, model caches and original images remain. No app prompt, active
registration, production graph/image budget, server or APK changed. Release acceptance remains
incomplete; the smaller successful attention test must not be relabeled a full encoder pass.

The configuration-order hypothesis was then tested in a **third initialization attempt**.
A single reversible, source-pinned edit in the served JavaScript bridge forwards only the
already-requested integer option before native provider creation. The installed library and
native WASM are untouched; normal later configuration handling and strict CPU rejection remain.
Nine runner tests now pass, including exact restoration, requested/unrequested call ordering
and full modified-module syntax checks (38 graph/input/runner tests total).

Native logs now confirm **`enable int64: 1`**. Registry-missing nodes decrease from 64 to 46
(128 to 92 messages), and CPU-preferred messages decrease from 25 to one. Thus the ordering
fix has an observed effect, but **strict baseline initialization still fails**. Remaining
unsupported operations include integer indexing/arithmetic/reductions and two FP32 positional
clamps. They cannot be waived as metadata. Again there are zero inference attempts, outputs,
comparisons, exposed GPU allocations or dispatches; grouped-encoder equivalence is untested.

Third result `output/playwright/qwen-full-vision-20260910-o8zKOQ/result.json`, SHA-256
`78d5664b0ab60c6718ba848f63a536dc5a6e0554197625e97b1d67f67a914e05`;
plan `0ce083da09d2a35f0817aadf536d841ccb3435155c7b9f6764dd6eeb4c03d133`.
Original bridge `c34690829e61762557628ef5459dcda79d6ecedbb01a644d382f5f57ab7522c8`
becomes diagnostic-only `e354ad9515487907fb75416a0c264759405be7d81bec33b1c0bd0b4f105e6aeb`;
runner `5503e3aac28f1a359285b43e3b0ca2ec7a60ffc1dfab9bdc5df990b5b7b44917`;
tests `6ead64a9bf122f9b0637b9da50a387749181e68374ec1396ecddf88e576f0647`.
An independent review reconstructed the unique bridge edit and rehashed the 73
source/input/reference bindings. All 343 console records are retained, and final native-error
gates correctly reject the run. Device destruction again follows failed initialization.

The third process exited 1 and its worker/device/browser/server closed. Only its regenerable
profile was removed: 193 files, 10,299,984 logical bytes, 10,448,896 observed free bytes
reclaimed; no Recycle Bin copy. Combined three-profile cleanup reclaims 30,888,665 logical
bytes. All receipts and model downloads remain. There are still 206 full-model requests,
16 separate synthetic attention calls and **zero complete-encoder inference calls**.

### Grid-only specialization — independent geometry oracle passed

The next diagnostic implements a constrained geometry compiler, not unrestricted constant
folding. Exactly 91 original nodes depend only on the single-image grid and pixel dimensions;
they never read pixel values or external learned weights. Their 13 cut outputs become constants
for the exact admitted grid. All remaining node/initializer bytes and four output contracts
are preserved, including learned positional gathers/weighting, pixel embedding, frequency and
trigonometry, attention/MLP and DeepStack. Same-patch-count transposed grids cannot share an
admission. Runtime optimization must remain disabled and strict CPU rejection enabled.

After **41/41 root-run offline tests**, the user-approved isolated native diagnostic ran
outside the command sandbox and exited 0 in about 4.7 seconds. A separately constructed
original-ONNX slice used native CPU ORT 1.24.3 with optimization disabled, not the compiler's
graph. It includes the exact 91 original nodes and 16 original inline constants, with zero
external weights. All **55 currently admitted grids** passed: **715/715 complete boundary
tensor comparisons were elementwise exact and byte-identical**, including FP32 values at
zero tolerance. All 55 sequential sessions released; zero remained active and sources were
unchanged. This test-only CPU reference does not introduce a production CPU model fallback.

Records under the project-temp root:

- Compiler `admin/qwen-vision-geometry-20260910.mjs`, SHA-256
  `423f8e9b120c4f538d5e0537f853f35f0a08a84177419219302eb6efdf62453f`.
- Independent reference helper `admin/qwen-vision-geometry-reference-20260910.mjs`, SHA-256
  `b30e9fd7f046ed13382a59ef4cae559a32196ebc1c84457b5644f282475d4300`.
- Original-node oracle graph SHA-256
  `9bf6a1b6311458154eaf5a11d6ebe95bd7f449036958737d4c3ee677e16a7755`.
- Plan SHA-256 `9ec5895ea008a7445d186b394a5fa3e6a8d515b2ac25fe20b17f86c3aa29e270`.
- Result `output/qwen-vision-geometry-reference-20260910-gswhG9/result.json`, SHA-256
  `0e1696d26a286a768cf6f12989a260ac4f8c471f1ae67f116a4c89abd17a5b12`.

Only 26 reference tensors for the two captured grid shapes were retained: 3,246,896 bytes.
Other grids were compared in memory. No model download or browser profile was created.
These are **55 geometry-only CPU calls**, separate from full-model generation and the still
zero complete-encoder inference calls. No production code, server or APK changed. The next
GPU diagnostic must bind this successful reference and freshly compiled constants before
execution; complete-encoder placement, numerical equivalence, memory and image accuracy
remain unqualified. A shared compiler on both sides of a GPU comparison is not itself an
independent full-encoder correctness oracle.

### Specialized complete encoder — two GPU calls completed; node-count gate stopped the batch

The reference admission now binds the exact successful native receipt, compiler and oracle
sources, all 55 full-grid boundary sets and 26 retained files. Each graph's actual inserted
constants must match its verified set. Root passes 21 additional focused admission/input/runner
tests, bringing the current graph/compiler/reference/admission/input/runner total to **62**.
Runtime gates require native integer support, disabled optimization, strict CPU rejection,
no ConstantFolding and exact per-case/final ordered node counts, including late teardown logs.

The next default-sandbox desktop run completed **two real vision calls** on the Arabic input
(640 patches): cold approximately 1,256 ms, warm 189 ms, including output readback. Each call
submitted 49 batches and 710 direct GPU dispatches. All four `[160,2048]` FP32 outputs were
captured on both calls; an independent full-file check found all four pairs byte-identical,
finite and hash-correct. Inputs were rehashed after both calls and unchanged. Both complete
weight bodies and the companion conversion's EOF guard verified. This is not decoder/model
generation or an independent unspecialized full-encoder reference comparison.

**The batch remains failed.** Native logs report all **1,146** nodes on WebGPU, whereas the
serialized specialized baseline contains **1,098**. The exact-count gate stopped before the
grouped graph or other images. Native integer support is `1`, optimization `0`, CPU fallback
prohibited, and no native E/F, CPU assignments or ConstantFolding appeared. Mandatory runtime
graph transformations are being investigated; an unexplained count increase is not waived.
The failed receipt has zero harness comparisons because that gate precedes comparison, even
though the retained cold/warm output files were independently compared afterward.

Records under the project-temp root:

- Admission helper `admin/qwen-vision-geometry-admission-20260910.mjs`, SHA-256
  `ff5bb009ffbbb97a6b4a6aca91a32a0efa2f1df38311c8fd199eaafaac93dd33`.
- Result `output/playwright/qwen-full-vision-20260910-7Inqqe/result.json`, SHA-256
  `13a5927b85b8a9040cc3e74e48f487701f1250bb85c3647208df093c13900ff8`.
- Plan SHA-256 `629f5e3ca0ff0334b511f8475fca7259cacac43d729c41465797672785780dba`.
- Runner SHA-256 `4f71aae2bdf20610cd7f6251f4e108dfbee9a6123468d0f4a4bf4fb3e02c1b05`;
  worker `ff6cdf5b541993cdc108d9b1ea7d1184cc7139e79e34f8ad6a331450b54c7a6b`.

Independent review verified all 74 deduplicated source/input/reference bindings and the complete
3,464-record console (1,028,069 bytes). The exposed logical GPUBuffer peak was 687,400,144
bytes, not physical VRAM or a head-grouped saving. All 1,133 created buffers were explicitly
destroyed, with zero balance at session release before device retirement; queue, feeds,
worker, browser and server closed. Native `Device was destroyed` occurred only during planned
retirement, not an inference crash. The process exited 1 for the count gate. Its 195-file
disposable profile was removed (15,725,510 logical bytes, not recoverable from Recycle Bin);
eight output files, receipts, source archives and downloaded models remain. No production
runtime, prompt, server or APK changed. Totals are now 206 full-model requests, 16 synthetic
attention calls, 55 geometry-only CPU calls and **two complete-encoder GPU calls**. Shared-prompt,
grouped-encoder and physical-phone acceptance remain incomplete.

### Original-layout full encoder comparison — passed; limited memory benefit

The only subsequent runtime option change was explicit
`executionProviders: [{ name: "webgpu", preferredLayout: "NCHW" }]`. Installed source and the
pinned bridge support this option before provider creation. Current upstream
[partitioning code](https://raw.githubusercontent.com/microsoft/onnxruntime/main/onnxruntime/core/framework/graph_partitioner.cc)
corroborates that NHWC invokes an additional layout transformation; it is not the source identity
of the installed WASM. Input shapes/bytes, graph bytes, weights, image limits, integer setting,
disabled optimization, strict CPU rejection and exact expected node counts were unchanged.
The diagnostic additionally requires native layout0 confirmation. Root reran all 11 focused
runner tests; the current graph/input/reference/admission/runner total remains 62.

The complete desktop comparison **passed all 12 calls**: baseline and grouped encoders, cold
and warm, on all three retained images. Native counts are exactly
`1098,1770,1098,1770,1098,1770`, with six layout0, integer1, optimization0 and strictCPU1
confirmations. No CPU assignments, native E/F, ConstantFolding or GPU errors occurred. All
48 full-tensor comparisons have zero error. An independent review rehashed every output
(62,128,128 bytes; 15,532,032 finite FP32 values) and repeated every comparison. All eight
Arabic baseline outputs also match the earlier layout1 run byte-for-byte. The intervention
isolates the earlier count increase to the provider layout path without identifying each
individual added node; the failed earlier receipt and unchanged exact-count gate remain.

The measured peak reduction is **29,358,896 logical GPUBuffer bytes (28.00 MiB, about 4.25%)**:
691,594,336 to 662,235,440 on Arabic/English; 691,324,560 to 661,965,664 on the missing-evidence
image. This is not physical VRAM. Warm grouped runs were slower (Arabic190.6 to233.1ms).
517,264,592 bytes already exist after session creation, and allocation buckets prevent linear
per-patch extrapolation. This does not establish higher-resolution phone headroom or cover
the embedding/decoder stages.

Records under the project-temp root:

- Passing result `output/playwright/qwen-full-vision-20260910-RFUDPt/result.json`, SHA-256
  `e9d68265138acbcfd426df30156d52a903aaaf42c1b251b80c80b54fa50df15c`.
- Plan `588a2d877b45d45d08f40dd05cdfc24bab56139763b2246e114f887158c168b9`.
- Runner `10fa091b935d53085a16b2eee0b9eef6ddc171521fc92b5bf119f62cc83ca1f1`;
  worker `18b251434851164096b6a26981a55add5495b225f24d4e49ad7e0c371c23b535`;
  tests `e7e2a596d8d55fe8891dd27afbe6c941cbc78761e3cbc5108746669834d68956`.
- Complete console:24,519 records/7,514,953 bytes, SHA-256
  `b25666e53ee8925215b04ff10504acb196defe1a4a261df8b6540063f7af3dbf`.

All 74 source/input/reference bindings, 12 full weight transfers and both post-call input
hashes per session verified. All 6,837 buffers were explicitly destroyed, with zero allocation
balance before planned device retirement in all six cases. Workers/browser/server closed and
the process exited0. Only its 201-file disposable profile was removed:27,625,553 logical bytes,
27,787,264 observed free bytes reclaimed, no Recycle Bin copy. Outputs, evidence, source
archives and model downloads remain. Totals are now **14 complete-encoder GPU calls**, separate
from 206 full-model requests,16 synthetic attention calls and55 geometry-only CPU calls.

Keep grouping diagnostic-only until an actual full-model image test demonstrates useful
accuracy improvement. The smallest taller full-image frames are Arabic320x544/P680 and
English352x544/P748, requiring an edge-limit change as well as a patch-cap change. They are
geometric candidates, not established repair thresholds. The prior successful high-resolution
English CPU reference used4000 patches/1000 image tokens and1444 input tokens, already beyond
the production1024-position decoder; it also did not solve invented currency. A bounded
640-versus748 English full-model comparison with unchanged app-owned prompt/decoding is the
next useful hypothesis test, not a phone-limit increase or permission to deploy. Shared-prompt
accuracy, complete model and phone acceptance remain unmet. Server/APK are unchanged.

The additional `[1,34,22]` /748 geometry case subsequently passed its independently built
original-ONNX reference outside the command sandbox, under the user's explicit isolated-test
approval. All13 boundary outputs (2,292,008 bytes;567,766 elements) matched elementwise and
byte-for-byte at zero tolerance. The one native session was released, all15 tensors disposed,
and all38 source/runtime bindings rechecked unchanged. This runs only grid/shape calculations,
not learned model operations, and does not establish full-model accuracy or phone stability.
The two-grid diagnostic compiler leaves the qualified640 graphs byte-identical; no production
budget, prompt, model download, server or APK changed.

Retained result: `output/qwen-vision-geometry-reference-748-20260910-iHjktL/result.json`,
SHA-256 `e5efd93714ed48bfccf5ba0ff45b570b0f2577eeb209747195f37a060fdfd3f1`.
Reviewed plan: `eb956d6463169ea5db57c5382d21dc002997e232657cba7e71288a8bc9c363d1`.
The next comparison still needs the actual full worker to preprocess once before creating
its grid-specific vision session, retaining the original1024-position context guard and
96-token greedy generation. Counts are now56 geometry-only CPU calls; model-call totals
above are unchanged.

### Full-worker two-resolution diagnostic — decoder admission failure

The following default-sandbox run attempted the actual full worker with the same app-owned
prompt, one prepared input per request, strict CPU fallback rejection, and fresh workers for
the planned640/748 comparison. The640 control reproduced all four captured production input
hashes exactly, including604 input tokens and grid `[1,32,20]`. All14 genuine cached model
artifacts (1,836,700,049 bytes) passed complete-body SHA/EOF checks; no external download ran.

Only the640 request started. Native placement confirmed all1770 vision nodes and the one
embedding node on WebGPU; the2464-node decoder then failed initialization because some nodes
required the CPU execution provider, which this diagnostic explicitly forbids. **No answer
was generated, and748 was not attempted.** This adds one failed full-model attempt, not a
completed generation or an image-resolution accuracy result. The frozen failure remains a
failure, even though the underlying devices were correctly retired.

The complete log identifies486 unsupported decoder nodes:200 Gather,171 Concat,57 Reshape,
56 Mul and2 Shape. Independent graph inspection classifies485 as INT64 shape/index work;
their713-node backward dependency closure has12 inline constants,200 boundary outputs and
no learned-value dependencies. The exception is the UINT8 tied-embedding reshape, which
reinterprets quantized weights from `[151936,64,16]` to `[151936,1024]`. It needs a separately
verified, byte-identical external-initializer alias, not permission to execute learned model
operations on CPU. Dynamic sequence/cache lengths change during generation; prefill shapes
must not be frozen into subsequent decode steps. These are diagnostic findings, not a shipped
repair, and do not establish that graph execution explains the separate reading errors.

Two evidence-harness issues were also identified. Session traces requested INT64 support and
NCHW, but the global ORT logger filtered the provider's effective-configuration messages;
those effective settings therefore remain unproven in this receipt. Repeated native-error
callbacks rejected the disposal wait after failure, recording `retired:false` despite an
observed `terminal:disposed` event. The original telemetry independently proves1151 buffers
created and explicitly destroyed, zero outstanding before device retirement, both devices
explicitly destroyed, and worker/browser/server closure. Fixing logging/acknowledgment
accounting must not turn the genuine decoder failure into a pass.

Retained result: `output/playwright/qwen-budget-full-model-20260910-BibIMW/result.json`,
SHA-256 `3e62e745014ad0a3eca761e17f2390f3a5de8be3cf71beca62db76ae642cdf47`.
Plan: `e6e3e13888445b484631d9892849f65c367d1f0f2865931830fdf945161d7c04`.
Complete console:2352 records/979312 bytes, SHA-256
`6492d159680c421f5b5bce5a3dd93d3fe9e10da6d5f5a08e14308c738c754964`.
All135 source bindings rechecked unchanged. The exact runner, worker transforms, builder and
their tests were archived before further edits. Only the closed disposable212-file browser
profile was removed:1,852,383,585 logical bytes,1,852,592,128 observed free bytes reclaimed,
without a Recycle Bin copy; original evidence and model downloads remain. See the separate
`cleanup-after-run.json`; the historical result was not rewritten. No production graph,
prompt, server or APK changed. Common-prompt and phone acceptance remain incomplete.

The two diagnostic evidence fixes now pass24 offline checks, including a regression that
executes both the archived original and revised disposal handlers: the former loses the ACK,
the latter records it, and both preserve the initial inference error and every later native
failure. The revised worker invokes the pinned Transformers backend's supported
`env.backends.onnx.setLogLevel(10)` before runtime initialization. A test executes that exact
setter/mapping and verifies the actual native environment becomes verbose; assigning the
spread backend object's `logLevel` property would not. The virtual strict worker typecheck
introduces no diagnostics relative to the unchanged production source. No new worker was
built or model run for these fixes; effective native configuration still needs a new trace.

Revised runner SHA-256 `cbb7ba1108e888bf9d62a65b137a9eea5f96887748d89df742f54b5547ef5fbd`;
worker-transform helper `8b6c3f4f89588a1d42a20834f898c0b9d28ec6f69d5034a6c68fe7f37201f6d2`;
builder `873f0c61fcff3c59fe1aaa857e4a3310361e4d31d99e27c113650990056d8438`.
Old build receipts are intentionally rejected by the revised source admission, not rewritten.

Do not implement a713-node control compiler yet. The native log also records58 explicit
CPU-preference assignments, independent of missing INT64 registrations. A smaller unproved
candidate is INT32 arithmetic inside one shape-control island, with schema-required INT64
boundary casts. A bounded GQA `Shape/Gather/Sub/Concat/Pad/Slice` probe should first test the
same strict native JSPI backend with global verbose logs and changing query/past lengths
`(604,0)`, `(1,604)`, `(631,0)`, `(1,1023)`, comparing all control and dummy-data outputs with
the original INT64 oracle. Stop at its first failure. Installed JSEP TypeScript handlers do
not establish native C++ kernel support, and passing this island would not qualify mRoPE or
the complete decoder. Preserve real position/mask values, learned tensors, cache agreement,
causal row/column ranges and the1024-position guard. No such probe has run yet.

Separately, the admin-only UINT8 alias helper passes4 offline tests. It removes only decoder
node0 and adds a `[151936,1024]` initializer referring to the identical external file,
offset903290880 and length155582464. The affine row-major mapping proves every byte's index
is unchanged; all2463 retained node protobufs,759 original initializers, model metadata,
inputs/outputs and existing omitted optional outputs remain unchanged. Negative checks reject
changed ranges, packing, consumers, names and output contracts. No learned weight bytes are
read/copied and no graph file is written. This does not qualify native execution: a runtime
could materialize a second buffer for the same external range, increasing memory usage, and
the INT64 failures remain. Do not deploy this proof as a memory fix.

Helper `admin/qwen-decoder-uint8-alias-20260910.mjs`, SHA-256
`277c57ba27d9a087d9ada5802dd5b2166a2eda27577b84466a2321458a3a880f`;
tests `dcad009daa90a175e3da9b038bc183c3e92a8275213a159abe219d063a1daa7c`.
Read-only plan `2501d33371742a1cdcff9a8c3869fb727aeaa15d305452087ada1344631d2ec9`;
in-memory derived graph5,086,565 bytes/2463nodes/760initializers, SHA-256
`8ad4dcc05de0f9ee141a55b1f54ab3c5e1c70bdb079db2b1efbd40adf75c1a2d`.

### Small INT32 decoder-control probe — CPU preference remains

The bounded native follow-up ran in the default command sandbox. It used13 unchanged
layer0 GQA nodes from the delivered decoder and a16-node candidate with INT32 control
arithmetic, two Shape-to-INT32 casts and one INT64 Pad boundary cast. Only four original FP32
sink outputs were exposed; controls stayed internal to avoid extra-output placement effects.
The original inline causal table and actual-rank synthetic cut inputs were retained. This
probe contains no learned weights, prompt, image processing or learned model inference.

All20 offline builder/oracle/harness checks passed before execution. The actual original
INT64 ONNX CPU session then passed all four `(query,past)` cases `(604,0)`, `(1,604)`,
`(631,0)`, `(1,1023)`. All16 persisted outputs match the independent formula oracle and
recorded hashes byte-for-byte, including signed zero:6,144,688 bytes/1,536,172 FP32 elements.
The original CPU session was released. These are four additional synthetic control-reference
calls, not additional complete-model or vision-encoder calls.

The strict WebGPU candidate failed during session creation, before any inference. There
were **zero missing-kernel messages**, but the native runtime explicitly preferred CPU for
10 small metadata operations:3 Cast,2 Gather,2 Sub and3 Concat. CPU fallback stayed disabled,
so the session correctly rejected them. The global native logs now confirm effective
INT64 support1, layout0/NCHW, graph optimization0 and CPU fallback prohibition1. This rules
out a simple INT32 conversion as a sufficient fix for this island; it is not a GPU memory
crash, and the cut's synthetic producers do not prove whole-decoder placement behavior.

No GPU buffers, dispatches, submissions or pipelines were created. A real non-fallback NVIDIA
adapter was observed; the runtime destroyed the failed-create device and the finalizer also
performed idempotent teardown. Queue/device/worker/browser/server cleanup completed. Complete
console capture contains49 records/18,229 bytes, SHA-256
`508fcdd8729ab03ef0b46191c2011532ea8e518cb81ebff8e5f45c613fb4a9ea`.
The full manifest reproduces unchanged:22 distinct explicitly bound source files, controller
inventories65+111 files and native JavaScript inventories12+85 files. No per-tensor disposal
telemetry was recorded for the CPU reference; do not present source-loop counts as measured.

Result: `output/playwright/qwen-decoder-control-20260910-QJK8v0/result.json`, SHA-256
`076864ea6c31923c278e35d938aaa1aba0cb8c7a5532b8b9cf04f4050421a019`.
Plan: `6d2e6c4d547d5e8e8ccc1014fcb2aacc847ad52f7c9871691cf2b7914561773b`.
Runner: `a9bbfb589803e30b90ac6e94a4c0b6d4ea25d1e511a68bae78b04ffe3d4f5c6f`;
worker: `3239b571161c46ca9ef9fad5c1d6dd99980a6d61703f06fc11dce69896505235`;
island builder: `d3e03dc357159ea2882a72977892a93648c9d4a08d16c47cc53837d3779bdbdb`;
independent oracle: `76cf03495666d90c4d868dfd15f9fd7697f9fc85fa64bac7fd81c3dd7cae449e`.
Eight exact source archives, all16 output binaries and the original failed result remain.
Only the closed165-file disposable browser profile was removed:8,867,990 logical bytes and
8,982,528 observed free bytes reclaimed, without a Recycle Bin copy. The separate cleanup
receipt records this; model downloads were untouched. Server/APK and production are unchanged.

Do not broaden the failed dtype conversion. The next smaller hypothesis is explicit host-side
dimension metadata: remove the nine control nodes from this13-node island, retain original
nodes99/100/106/114 byte-identical, and supply four bounded INT64 inputs (`causal_starts`,
`causal_ends`, `pads`, `total`) derived from validated dimensions and past length. This is
host control preparation, not an ONNX CPU fallback or learned CPU math. The same four FP32
outputs must still exactly match the original oracle, and all four retained nodes must be
natively placed on WebGPU with the same strict settings. No learned-tensor data readback or
case-ID lookup may stand in for dimension derivation. Even a pass would qualify only this
boundary; actual decoder present/cache dimension derivation and the713-node closure need
separate proof before full-model, shared-prompt and phone acceptance. The subsequent probe
result follows; it does not reclassify the failed dtype-conversion run.

### Explicit host metadata — four-node native WebGPU pass

The bounded host-control probe passed on September 10, outside the command sandbox as
explicitly approved. Its six-input graph retains original nodes99/100/106/114 and five
constants byte-identical; nine shape-control nodes are replaced by four INT64 metadata
inputs totaling104 bytes per call. Host JavaScript derives these only from validated
dimensions and past length. There is no learned tensor readback, OCR, image-specific input
lookup, model download or production modification. Six helper, eight worker and two runner
offline tests passed before execution, including invalid dimensions and mutated controls.

The original13-node native CPU reference and candidate4-node native WebGPU graph each ran
the same four cases: prefill604, decode after604, prefill631, and decode at total1024. All16
outputs per backend match the independent formula oracle byte-for-byte:6,144,688 bytes
(1,536,172 FP32 elements) per backend. The GPU worker records all24 input pre/post hashes.
Native logs confirm exactly4 nodes on WebGPU, INT64 enabled, original NCHW layout,
optimization disabled and CPU fallback disabled, with no CPU assignment or native error.
Each GPU call made6 queue submissions/3 compute dispatches on the non-fallback NVIDIA Ampere
adapter. The unchanged Unsqueeze is a metadata operation, so four nodes need not produce
four compute dispatches.

All37 created GPU buffers were explicitly destroyed, with zero logical outstanding bytes
before device destruction. Peak exposed buffer allocation was10,006,112 bytes, not measured
physical VRAM. CPU/GPU sessions, worker, browser and loopback server closed; the complete
314-record console has67,956 bytes. The result's post-run source plan is unchanged.

- Result: `output/playwright/qwen-decoder-host-20260910-1TcdBz/result.json`, SHA-256
  `bb28bde4aa979e1b4d0f0071795c22fea628ac8d04756e8044ddb3daece3b9e8`.
- Plan: `0ab5780c1d0360ee78b9bfb752dc86306d4c88e8e315395f5c0750e2e9157562`.
- Runner: `5ebc9a83e806b8d22b49b001436a79930d0f4c2689fd4b5e3c89fc08c9d16f94`;
  worker: `36adae1677de8bbd33c8dd65a8c9f188e7446ac1c0860066124e3871dcc5cc0b`.
- Host helper: `dfa2266c5247ea6a939748d0b48c6ab0f88b45116d3bad3dda9f94e005439cf7`;
  candidate graph: `3fe2cecc3f09268236fc523403c08d4df381a3b2e6aeb54712745d2fe0e6b753`.
- Complete console: `ad95adb23f0ef7da820e078a635ff20181159dcb49f81649c508e5560200b504`.

Eight exact source archives and all32 output binaries are retained. Only its closed166-file
disposable profile was removed:15,197,907 logical bytes and15,314,944 observed free bytes
reclaimed, without a Recycle Bin copy. The separate cleanup receipt preserves the original
result unchanged. Independent read-only verification reproduced the source plan and compared
all32 persisted tensors against fresh oracle bytes, all24 input hash pairs and the complete
native console/37-buffer lifecycle. This is a new graph hypothesis, not evidence that sandbox permissions
caused the previous CPU-preference failure.

This pass qualifies only this small synthetic boundary. The complete decoder still needs
dynamic controls derived from actual embedding/token/cache/mask/position dimensions, plus
verification of the remaining shape operations and tied-weight alias. Shared-prompt accuracy
across both models and varied images, repeated phone execution and release acceptance remain
unmet. No server or APK was updated by this probe.

### Full decoder metadata boundary — original native reference pass

The next diagnostic removes713 shape-control nodes plus five proven dead nodes, while
preserving learned operations and their constants. Its198 live boundaries share eight
INT64 inputs;254 declared input-slot rewires are reversible. The original63 decoder inputs
remain in order. A separate browser-safe helper derives `S=E+I` from actual raw embedding
and private token-ID dimensions and `T=P+S` from all56 matching cache dimensions. It checks
mask `[1,T]` and position `[3,1,S]` dimensions without reading their values. In particular,
rotary cache-selection indices are `range(0,S)`, not `range(0,T)` or past-offset positions.
Original image-aware position values still feed the original rotary calculations.

The independent native CPU reference retains the original713 node bytes and12 inline
constants. All115 synthetic input tensors are read only by Shape nodes, using two shared
zero buffers totaling at most5,184,296 bytes. Five configurations—prefill604, decode604,
prefill631, decode1023, and mixed current lengths4+3 with past11—passed all990 comparisons
against the host helper, including exact INT64 ranks, values and581,152 output bytes.
Independent verification reproduced every saved output, input-backing hash and source plan.
One session was created and released, with313 successful tensor disposals per case
(1,565 total). Native calls settle before elapsed-time acceptance and cleanup; this harness
does not pretend that Promise.race cancels native execution.

- Result: `output/qwen-decoder-metadata-reference-20260910-JSixTB/result.json`, SHA-256
  `85e0b7d73ef861690e18ff6e72ad2664ff45389d9bea38852e1ab82382755f86`.
- Plan: `4bf58354418ad9ce4261d243a2e6822011b98c87fd8f7b2dd82c472cf7c03324`.
- Original metadata oracle: `a047962c8f9b8b29a813f7e2ebf7fee231aa319c446208826514fdd26bbd02bb`.
- Host helper: `f4c94327c45b72bbf530f7895dc3680d19ff2aa7f55f3b16df91d374546691ed`.
- Metadata graph helper: `cced27025d8bbca7b50851baa2e4133c4e9196ed00e95ea38ccc4b0e68127565`.

This proves the dimension formulas on the five configurations, not full-decoder output
equivalence or image accuracy. The full-model diagnostic adapter checks prefill-to-token
cache continuity, validates all56 returned cache dimensions, hashes/disposes only its eight
new controls, and rejects graph-load retries or concurrent calls. The separate tied-weight
alias is being composed for native GPU validation; possible duplicate GPU allocation remains
an explicit limitation. Production, prompts, servers and APK are unchanged at this gate.

The composed full-model diagnostic worker was then built with the unchanged production
build options and33 observed source modules. The candidate decoder has1,745 nodes,
760 initializers and71 inputs; its4,896,044 bytes hash to
`c962dfae3958b772652204069ad8ae646f2e41a72a31ef5416a7394ed94f5c20`.
The eight private input descriptors are added to the raw-session checks, while the public
facade remains unchanged. Original worker generation and ORT transforms are inherited
unchanged from the prior budget diagnostic. Thirty-two focused offline tests passed across
the new graph, feeds, reference, adapter, composition and builder. A successful build is
not runtime acceptance.

- Build receipt: `tmp/qwen-full-host-diagnostic-worker-20260910-akXSov/build-summary.json`,
  SHA-256 `eed999eb37fc42bf99f9c0cd9acc96ffc1acaf2a21d8538833ee35e92c514299`.
- Build plan: `74e46a1feb9b796396335f3900c2c32aaa42c25d87953d96c9818fa55fd3e106`.
- Worker:925,958 bytes, SHA-256
  `50878fd5cd14d9aa57c9e3814b0f80a2ea5b15cea97409556341f876c04bccb6`.
- Source map:2,185,721 bytes, SHA-256
  `715cc26efec6d0614a8ba03b65fbfcfcff7416497668ed411822bcbe2fcb78dd`.

The separate test runner must still require native placement of all1,745 decoder nodes,
successful image generation through cached-token calls, original processor/prompt hashes,
exact reference fields, and explicit buffer retirement. None of these is implied by the
metadata reference or mocked hook tests alone.

### Full-host decoder runtime — native placement passed, diagnostic capture failed

The first full-model run of the composed worker attempted only English640. All14 original
model artifacts (1,836,700,049 bytes) were cached with complete-body hash checks. The
prepared image/prompt/tensor hashes matched the original640 reference. Native logs report
all nodes on WebGPU for vision1770, embedding1 and decoder1745, with effective INT64,
NCHW, optimization-disabled and CPU-fallback-disabled settings. The graph-replacement
event matches the composed decoder hash above. Fifty-eight decoder calls passed the
dimension/cache checks, including464 fresh control tensors and the final P660/T661 step.

Nevertheless this is an unsuccessful, inconclusive full-model test. The console handler
mistook the runtime's multiline VERBOSE shader-source dump for ordinary console errors:
the first misclassified record is the GatherBlockQuantized shader Start banner, not a
native E/F error. It subsequently hit the16MiB capture limit. The retained prefix contains
44,643 records/16,776,998 bytes,5,814 misclassified shader-source records and one overflow.
No native E/F, CPU-fallback or GPU-failure event appears in that prefix, but an incomplete
capture cannot prove their absence through completion. No raw answer was retained, and
the748 case was not attempted. Do not reinterpret native placement or successful decoder
calls as an image-accuracy pass.

Actual disposal acknowledgement was received. Both devices retired all5,497 exposed
GPU buffers explicitly before device destruction, with zero logical outstanding bytes;
the worker terminated and browser/server closed. This is not a physical-VRAM claim.
Independent review reproduced the frozen source plan, native placement, all control
hashes/cache transitions and cleanup evidence. The original failed receipt is immutable.

- Result: `output/playwright/qwen-full-host-model-20260910-S2sJ00/result.json`, SHA-256
  `8e7d649f3bd58e4be87d315476223adc9eb3f512d9c3a3f3927f146f707cb51a`.
- Runner: `admin/test-qwen-full-host-model-20260910.mjs`, SHA-256
  `e4632aa2d6d558fa863b5db3e7b1da5ebce515754aa49de58a4173fc82e89899`.
- Plan: `8c5aad907d1f12784cd0c9d4bdcd85b6f027f43fe60687532b79a1245f8c5bc8`.
- Incomplete console prefix: SHA-256
  `00d601778d6c372e1910276f872ea25698be5562421af06863726c3e2c73c38b`.

After process exit1 and confirmed browser/server closure, exact-path cleanup removed only
the213-file private browser profile:1,854,925,035 logical bytes and1,855,135,744 observed
free bytes reclaimed. Eight frozen source archives and separate cleanup receipt remain
beside the original evidence. The regenerable profile was not sent to the Recycle Bin;
retained models, original images and account profiles were preserved. No production code,
prompt, server, APK or registration changed. The next diagnostic must fix log framing
without ignoring real native/browser/GPU errors; all accuracy/release gates remain unmet.

### Corrected full-model logging — both GPU runs passed, larger image did not improve fields

A separate diagnostic runner fixes only console interpretation and observation. Native
multiline shader dumps require the exact observed Build header, matching delimiters and
unmodified bytes matching one actual `GPUDevice.createShaderModule` input. Native E/F and
CPU-fallback errors are checked before framing; missing witnesses, interleaved errors,
unclosed blocks and late errors remain failures. Complete logging is bounded at 256 MiB,
included in disk admission. Nineteen focused offline checks passed independently, including
actual hook forwarding/return identity, errors, bounds and failed-prefix replay. The worker,
model, graph, prompt and generation settings did not change from the preceding failed run.

Both English640 and English748 completed with one request per fresh worker. Each placed all
1,770 vision, 1 embedding and 1,745 retained decoder nodes on WebGPU, with strict CPU fallback
rejection, INT64 enabled, NCHW and optimization disabled. Dimension-only host metadata is
still ordinary JavaScript preprocessing, not learned CPU inference. The complete console
has 183,583 records / 70,493,114 bytes and no native/GPU errors. Independent streaming review
reconstructed all 140 shader blocks and matched 428,474 source bytes to actual API witnesses.
The 58 / 64 decoder calls validated 464 / 512 control tensors and all returned-cache metadata.
All 5,497 / 5,773 exposed GPU buffers were explicitly destroyed before their devices, with
actual disposal acknowledgements and closed workers/browser/server. Source pins and all
14 complete cached model bodies verified unchanged.

Accuracy did not improve. The 640 response is byte-identical to the input-qualified historical
baseline: settlement, 13,500 EGP, `13 Aug 2026`, empty end date and `Living Expenses`. The 748
response changes only indentation and has identical parsed fields. Both still use the visible
memo instead of the diagnostic prompt's requested heading, omit the printed time and use JSON
fences. The memo is visible source text, not an invented phrase. There is no basis to adopt
the higher image budget or claim this runtime change fixes prompt sensitivity.

The unmodified actual host parser and IOU normalization/card/confirmation code were replayed
against both real completions, without model calls, accounts or network. Both yield 13500,
EGP and card date `2026-08-13`; only the note differs from the frozen card oracle. The host
accepts the fences. Calendar-only dates pass this card contract but not the separate strict
full-timestamp diagnostic. The original expectations were not relaxed or overwritten.

Device lifetimes are sequential, so per-case maximum exposed GPUBuffer peaks are
3,778,552,016 bytes (640) and 3,794,961,104 bytes (748), not the sum of both device peaks.
Largest buffers are 367,077,376 and 383,486,464 bytes respectively. These are logical
allocations under diagnostic optimization-disabled settings, not physical VRAM or phone
qualification. The large decoder allocation needs investigation before mobile adoption.

- Result: `output/playwright/qwen-full-host-logging-model-20260910-iNS7D6/result.json`,
  SHA-256 `e108f1c6e72ab2e9931af97131fc9006d3ddfdc7e9d79e4a8dfd04afa2892bb3`.
- Runner SHA-256 `5957336ee0e2044f69580ed919f362a65e0229f510b655be549d7134d3a2dc5d`;
  tests `734694c6a7768131c85a5b61f71d110335ec121a6e4e11f9d6b2e5a278a06710`.
- Plan `c3409e9faef22e1078c23958a0b15e49b93c62502aa3c7d1ed57e4cdd31cc01e`;
  complete console `71e02393976bc5bc71612384402577a899e9b964c6b74158c1bfc3091b13a024`.
- Real-output app replay: `app-card-assessment.json` beside the result, SHA-256
  `70b0d43e3aeb69c857eb4fffaee5b3a93c4098d93c606d080c74a4d2048cfae8`.
- 640 raw `f8eb388191fa7745af5116258f23ea0dbb9685c518067b10d0b17f7852918e9a`;
  748 raw `d8ae8ee6862040818bb8ef09de92380e5fe2cb5fbf0d8544fa58fbd7ed76aaec`.
- Closest input-qualified baseline: `qwen-production-full-model-20260909-luIgxH/result.json`,
  SHA-256 `791a3ced803511fff38d3e27aa2969c323daecb77870bfeb45f526c93cd96357`.
  Its second request has exact matching four input-tensor hashes and formatted prompt, but
  uses read-only fingerprint instrumentation and older default runtime settings. The later
  unchanged-production `qJ2sfh` English baseline corroborates the same raw text without tensor
  fingerprints. Neither is a perfectly controlled fresh-worker baseline.

Exact-path cleanup after exit0 removed only the 216-file private browser profile:
1,858,798,230 logical bytes and 1,859,010,560 observed free bytes reclaimed. Two frozen
runner/test archives, results, console, app replay and separate cleanup receipt remain.
The regenerable cache was not sent to the Recycle Bin; original images, retained model
downloads and account profiles were preserved. No production source, app prompt, server,
APK, registration or branch publication changed. Shared-prompt variety, Gemma and physical
phone acceptance remain incomplete; successful desktop runtime is not release readiness.

The subsequent read-only graph/consumer review identifies a bounded decoder-memory target.
The final `MatMulNBits` LM head is node2463 in delivered `dee396...`, node1744 in composed
`c962df...`: it consumes final-normalization `[B,S,2048]` and produces `[B,S,151936]` FP32
logits. Qwen has no last-logit-retention input or override. Its sole downstream consumer
selects the last token only after `forward()` has materialized all logits. The final-normalized
hidden tensor has no other consumer, and all 56 KV outputs branch before it. Gemma already
has a private generation-only one-token-logits override; general-purpose forward/scoring
must not silently inherit a narrower output contract.

The observed native LM-head dispatches `(1187,38,1)` and `(1187,40,1)` match vocabulary
tile128 and sequence tile16. The largest-buffer difference and decoder-peak difference both
equal exactly `27*151936*4` bytes. This strongly corroborates full-prefill logits as the large
allocation, without pretending the ledger directly labels buffers by tensor name. One-token
logits would be607,744 bytes, a nominal output reduction of366–383MB, not yet a measured peak
improvement. A generation-only axis1 Slice before the head is a candidate; it also changes
the native MatMul kernel, so complete last-token numerical/argmax comparisons are required.
Production defaults to native graph optimization `all`, unlike this strict diagnostic's `0`;
its actual phone limits and memory usage remain unmeasured. No production optimization or
phone-readiness claim follows from this investigation.

The generation-only Slice candidate is now frozen and passes six independently rerun
offline checks. It adds one Slice and four INT64 constants immediately before the LM head,
rewires only that head's hidden-state input, sets the logits sequence dimension to1 and
adds one matching hidden-value descriptor. All71 inputs,56 cache outputs, original learned
initializers and other nodes remain byte-identical; reversing the declared edits restores
the complete original graph bytes. Serialized controls select the last row for every
admitted sequence length1–1024. Admission remains a required per-call runtime check, not
an inference from static metadata. General forward/scoring is explicitly excluded.

- Helper `admin/qwen-decoder-last-logits-20260910.mjs`, SHA-256
  `4c0c690a7a912461bb5390e68b3b8210bc17652978565c63ffe82127754ac34d`;
  tests `14c576429bfb1b074ecbfdf237c7933e7a93e9c5bc185c3859d0f42c2de06104`.
- Plan `08495d74983760a82db29936dac6b4332441618e4acbf3fdff2aad15314c7b16`.
- Full candidate:4,896,612 bytes,1,746 nodes,764 initializers; SHA-256
  `475d9ad51b0da52e7510a8b597bdf42a533e552de3a3b74c58284ae6b2472375`.
- Original isolated head:1,031 bytes,1 node; SHA-256
  `f8877852704ab3da59783d8fe6ff46266529cc52a5a3a2a6445b66a8a8ee0636`.
- Slice plus head:1,599 bytes,2 nodes; SHA-256
  `8107446ef2ba4a008bcd17dc705c947ba80458d7ef461fa7972afba290bacb35`.

The proposed numerical gate is fixed before execution: deterministic nontrivial hidden-state
fixtures at S1,604,631; compare all151,936 last-row FP32 scores from original-GPU and sliced-GPU
execution against an independent original-head CPU reference, and against each other. Require
finite values, per-element error at most `1e-4 + 1e-4*abs(reference)`, maximum absolute error
at most1e-3, identical greedy argmax, and report the top-two margin without exemptions.
The S1 unchanged-kernel GPU control additionally requires byte equality. The three actual
quantized initializer spans are unchanged, contiguous199,340,032 bytes at the end of the
original decoder shard; no default zero point or accuracy attribute is substituted.
No numerical runtime, measured saving, full-model candidate run or production change is
implied by these structural tests. These fixtures do not replace later image/phone acceptance.

The independent original-head CPU reference subsequently passed all three fixtures, after
seven offline tests and the user's explicit approval for the isolated run outside the command
sandbox. One ORT 1.24.3 CPU session evaluated only the three exact last hidden rows; this is
a numerical test oracle, not an application fallback. Four fixed vocabulary coordinates per
case also passed independently dequantized FP64 arithmetic checks. All six tensors were
disposed, the session released, and the full original weight/source hashes remained unchanged.
The run took 3.81 seconds and retained 1,823,232 bytes of scores. No browser, model generation,
phone, production, server or APK change occurred in this reference run.

- Reference helper SHA-256
  `7c9eb99b753b52dd82dfb7172307b8dd706c81e7ea8aa2ff74113462cb24dc37`;
  tests `90bfa3640693e7ffde554d4c6332e60aa28ddbfe2c8f9aa65058cbec3cb6d529`.
- Plan `4948669b38455550f12e3f68eef28973d2403bd9295a8659e62b98d55ca04d81`.
- Receipt `output/qwen-last-logits-reference-20260910-Xjp70c/result.json`, SHA-256
  `cae116b04f24a2f084ca56f8e0e87964a950efa2ab4096c0633633536d4a2daf`.

The original-versus-sliced WebGPU numerical gate is still separate and pending at this point.

The first browser run then reached all three **original-head** GPU calls. Every retained
last-row score passed the fixed CPU tolerance gate, with identical greedy tokens and maximum
absolute errors `8.34465e-7`, `1.90735e-6` and `1.43051e-6`. Native evidence confirmed the one
original node on hardware WebGPU, strict CPU fallback disabled, INT64 enabled, NCHW and
optimization disabled. All 18 exposed buffers were explicitly destroyed; the observed logical
peak was 975,758,384 bytes. This is isolated-head allocation, not full-model or physical VRAM.

The overall test **failed** at the harness's exact-one-device-destruction assertion: the
retirement trace contained destroy, acknowledged loss with reason `destroyed`, then another
destroy. The reduced-output candidate was not run. The full console (107,781 bytes, 357
records) and both shader bodies passed their independent integrity checks; no native error,
fatal or CPU-fallback event was observed. This failure is retained, not relabeled as a passing
comparison. A preceding invocation had stopped before browser launch because the supplied
Windows path spelling did not match the reviewed plan; its corrected invocation used the
exact original path and unchanged plan, inputs and tolerances.

- Browser plan `ff800e1be002a15aad2665332d682f089d762ca789f7a07bc8bfd7ee5073038f`;
  runner SHA-256 `a438b9bb498101fde08645a2d9cef0d8abedda51d552ec420e03e928f1492a83`.
- Receipt `output/playwright/qwen-last-logits-20260910-Pw8G54/result.json`, SHA-256
  `fcb942a26d865a3e9581589afb58d3521c452ba578d94c2efd7df1ac33788bd6`.
- Console SHA-256 `5edad3426b5107353411cf2f9ab54e5d1894bde4310b50e19ab5f6061ee33214`.

After the process exited and browser/server closure was confirmed, only its temporary
browser profile was removed: 211 files, 15,458,456 logical bytes, 15,650,816 observed free
bytes reclaimed. The original result and numerical outputs were preserved; models and
account data were untouched. The profile is regenerable, not sent to the Recycle Bin.

The cleanup defect was then corrected without changing graphs, inputs, weights, native
options or numerical thresholds. ORT's native `_OrtReleaseSession` can destroy its owned
device through the pinned JSPI `emwgpuDeviceDestroy` bridge; the finalizer now acknowledges
that exactly-once release-owned destruction instead of repeating it. A snapshot immediately
before forwarding the actual destruction must show zero outstanding buffers. Premature,
duplicate, unobserved-device or unacknowledged destruction still fails. The four original
runner/worker/test sources are preserved byte-for-byte as `Pw8G54/*.original`. The corrected
worker and browser tests passed 22/22 independently.

The corrected run `output/playwright/qwen-last-logits-20260910-Qdi9o1/result.json`, SHA-256
`3529c82fb2c766180ca74e1ae344fda0bac885ae777b0b7cf6b772c3c391350a`, passed the original
head's three numerical calls, strict native GPU checks and corrected actual-boundary cleanup.
Its reduced-output case stopped after 30,072.84 ms with `TypeError: Failed to fetch`; the
server recorded an aborted local weight transfer. This is consistent with the fixed
30-second transfer deadline, but the record does not identify why transfer was slower.
That case had **zero session-creation attempts, GPU devices or inference calls**. The
top-level shader-witness assertion is secondary to the retained per-case fetch failure.
No candidate numerical, memory-saving or phone qualification follows, and the result remains
failed/incomplete. Browser and server closed, sources stayed unchanged and no app was changed.

- Corrected plan `dda8394d60431b03bb1b6cf5a67ed2032db79eca20a04158a28d23e830760950`;
  runner `28b492c985ba2cdc8a1c3810e718855e1c4297bd5c1394a4ed359daba600d675`.
- Worker `3653509fa997d2861db09511e26ffb614521bfd8fb33bc52c52220e9429bcbca`;
  worker tests `6847dc52bfa87fa17b130f04bbed966e847091b66c8879f9b4f51443fc81013d`.
- Console: 107,424 bytes, 357 records, SHA-256
  `752268f8dddafeb95ccae2a19166e8ec23827c0df72cdc8639ca847929ff9bf5`.

The corrected run's regenerable browser profile was also removed after process and service
closure: 211 files, 15,458,717 logical bytes and 15,654,912 observed free bytes reclaimed.
Results, model caches and account data remain intact; nothing was sent to the Recycle Bin.

The isolated comparison subsequently **passed** in
`output/playwright/qwen-last-logits-20260910-UQEPqK/result.json`, SHA-256
`bfe237ba14211aba27c6f680480d514d25b55d8cce6d67c9518d4f202d4c59cf`.
Only the local weight-transfer deadline changed from 30 to 90 seconds, with explicit
byte/EOF/hash/timing/abort evidence and preservation of the primary transfer error. All other
deadlines, graphs, inputs, native options, numerical thresholds and cleanup requirements were
unchanged. Independent review and all 24 focused offline tests passed.

Both graphs completed all three inputs. All nine full-vocabulary comparisons passed:
maximum CPU-reference error `1.9073486328125e-6`, maximum GPU-pair error
`1.430511474609375e-6`, identical greedy tokens, and byte-identical S1 GPU outputs. Native
placement was exactly `[1, 2]` with CPU fallback disabled. All four shader bodies matched
the actual API witnesses, and the complete 193,588-byte / 643-record console had no native
errors or fallback. Each device's 18 buffers were explicitly destroyed before its one
release-owned destruction and actual acknowledgement.

Recomputed **whole-session logical allocation peaks**, including weight initialization,
fell from **975,758,384 to 311,164,928 bytes** (68.1%). The candidate's inference-only peak
was 213,962,912 bytes; do not present that smaller number as its whole-session peak. These
are exposed GPU buffer sizes in an isolated head test, not physical VRAM or full-model/phone
memory. Original logits occupied 367,077,376 / 383,486,464 bytes for the two prefills; the
candidate returned only 607,744 bytes in each case. Full decoder/cache behavior, image
extraction, prompt variety, Gemma and phone acceptance are not established by this result.

The two complete weight transfers took 17.82 / 19.44 seconds, including 15.08 / 15.90 seconds
of measured hashing. Neither aborted. This confirms that hashing accounts for most of this
diagnostic transfer's elapsed time, but it does not retrospectively prove the precise cause
of the earlier 30-second abort. Source pins and all six retained output hashes were rechecked.

- Plan `8d89704b80ae7ce307949c8941e447581b17a4fc1f1292ad1061c8d42d2ffc1e`.
- Runner `a6315a4f7247ced153af11229281ee7805b1a47ca56dc5b1c8ff94e03e8867f3`;
  worker `ea126ae9e1a07dba3de44f30a8e64e61cdcf3767be97c61f30e358055ef47b9d`.
- Console SHA-256 `adde60643792e0f30418dd698c681ca9b4b8ff324b4dc6ef02ad7c09cf276194`.

After process exit and browser/server closure, its 211-file temporary profile was removed
(15,458,718 logical bytes; observed free-space increase 18,173,952 bytes). Results and models
remain. The prior failed runs and their four exact source archives are preserved. Production
code, prompts, servers and APK remain unchanged.

### Last-position head in the full model — runtime/output-equivalence pass, not accuracy qualification

The diagnostic candidate then completed both English-image cases in the default command
sandbox, without needing another outside-sandbox run. Receipt
`output/playwright/qwen-full-last-logits-model-20260910-gbWQPT/result.json`, SHA-256
`e503e2a8ee3223d27f324cab7d5c25614abc3693291a33c3620474d1d47438f6`, records runtime and exact
raw-output equivalence passes, with the existing strict raw-field failures preserved.
Root reran all 10 wrapper/build tests and 22 runner tests before inference.
Independent post-run review rehashed the sources, build, original assets and complete console,
reconstructed all shader witnesses, and revalidated input/output equality and device lifetimes.

The same original English 13,500 EGP image, 1,989-byte candidate prompt, 640/748 patch layouts,
greedy 96-token limit and 1,024 context were used as in `iNS7D6`. Actual prepared inputs and
generated raw bytes matched that frozen baseline exactly. All 58/64 decoder calls validated
FP32 logits `[1,1,151936]`, all 56 present-cache shapes and eight owned host control tensors.
No crop, OCR, second inference, learned CPU fallback or production prompt change was added.

Both cases proved native node placement `[1770,1,1746]`, strict CPU rejection, INT64 enabled,
NCHW layout and disabled graph optimization. Complete console capture contains 183,891 records,
70,590,708 bytes, SHA-256 `50bc8cab9d1b41cf2b4a8e20e5d7872513401db8f5edf5b9d61b7af384fd8636`;
142 shader bodies / 434,848 source bytes matched actual API witnesses. No native failure or
fallback was reported. All 5,495 / 5,771 buffers were explicitly destroyed before device release.

Full decoder-device logical peaks fell from **3,778,552,016 / 3,794,961,104 bytes** to
**3,385,260,128 bytes** for both cases: **10.41% / 10.80%**, not the isolated head's 68.1%.
The largest single buffer fell from 367,077,376 / 383,486,464 to 155,582,464 bytes. Vision/embed
device peaks remained 858,962,224 / 884,958,688 bytes. These are exposed allocation counters,
not physical VRAM, app RAM or phone measurements. Observed request durations were 22.94 / 21.95
seconds; no controlled end-to-end speed comparison was performed.

Answers retained correct amount/currency/calendar date and visible memo, but still used a JSON
fence, omitted the time and selected the memo instead of this diagnostic prompt's heading.
Thus raw-field accuracy remains failed. Exact generated output does not prove equality of
every full-model logit, a common prompt across images/models, or phone reliability.

- Build receipt `tmp/qwen-full-last-logits-diagnostic-worker-20260910-Hfqwj6/build-summary.json`,
  SHA-256 `41a442fe21d19e724554b2be989c5edb11637ad35e7abe371a41e15e427efe41`.
- Worker 926,196 bytes, SHA-256 `356cbc971eee23cb4e3f1b291087061e6f8089ec52e4cc1969c9e0d4c365660b`.
- Runner `8996c1b3bad29485e0ae271fe112483488d319131514fbffee31e5b8817f0403`;
  test `8bbfedfd5832a464a3713a29c8f5a47b8506806972d67cbd8e0a6494e84bcad5`.
- Run plan `ef22e5438e3c4552362a66f6d3501c0821e5261481168640cca1a3b218f52c4c`.

This qualifies the separately built diagnostic composition only. Production lacks its host
metadata adapter and other strict graph/session changes; copying candidate `475d…` alone
would violate production's private-input contract. Production integration requires separate
assembled-worker and phone qualification. No production code, servers or APK were updated.
After exit 0 and browser/server closure, only the 216-file regenerable profile was removed:
1,858,798,210 logical bytes, 1,859,010,560 observed free bytes reclaimed (not Recycle Bin).
Models, original images, account data and immutable results were retained.

### Production-source port of the qualified runtime composition — preparation record

OpenChat now has unenabled graph/control/session helpers for the qualified decoder and image
paths. Root's six focused specs pass **170/170** with a clean narrow strict TypeScript check.
The browser geometry factory reproduces all 715 native-reference tensor hashes for the existing
55 image grids; generation controls reproduce all 990 retained native outputs. These checks
cover host-side dimension/geometry arithmetic and ownership, not learned CPU fallback or
fresh extraction accuracy. Learned graph nodes and weights stay on the requested GPU path.

The dynamic image graph keeps 1770 nodes and all four image/DeepStack outputs, with 13 private
geometry inputs behind a two-input public facade. The complete strict-WebGPU comparison below
now passes, but production integration remains outstanding. Decoder retirement must also wait for
the outer staged call and its private-feed cleanup, not just the inner native call. The server,
APK, app prompt and model download manifest have not been updated. Prompts, field semantics,
currency/date normalization and user-defined type matching remain IOU responsibilities.

### Dynamic production vision factory — GPU equivalence passed, not extraction accuracy

The six-call comparison completed with exit 0 in the default sandbox. Each of the retained
Arabic/English transfer and missing-evidence processor inputs ran once through the established
static-grouped encoder and once through the new dynamic graph and actual production wrappers.
All 24 complete output files (31,064,064 bytes) have matching pairwise hashes: 12 comparisons,
3,883,008 FP32 elements and zero numerical error. All six sessions placed every one of their
1770 nodes on hardware WebGPU, with INT64/NCHW/optimization-off/CPU-fallback-off confirmed
in native logs. All 39 private controls match native-reference hashes before and after use.
All 6870 observed buffers were explicitly released before their six intentional device
destructions; browser/server closure and unchanged source identities are verified.

This closes the dynamic vision factory's numerical/placement gate, not the shared-prompt,
assembled-worker, date/note/type or phone gates. It is also not a new memory-saving result:
logical image-session peaks rose from about 660 MB for static specialization to about 694 MB
for dynamic inputs. That is neither physical VRAM measurement nor a change to the separately
qualified decoder-head saving. No prompt, registration, production entrypoint, server or APK
changed. The nine focused offline harness tests also pass.

Receipt `output/playwright/qwen-vision-host-inputs-20260910-ZFZBNk/result.json` under the project
temp root has SHA-256 `575b6f80764ff6a5badaa072ef62c4ae4fb84ab76c1b8a889aa14228fff5824b`;
plan `90975f518e01ff1a97fefd21300f704a96214be4cf3405c46db3fdd68822d57e`.
The complete console is 6,297,493 bytes/21,258 records, SHA-256
`c470cfe58b40a2af490497978780d36f2653d6119f241709c287b7292e663a64`.

After independent verification and closure, exact-path cleanup removed the regenerable test
profile and two never-executed, superseded preparations: 26,866,467 logical bytes, with
27,066,368 observed free bytes reclaimed. The executed runner, results, original images,
model cache and account data remain; removed temporary files were not sent to the Recycle Bin.

### Qualified helpers integrated into the actual OpenChat model-worker build

The subsequent source integration now connects the six reusable helpers to development and
packaged graph delivery, exact manifest pins and the actual staged sessions. Original model
weights, revisions, cache keys and optional Gemma audio are unchanged. Qwen uses strict NCHW
WebGPU with early INT64 configuration, optimization disabled and CPU fallback prohibited.
All model-specific host controls remain generic OpenChat runtime mechanics; IOU prompts,
field semantics, date/currency normalization and user-defined type selection are unchanged.

Outer session release now drains pending loading, native inference and private-input cleanup.
Independent review also identified two cleanup gaps: throwing post-create reporting could
orphan a native session, and throwing DeepStack disposal could strand other owned outputs.
Both are fixed with three regression cases. These are verified code defects, not proof that
they caused every reported phone crash. Root's combined checks pass **296/296** scoped model
tests and **61/61** notice/distribution/CI checks, with zero narrow TypeScript diagnostics.

The real production model-worker configuration builds successfully without building unrelated
workers or changing a deployment. Worker SHA-256 is
`dd107de1bc3fc1c91e7ac16165681f51941f8b9503991c443c1cd749394154ed` (962,323 bytes).
Project-temp receipt `output/integrated-model-worker-hAjaUB/result.json` has SHA-256
`6846faa2df62e87961afd00be65716449000f3f398f7edd9e9905894b9a0b442`.
This is packaging/interface evidence only. Assembled-worker GPU inference, a common app-owned
prompt that passes both models, and repeated phone proposals remain unqualified. No server,
APK, IOU prompt or published Git state changed during this integration.

### Subsequent assembled-worker smoke: repeat-use passed on desktop

The unchanged integrated production worker now completes Arabic → reservation → Arabic in one
browser worker, with IOU's actual six-field prompt and no retry or OCR. Requests took 15.334,
11.501 and 11.647 seconds (77 seconds including setup). Both Arabic raw outputs are identical:
12,900 EGP, `14 Aug 2026 09:47 PM`, empty ending date and the success heading requested by the
current prompt. The reservation raw output is 1,912.15 USD, `Sun, Jul 19` to `Thu, Aug 6`, and
`Reservation`; the current IOU symbol policy permits USD for the visible dollar sign.

All 14 cached artifact bodies (1,836,691,582 bytes) verified. There were zero model-artifact
HTTP requests during inference/teardown, zero unexpected device losses and zero console errors.
All 17,926 observed buffers were explicitly destroyed before six hardware-device retirements;
the intentional second destroy call is recorded as idempotent. The actual worker disposal ACK,
browser/server closure and all 54 unchanged source bindings were independently verified.
Decoder logical-buffer peak was 3,385,260,128 bytes; this is not measured phone memory or VRAM.

Project-temp receipt `output/playwright/qwen-integrated-worker-smoke-20260910-VxDwCq/result.json`
has SHA-256 `06e2cf378e386ed1b1568db68c4471fb6832a82836ac029b8194dc9fb844d9c4` (153,006 bytes).
Complete console: 396,594 bytes / 1,280 records, SHA-256
`096330acf4cb950afef1f5880e764a4e3fc0e740b522b0b785d82cff73fd87a4`. Nineteen runner/observer tests
pass. The closed, fresh test profile is temporarily retained for the next read-only cached Qwen
screen, avoiding another model-cache copy. The user's downloaded-model cache is untouched.

This closes a desktop assembled-worker repeat-use gate, not shared-prompt or phone acceptance.
No native per-node placement counts were claimed. The seven-field memo/heading prompt remains
a candidate, and rendered-card/type/direction/missing-evidence tests are separate. No IOU
prompt, server, installed APK or published Git state was changed by this run.

### Head-grouped vision attention — isolated JSPI feasibility (earlier record)

A separate, bounded diagnostic now tests a memory hypothesis rather than another prompt
wording change. The pinned Qwen vision graph has 24 head-independent attention blocks with
16 FP32 heads. Splitting the head axis into four groups preserves every query/key position,
the complete shared mask, scale and softmax axis, then concatenates the contexts in their
original order. It does not crop the image, add another model pass or supply missing evidence.

At the unchanged 640-patch bound, one score tensor is 26,214,400 bytes in the baseline and
6,553,600 bytes per group. These are individual logical tensor sizes, **not measured total
peak GPU memory**. Scheduler order, simultaneous branches, allocator pooling and shader
selection can negate that apparent reduction. The existing phone bound is an empirical
margin below a previous 720-patch failure, not a proof derived from the buffer-binding limit.

The admin-only builder constructs two tiny standard ONNX graphs in memory, with no model
weights or binary artifacts written. Fourteen offline tests pass, including serialized-edge
numerical equivalence at 1/3/8 patches, independent head-order/mask checks, exact source/runtime
pins and rejection of execution or budget-increase arguments. The production runtime is the
pinned `onnxruntime-web/jspi` build, not the separate JSEP TypeScript implementation.

Builder `admin/qwen-vision-head-groups-feasibility-20260910.mjs`, SHA-256
`65b34a894b24415f46f80a8af7d7673b2a9615bdf8c6b054294f91b43eef07dc`;
tests SHA-256 `9767cdfb2ccd92b1e39982d909100703cb5e8a9c8a532b276e4d9c1ffa297a83`.
These offline checks are not additional model requests. The subsequent standalone browser
test below measures this hypothesis without changing a production model or image budget.

The reviewed runner uses the exact pinned JSPI runtime, synthetic deterministic FP32 inputs,
two mask cases, and a fresh worker/device per graph/mask combination. Each session runs cold
and warm once. CPU fallback is disabled; actual ORT device identity, dispatch/submission,
shader code, node placement, buffer creation/destruction and retirement are recorded. An
independent sparse FP64 reference covers all heads/channels at queries 0/319/639 and every
key. Root reran its 13 tests and the runner's seven tests; combined with the builder's 14,
the offline suite passes 34 tests. No model weights, app data or account state are involved.

The first eight-call batch completed every calculation but **failed overall**: its 2,000-line
console cap dropped 568 verbose log lines. That failed receipt remains unchanged. Only the
console bound was raised to 4,096, verified by exact text replacement; original runner bytes
were preserved beside the first result. The second eight-call batch passed with all 2,568
lines retained (longest 1,054 characters), zero runtime/GPU errors, and unchanged sources.
These are **16 synthetic attention calls**, separate from the 206 full-model requests above.

Observed on desktop NVIDIA Ampere hardware:

| Measure | Baseline | Four head groups |
|---|---:|---:|
| Nodes placed on WebGPU / dispatches per call | 5 / 5 | 33 / 33 |
| Peak exposed, undestroyed GPUBuffer bytes | 73,925,024 | 43,517,600 |
| Largest actual created GPUBuffer | 26,214,400 | 8,388,608 |
| Exposed undestroyed bytes after session release | 0 | 0 |

All 655,360 output values are byte-identical across the two graphs, cold/warm repeats and both
batches for each mask. Root independently rehashed all 16 full binary outputs, repeated sparse
math checks and reconstructed every buffer-ledger event. Sparse maximum absolute error is
below 8.54e-8 against the independently computed reference, within the predeclared
`1e-5 + 1e-4 * abs(reference)` tolerance. Warm calls do not increase the measured peak.
The exposed allocation peak falls about 41.1%, but this is **not physical VRAM, driver peak,
full-model peak or Android acceptance**. WebGPU destruction and actual physical reclamation
are distinct; see the [WebGPU resource lifetime specification](https://www.w3.org/TR/2026/CRD-webgpu-20260109/#dom-gpubuffer-destroy).
More dispatches and diagnostic overhead also prevent claiming an overall speed improvement.

Records under the project-temp root:

- Failed `output/playwright/qwen-head-groups-synthetic-20260910-DPUFWA/result.json`, SHA-256
  `181c899f614f83f58c6afc9fbfdbfaab757b37e2c65eaf7c1d501d728fce58e5`.
- Passing `output/playwright/qwen-head-groups-synthetic-20260910-qw6JJf/result.json`, SHA-256
  `7c2f84a20a2960c43bf0a17b3c9e344a4b6cacf411b5635fa60e00fe12c514eb`.
- Passing plan SHA-256 `2071cb895fff27150d4ba3e802d37f490128ceff3f2725fe06b13501b97cf17c`;
  runner SHA-256 `df0c298729020cf389d95fc1d7066e472c04e683771cfbb73c64a76fca9e9a8d`;
  unchanged worker SHA-256 `419c4e568a011d58b53049beb22b0a44cc0f7bd28fc3f06c76c43d63e5e04c37`.
- Sparse reference SHA-256 `4f904a581fb63b69bedc96d3142c012b77b67876a66a9f3dc9ac8f14ea6cae92`.

Both owned browser/server processes closed and all workers/devices retired. Exact-path cleanup
removed only the two regenerable browser profiles: 374 files, 28,598,926 logical bytes and
28,655,616 observed free bytes reclaimed, not sent to the Recycle Bin. Full outputs, failed and
passing receipts, model caches and original images remain. No production graph, image budget,
server or APK changed. Full vision-graph numerical/runtime checks must precede any budget
experiment; this result does not fix absent currency or qualify image accuracy or a phone.

### Currency example with the strongest shared prompt — rejected

Eight new Qwen requests interleaved the exact `384c...` baseline and one currency-line
replacement on four previously seen images. Every non-currency prompt byte, field name/order,
symbol mapping and missing-field omission rule stayed unchanged. The replacement contains
present-versus-absent currency field examples; wording compaction and association with the
total change together, so this is not an isolated example-only intervention. IOU's actual
`imageCurrencySymbolPolicy()` was evaluated from two pinned source modules and matched both
prompts. Expected answers stayed out of worker input; example values were negative controls.

All eight requests completed on observed hardware WebGPU with the unchanged production
worker, native template, image budget and 96-token limit. No GPU failures occurred, sources
remained unchanged, the worker retired/terminated and browser/server closed.

| Image | Baseline | Currency-line example |
|---|---|---|
| Currency-free estimate | Invented `$`; empty dates instead of omission | Invented `USD`; same empty-date violation |
| Real date range | Correct source fields and card | Correct source fields and card |
| Arabic transfer | Correct source fields and card | Correct source fields and card |
| English transfer | Visible memo rather than instructed heading | Same visible memo; copies the complete printed timestamp |

The English memo is `Living Expenses`, genuinely present in the image. It is not invented,
but neither prompt requested it and the frozen heading/card oracle remains unchanged. The
variant's complete timestamp also appears in the image and passes the separate visible-date
policy; it does not satisfy the narrower calendar-only metric. Both prompts pass **2/4 source
and current-card cases**, with **0/4 strict JSON-shape matches** because all responses are
fenced. Formatting tolerance is not the reason for rejecting their incorrect content.

The new offline assessor reuses the frozen replay through exactly two recorded in-memory
substitutions: binding the current duplicate-rejecting host hash and correcting the replay's
mock success discriminator to the actual `ok` type. The historical file and all oracles remain
unchanged. Its source/graph bindings and reconstruction are checked. Root reran five adapter
tests and thirteen assessor tests; constructed positives cover both model identities but are
not Gemma inference. Root's independent actual assessment returned nonzero and was byte-identical
to the retained assessment. The redundant identical copy was removed.

This variant does not transfer the earlier literal-prompt example's absence improvement to
the stronger mapped prompt. There is no Gemma, broader-corpus, holdout, phone, registration,
server or APK advancement. The remaining memo/caption, multiple-transaction and direction
requirements are not removed from product acceptance.

Pinned artifacts under `F:/Temp/OpenChat-IOU`:

- Prompt `admin/common-proof-currency-example-20260910.prompt.txt`, 1,993 bytes, SHA-256
  `0dfd0eb6740d549804019a66e41f8ed325aac5d33cf6857f946b7c8c18a1714f`.
- Manifest `admin/common-proof-currency-example-20260910.json`, SHA-256
  `bee2257db7db80e12f555766f58a66f9e6a8572ece3d2190d86964ada423b819`.
- Adapter `admin/test-qwen-proof-currency-example-20260910.mjs`, SHA-256
  `cbe0d1cf697295e42ab590ffcdf6de4d7e6e225d217085599cbf91f855db7195`.
- Result `output/playwright/qwen-production-full-model-20260909-qJ2sfh/result.json`, SHA-256
  `b43abe2c32df1caf3acc49493764ce831237f5b84a63745fffffd5f526b09518`.
- Assessor `admin/assess-proof-currency-example-20260910.mts`, SHA-256
  `e8dee0b6d584797f531b3636fb859c4d45949f5625d147cdd7725290d76966bf`.
- Assessment `admin/proof-currency-example-assessment-qwen-qj2sfh.json`, SHA-256
  `7c5e3b49ac2ba0758c51e146c44764ff251ebcbc8bfdce05a8854c2cb7bdde78`.

Exact-path cleanup after closure removed only the disposable browser profile: 216 files,
1,868,110,718 logical bytes and 1,868,328,960 observed free bytes reclaimed. It was not sent
to the Recycle Bin; retained models and the immutable result remain intact.

### Balanced duplicate-field acceptance gap — 10 September

The recorded Arabic completion contains two `note` keys. The host used native `JSON.parse`,
which silently retained the last value; an existing test explicitly preserved that behavior.
Neither a repeated name nor a syntactically valid last value establishes a grounded correction.
The historical seven-field screen already failed its independent content oracle, but the
generic parser could still turn that ambiguous response into a proposal.

PR2 now rejects a balanced JSON object's duplicate decoded property names before schema/card
processing, even if the values match. This includes nested objects, escaped-equivalent names,
array envelopes and mixed batches. A duplicate rejects the whole candidate batch rather than
silently dropping a row. Single-object and truncated-envelope recovery cannot resurrect it;
fully balanced children within an unclosed envelope receive the same check. Existing genuinely
incomplete scalar-prefix tombstones/coalescing and other parsing tolerances remain unchanged.
The iterative check is generic: no IOU names, values, schema or rules were added to OpenChat.

Failing-first tests reproduced 16 initial failures and three additional envelope failures.
The final focused parser/schema run passes 266 tests, including 22 new tests; the root's
expanded seven-file app-action run passes 445 tests. Root replay through the current parser
rejects the recorded Arabic duplicate; the other three records' parseability is unchanged.
Four existing fixture-typing errors were corrected without casts or weaker assertions. The
targeted strict TypeScript program (both edited files plus existing frontend ambient declarations)
has zero diagnostics; formatting and scoped diff checks pass. This is not a full frontend build.
This is safer acceptance, not a corrected memo or a new model accuracy result. Historical
result bytes and the old failed assessment remain unchanged. The parser fix is PR2-only,
uncommitted and not deployed to the server or APK.

### Memo-only task isolation — 10 September

A new bounded diagnostic retained the exact memo instruction from the rejected seven-field
candidate, but removed the other six fields and examples. It requested only `note` in JSON,
using the original Arabic and English images, unchanged production image settings and the
new completion guard. The predeclared order was Arabic, English, then the same pair repeated.
Expected memo text was independently transcribed and kept outside worker input. This changes
task count, prompt length and framing together; it is not a one-variable causal experiment
or a replacement full-extraction prompt.

Only the **first request ran**. On hardware WebGPU it reached the unchanged 96-token cap
without EOS after 11,166 ms. The worker returned the exact output-limit error and no partial
text. The ordinary successful-result gate aborted the batch; the English comparison and both
repeats remain unrun. Source identity stayed unchanged and the browser/server closed. The
offline assessor rejects this runtime failure rather than counting an incomplete batch as
content acceptance. Nine harness/assessor tests pass, including constructed provenance and
wrong-content negatives; these are not nine model runs.

Reducing the task to one field did not make this case finish reliably. This does not prove
the memo is visually unreadable or isolate resolution, language, precision or prompt wording
as the cause. No output budget, production prompt, image processing, model assets, server or
APK was changed in response.

Pinned project-temp evidence:

- Manifest `admin/common-note-only-20260910.json`, SHA-256
  `2c4ffa783a9cde2695ec43486add54f9975af486dae2cd3de2250646de4070b5`;
  prompt SHA-256 `8c4020eb69cbc22796784213a31c6102d390b6f6fcc2badce94e0c0bf9f2a6a8`.
- Result `output/playwright/qwen-production-full-model-20260909-PSJQeN/result.json`, SHA-256
  `13b4a024eebb39be7cea9deac854bf43682f0571895df3f87d59148cf9d4232e`.
- Adapter `admin/test-qwen-note-only-20260910.mjs`, SHA-256
  `7f825c9bac9a76930e6cc6d211f3fe67348c9580eb32b37714560591aaf5e268`.
- Assessor `admin/assess-note-only-20260910.mjs`, SHA-256
  `79ae0e5156cdd49fc8d15eeccc9f2468f745f06b95c96597c94bd0d2462dd80e`.

After verified closure, exact-path cleanup removed only this run's regenerable browser profile:
214 files, 1,858,857,040 logical bytes, and 1,859,072,000 observed free bytes reclaimed.
It was not sent to the Recycle Bin. Retained model caches and the immutable result are intact.

### Completion-limit verification gap — 10 September

Recorded text alone does not establish why generation stopped: the old worker decoded with
special tokens omitted and retained no generated token IDs or stop reason. Re-encoding that
text is not an original token-count measurement. Incorrect currency and note selections occur
early in the recorded completions, so increasing the limit is not an evidence-backed accuracy
fix. The 96-token limit is conservative application policy, separate from Qwen's checked
1,024-token graph context bound; no new phone qualification above 96 was established.

The generic worker now checks actual generated token tensors against the model's effective
EOS configuration before decoding. A final EOS, including exactly at the cap, passes; capped
non-EOS output and unexplained early stops fail without publishing partial text. Tensor shape,
IDs, count and prompt prefix are checked. Both model paths retain their generation options,
96-token ceiling and full GPU-retirement barrier. No app fields or rules are involved.

Failing-first worker tests reproduced six false successes before integration. Root verification
now passes 114 focused tests in five files, 26 model-CI discovery/contract tests and targeted
strict TypeScript. The production worker-only build includes the new helper and succeeds:
`tmp/qwen-production-worker-only-20260909-7y2Do1/build-summary.json`, receipt SHA-256
`1e3689f0fc26c8aad9d40081ddcfc5296221650c692db0494ac00a234f3fb8e4`;
worker SHA-256 `2d38ee2a6ae9e5bcb93ca178873e1ccf85b370d0325382be1ee44cdf0f45f581`.
The subsequent real Qwen desktop WebGPU check passed its three predeclared requests on one
worker: the missing-evidence image at 96 tokens, that same image/prompt deliberately capped at
one token, then the same normal request again. Both normal outputs exactly match the historical
baseline bytes; the middle request returns only the exact output-limit error. Unrelated errors,
unavailable responses and partial text would fail the check. All existing GPU, source, network
and retirement gates passed; the worker retired/terminated and browser/server closed. No model
file or image was changed. This validates cutoff handling and recovery, not new image accuracy,
phone behavior or Gemma GPU behavior under the new guard.

The guard is synchronized to PR1 with only the reviewed six-file change; its unrelated Vite
configuration is preserved. Root reran 114/114 focused tests and targeted strict TypeScript in
each PR worktree. No APK, server, app registration or production prompt was updated.

New records under the project-temp root:

- Adapter `admin/test-qwen-completion-guard-20260910.mjs`, SHA-256
  `e5ab425b45b525c7ddd35263c41198511fba7defa7b1da707ea0076e085699f4`;
  its four offline negative/provenance tests pass.
- Result `output/playwright/qwen-production-full-model-20260909-9XH3GX/result.json`, SHA-256
  `a6ff871e4ddc08d12f2db1bb654da0a71c862486c8aa3637edbf65a7ce655e34`.

Exact-path cleanup removed only this run's regenerable browser profile: 1,864,128,833 logical
bytes, with 1,864,347,648 observed free bytes reclaimed. It was not sent to the Recycle Bin;
retained models and immutable evidence remain. Historical failed prompt scores are unchanged.

### Prospective note/heading separation — 10 September

The app previously reused the note as private saved-type matching evidence. A model following
the general memo preference could therefore discard a category keyword visible only in the
heading. IOU now declares an optional bounded `image_heading`, validates it only for image
normalization, and enables it as separate evidence only during normalized card hydration.
It never replaces the note, joins fields into a synthetic keyword phrase, exposes a private
type roster to the model, or appears in the confirmation payload. Conflicting matches remain
unselected. Direct paste/connector matching leaves this new evidence disabled by default.

Do not infer that a single surviving candidate was originally a single transaction: the
normalization bridge loses original array cardinality. No deterministic caption overwrite was
adopted. Caption precedence and fresh multi-entry extraction still require model-level tests.

Root verification passed 330 focused tests across eleven files and both IOU TypeScript checks.
This includes 74 new heading/schema boundary tests. An existing currency-policy test table was
also corrected: Vitest had spread each mapping array into callback arguments, testing the wrong
shape rather than the intended malformed mapping. The corrected 39-test file passes.

Before inference, the new policy froze exact memo values for the two real transfer images,
retained the old headings separately, and preserved all amount/kind/currency/date requirements.
No historical oracle was changed. The prompt requests compact JSON. Offline tokenizer checks
show Qwen's eight expected outputs fit within 96 tokens, even with fences/pretty formatting;
expanded input plus generation allowance is at most 650 of 1,024. Gemma compact outputs fit
(at most 66 including EOS), but four fenced/pretty expected outputs exceed 96. These are token
feasibility measurements, not accuracy or actual model completions.

The four-case Qwen screen used the unchanged production worker, image budgets, native template
and greedy 96-token generation. Runtime/source checks passed; observed output problems were:

- Missing-evidence estimate: correct empty currency/dates and source text.
- Real range: correct amount/endpoints/heading, but empty currency despite the visible symbol.
- Arabic transfer: correct amount/currency/date/heading, but a duplicate note key with an
  unsupported final memo, and an unclosed markdown fence.
- English transfer: correct amount/currency/memo, but repeats the date as an end date and absorbs
  amount/label text into the heading.

This is a new prospective contract, not a single-variable causal experiment. No Gemma, broader
corpus, unused holdout, registration, deployment or APK advancement followed the failure.
The separately tested assessor (8/8 tests) replayed the recorded outputs through the actual
current host parser, IOU normalization and card/confirmation constructors: **1/4 source-field,
1/4 card/confirmation, 3/4 heading transport, and 0/4 strict serialization matches**. Only the
missing-evidence case passes the combined content screen; it correctly remains incomplete
financial evidence rather than an invented complete action. Constructed positives for all eight
expected outputs pass that pipeline under both model identities, but are not fresh inference.
The new assessor saves its report and sets a nonzero exit status for failed content, so completed
evaluation cannot be mistaken for a passing accuracy gate. The root invocation returned nonzero.
The completed disposable browser profile was removed (1,863,908,332 logical bytes); retained
model files and all evidence remain intact. It can be regenerated, not restored from Recycle Bin.

Artifacts under `F:/Temp/OpenChat-IOU`:

- Prompt `admin/common-note-heading-20260910.prompt.txt`: 1,790 bytes,
  SHA-256 `c6f6e06ac495ab0a5df6bbe95c344829443e417480fb1d0cc0964ba69b12d8e7`.
- Manifest `admin/common-note-heading-20260910.json`:
  SHA-256 `582021e456f52535fd16e4a7e2165f949bcc3b65e8da752bab67bc06a9f65098`.
- Prospective policy `admin/common-note-heading-20260910.policy.json`:
  SHA-256 `0e28d9846c9a79bc85cdca8e7a2d9bcbb9c330aead877d7567ea2ea236490c20`.
- Result `output/playwright/qwen-production-full-model-20260909-JLJk6z/result.json`:
  SHA-256 `31c51f4a9e22c5717fe1d2ea37492412ccc494656e4285cfe6f51edbac0a83ee`.
- Root assessment `admin/note-heading-assessment-qwen-jljk6z-gate.json`:
  SHA-256 `79c27499ae15a07909c672b4a5782fa42b1a5bf5746ae28cb468fd4664222a71`.
- Assessor `admin/assess-note-heading-current-cards-20260910.mts`:
  SHA-256 `74d7b3839502f8b7ad5bb263e0392fc413243d4f556d54aa6b384e2b9e16bbde`.

The earlier contrastive-currency screen remains distinct: it changed only the example suffix,
passed 1/4 source/card checks, and reproduced its other three failing baseline outputs byte for
byte. Do not attribute those existing failures to the suffix or merge passes across prompts.

### Product scope versus the diagnostic contract

The fixed uppermost-heading requirement is an implemented image-prompt choice, not an explicit
user requirement. It deliberately made the prompt experiment objectively scorable. The general
app prompt instead describes a source-grounded purpose, attached-text precedence and a preference
for a labeled memo. Consequently, the English image's `Living Expenses` is visible source text:
it fails the frozen heading instruction, but is not invented text. Do not rewrite historical
oracles or retroactively relabel that prompt as passing. A prospective production prompt must
resolve the note-precedence difference and be tested against its own frozen product contract.

The eight-image diagnostic also does **not** qualify the full product:

- Every case is a single image-only transaction; captions and multiple transactions are absent.
- Public `kind` is not a private user-defined saved Type. The basic replay does not hydrate the
  private type roster and its original expected card objects do not assert direction.
- Three valid intervals are covered, but malformed, incomplete, ambiguous and cross-year date
  evidence needs separate coverage. Passing known ranges does not cover those behaviors.

The additional [recorded-image saved-type tests](../src/features/openchat/recordedImageSavedTypes.test.ts)
connect five successful immutable completions from both models to actual IOU normalization,
form construction, private saved-type matching, direction defaults, user edits and confirmation
construction. Synthetic private names/keywords are supplied only after extraction; no model or
host receives them. Both credit/debt settings, unavailable/nonmatching/ambiguous rosters and
preserved user edits are checked. Separately labeled constructed equal-amount multi-row controls
check row-local matching rather than borrowing a sibling's keyword from shared text.

The root rerun passed **84/84 tests across three files**, including **16 new tests**. No original
fixture/oracle or production code changed. This is not fresh model inference, the actual host
parser, authenticated private-context transport, encrypted type-reference delivery, or phone/UI
acceptance. Those claims still require their own end-to-end evidence. Caption precedence,
explicit source direction and actual multi-transaction image extraction remain untested by the
current fresh-model corpus; they cannot be dropped from release acceptance because this suite
is green.

Actual desktop WebGPU inference, not mocked model outputs: pinned Gemma 4 E2B and Qwen3-VL 2B, original images, unchanged production image budgets, native chat templates, greedy decoding, and the existing 96-token cap. No OCR, focused crop, second inference pass, or fallback supplied the extraction. The complete original image was used each time.

This phase completed **111 inference calls in 12 batches** (Gemma 55 calls, Qwen 56). All batches completed their runtime checks; that is deliberately not counted as 111 correct extractions.

Controlled comparisons covered full versus single-field instructions; a shorter shared prompt; image-before-text versus text-before-image; status wording and surrounding instruction length; heading/output-field order; and explicit missing-value representations. Comparisons use the same candidate bytes for both models, never automatic per-model selection.

The broader set contains three real user screenshots, two previously used synthetic layouts, and three newly defined synthetic examples. After observing and tuning against those three examples, they are regression cases, not fresh holdouts. Three additional frozen synthetic holdouts remain **unrun**. Synthetic tests do not establish general real-world reliability. No phone acceptance was performed in this investigation.

## Best shared candidate: eight distinct images

Counts exclude the additional repeats. Every model result was also replayed through the real current OpenChat host parser, IOU normalization, app-authored card construction, and confirmation-payload construction. No entry was saved.

| Check | Gemma | Qwen |
|---|---:|---:|
| Exact visible-source fields | 7/8 | 5/8 |
| Correct card and confirmation values | 7/8 | 6/8 |
| Strict unfenced JSON object | 8/8 | 1/8 |
| Original-pair repeats, correct fields/cards | 2/2 | 2/2 |

Visible-source checking accepts only independently transcribed calendar-date text or its exact complete printed timestamp, identically for both models. It does not tolerate altered days, months, years, weekdays, or interval endpoints. The original calendar-only oracle is retained as a separate stricter check. JSON fences and singleton arrays are measured separately from the host's existing parser tolerance.

Remaining failures in this candidate:

- Both models invent a currency for the currency-free estimate: Gemma returns `USD`, Qwen returns `$`, which IOU maps to USD.
- Qwen selects the printed memo “Living Expenses” instead of the instructed uppermost heading on the other real transfer. This is wrong field selection, not invented text.
- Qwen changes a printed `USD` code into `$` on the synthetic interval. IOU's approved mapping produces the right currency in the card, but the raw evidence check correctly fails this unsupported representation change.

Explicit-empty/literal-currency instructions subsequently fixed the missing-evidence case on Gemma but regressed Qwen's original-image status/date output and a decimal amount. Retaining the currency map with explicit empty values and a more literal top-line instruction still failed Qwen's missing-currency and heading cases. These candidates were rejected, not deployed.

## Cause findings

**Confirmed input factors, not a fully isolated numerical root cause:**

- The errors are already present in raw worker output, before IOU parsing or card rendering.
- Changing only image/text ordering changes generated fields. It repairs some cases and breaks others; it is not a general fix.
- Instruction wording, output-field order, and surrounding extraction context affect status, heading and date selection. Repeated wrong outputs were byte-identical in the tested repeat pairs; a retry is not a repair.
- A date-only prompt can read the original interval correctly while a combined extraction prompt corrupts it. Reading the pixels and following the combined output contract are distinct acceptance requirements.
- Shortening alone is insufficient: the shortest Gemma status-only prompt still produces invalid labels outside the instructed enum. Qwen also fails that status-only interval question.

**Inspected, with no corresponding defect found in the reviewed paths:** completion slicing after the actual expanded prompt; per-request masks, positions and caches; serialized request disposal; Qwen image-token/DeepStack placement and mRoPE dimensions; Gemma packed embedding token order. Context guards reject oversized inputs instead of silently truncating them.

An earlier instrumented failed Gemma interval response stopped at 71 generated tokens, below the 96-token cap, with a final token matching configured EOS. That particular failure was not output-cap exhaustion. Termination was not instrumented for every subsequent call.

The pinned Gemma configuration's sliding-window layers make token placement a plausible contributor, but it also has full-attention layers. Successful/failing short probes rule out “the image fell outside a 512-token window” as a sufficient explanation. The subsequent Qwen reference comparisons below reproduced selected failures in the original full-precision CPU model: WebGPU and quantization are not necessary for those failures. They do not exclude every numerical/export defect or establish that conclusion for Gemma.

## Why weaker verification missed this

Successful generation and schema readiness do not mean source accuracy. The tested wrong outputs can still produce editable cards. Normalization can also hide a raw mistake, such as converting an unsupported `$` back to the expected USD. Testing only the two familiar images misses absent-evidence and different-heading cases.

The new diagnostic checkers therefore retain separate gates for runtime completion, strict serialization, independently transcribed raw evidence, card/confirmation values, and missing evidence. They preserve negative outputs and original expectations. Recorded-output unit tests check these gates; only fresh model inference checks the model's actual response.

### Durable recorded-output regression coverage

[The IOU fixture](../src/features/openchat/fixtures/recorded-shared-image-proposals-20260909.json)
now preserves 14 selected exact completions from the broad runs: nine positive controls and
five negative captures. Its SHA-256 is
`22ad7990ea6787dc4df6e7aec203349b5cc6797d8a877e27c6f9ad749559e76d`.
The two best-candidate model runs retain the same prompt identity; successes under different
prompts cannot be combined into a common-prompt pass.

[The focused tests](../src/features/openchat/recordedSharedImageProposals.test.ts) separately
assert visible-source values, strict JSON/calendar-only output, and real IOU normalization,
editable-card and confirmation values. Negative captures cover invented missing currency on
both models, wrong memo selection, an unsupported currency representation hidden by
normalization, and a lost decimal point. Mutation checks retain exact dates, missing fields,
empty endpoints, JSON validity and numeric types. The existing 28-case fixture is unchanged.
These unit tests do not execute OpenChat's host parser or a model; separately pinned historical
actual-host replays remain identified in the fixture. They do not add a runtime detector that
can independently know the contents of a new image.

The independent focused rerun passed **178/178 tests across three files**, including 54 new
tests. From the IOU repository with the existing installed dependencies:

```powershell
node node_modules/vitest/vitest.mjs run src/features/openchat/recordedSharedImageProposals.test.ts src/features/openchat/modelProposalContract.test.ts src/features/openchat/packagedTransformersAcceptance.test.ts --reporter=dot
```

A passing regression suite means the recorded mistakes are still classified as mistakes;
it does **not** change the failed fresh-inference qualification above.

## Evidence and next step

Local experiment artifacts are under `F:/Temp/OpenChat-IOU`, separate from production source. Key pinned records:

- Shared broad manifest: `admin/common-proof-broad-20260909.json`, SHA `2197598a96e160dd766c6e95a311a4d92014b346fe1511f19bb30fb6f294646e`.
- Frozen eight-image corpus: `admin/common-image-corpus-20260909.resolved.json`, SHA `d8b63be981cdb22d286f59aebadbc08a2f419a6daa3cb174321382650f040798`.
- Gemma broad result: `output/playwright/gemma-retained-cache-20260909-MRJHTg/result.json`, SHA `423f590bf9117b957d9c1f545e4df5cb28a59214e7da02d742c11430c5073dcf`.
- Qwen broad result: `output/playwright/qwen-production-full-model-20260909-voKRPY/result.json`, SHA `bda7b3d8016cebb11bb4ea5c266241f47d85e71b07b6b21d796209d47af855eb`.
- Corresponding current-card replays: `admin/current-corpus-replay-gemma-broad-proof-20260909.json` and `admin/current-corpus-replay-qwen-broad-proof-20260909.json`.
- Placement comparison: `admin/common-prompt-placement-diagnostic-20260909.md`; token/source audit: `admin/common-prompt-token-audit-20260909.json`.

The subsequent reference phase below compares frozen browser inputs and prompt tokens across the quantized CPU graph, a freshly fingerprinted WebGPU worker, and the original Qwen checkpoint. It separates behavior that requires WebGPU or quantization from behavior also present in the original model; it does not establish equality of every intermediate numerical operation.

The initial no-download feasibility check found no ready full-model reference. A subsequent
bounded diagnostic successfully loaded the **exact current Qwen decoder and vision graphs**
under native ONNX Runtime 1.24.3, without copying weights to disk. It retained the current
mRoPE/DeepStack transformations; stock session construction would omit the required transport.
Session-load receipt: `tmp/qwen-exact-native-cpu-load-20260909-MQDfhI/result.json`, SHA-256
`1e7193a317450f5aa66a10f18381cecfcf0511964971ad08af8427588fc2f61b`.

### No-download CPU behavior comparison

Three additional **CPU** inferences used the unchanged production DeepStack/tied-embedding
transport, pinned quantized graphs/weights, and exact processor inputs captured in a fresh
Chrome worker. The capture extracts production decode, processor-construction and template
source, verifies its dependencies against the production build receipt, and validates all
12 tensor files' type, shape, byte order and hashes. Capture receipt:
`output/playwright/qwen-reference-inputs-20260909-VfIgMW/result.json`, SHA-256
`bc474ffde5e97f4ff5bc923c4330595cf817db269ea7384ab20cf5d65fbca826`.
It wrote 11,677,992 tensor bytes; the browser/server closed with no recorded errors.

All three CPU raw completions are **byte-identical to the corresponding historical WebGPU
completions** under the shared `384c...` prompt:

- Arabic transfer: correct source fields, 69 generated tokens.
- Other real transfer: the same wrong `Living Expenses` heading selection, 58 tokens.
- Currency-free estimate: the same invented `$`, 53 tokens.

This reproduces the two failures without WebGPU, so a WebGPU-only fault is not necessary to
produce them. It does not establish numerical equality at each stage, rule out defects shared
by the exported graph, or prove the original unquantized model behaves identically. Native
ORT 1.24.3 uses disabled graph optimization and four intra-op threads here; the browser uses
Web ORT 1.29 and its default optimization. Historical WebGPU inputs were not fingerprinted,
so their byte equality to this new capture is not asserted. The subsequent fresh GPU run below
does establish input equality for its own three requests.

CPU driver SHA-256: `7a5fa46f0f87e6a112f447984d9b1cff966d0cff0aa616d85854d3c13c15508a`.
Its 24 offline transport/validation tests passed before inference. Individual result receipts:

- `tmp/qwen-cpu-reference-20260909-4531kz/dev-real-arabic-transfer.json`, SHA-256
  `8045952d386c41c3b5f121f2b8c4d3acd7a4dcbd5cf753d6edd07422b4a4f9d9`.
- `tmp/qwen-cpu-reference-20260909-bHH8oa/dev-real-english-transfer.json`, SHA-256
  `fe4292cdf7f65ee9b263269fa96d1763b4f2dabc416e5f3f46e091da26c56f34`.
- `tmp/qwen-cpu-reference-20260909-4nuz71/holdout-synthetic-missing-evidence.json`, SHA-256
  `094cf49f76609dc9136b6705002d14001e71304bbcbcf6172f5ef58605c2a7af`.

All three children exited successfully with zero active native sessions after cleanup. These
are diagnostic references, **not a production CPU fallback** and not additional WebGPU passes.
The user subsequently approved up to **8 GB additional project-temp storage** for reference
comparison. The pinned original Qwen checkpoint and fresh GPU comparison completed within
that allowance. Gemma's full quantized weights remain in retained browser CacheStorage.
No rejected prompt or production backend change has been deployed.

### Fresh GPU input identity

Three additional WebGPU requests used an instrumentation-only worker: a read-only sideband
hashes existing processor tensors immediately before inference. No input, generation setting,
graph transform or production source was changed. All **12 tensor hashes, shapes, types,
byte lengths and endianness**, plus all three formatted-prompt hashes, match the captured CPU
inputs. All three GPU raw completions are byte-identical to the quantized CPU and historical
GPU completions, including the two wrong fields.

Result: `output/playwright/qwen-production-full-model-20260909-luIgxH/result.json`, SHA-256
`791a3ced803511fff38d3e27aa2969c323daecb77870bfeb45f526c93cd96357`.
The owned process exited 0 and the browser/server closed. Its profile's sampled maximum was
1,956,363,910 bytes against a 2,000,000,000-byte allocation; post-close size was 1,863,904,807
bytes. The sampler is not a filesystem quota. The instrumentation adapter's 24 offline tests
passed. This adds three diagnostic GPU calls to the earlier 111, not three accuracy passes.

### Original unquantized Qwen comparison

Downloaded only the seven pinned original assets from `Qwen/Qwen3-VL-2B-Instruct`, revision
`89644892e4d85e24eaac8bacfd4f463576704203`. All lengths and official Git/LFS identities verified;
the 4,255,140,312-byte weight SHA-256 is
`7de1838c87a5349b016c26a1c3f7d2bc400a3d485f95ef39a7059ffd734977a0`.
The original DeepStack byte range also matches the retained production extraction. This does
not prove the conversion ancestry of every ONNX weight.

The original fast tokenizer reproduced **exactly all captured input token IDs**, including
160/160/154 expanded image tokens. The reference reused the four browser tensors unchanged;
it did not resize the images again. Original configuration and model implementation were
used with PyTorch 2.9.1+cpu, Transformers 4.57.6, float32 CPU/eager attention, four intra-op
threads, greedy decoding and the same 96-token cap/EOS IDs. Original BF16 weights expand in
RAM, not another disk checkpoint. This is an independent reference, not identical arithmetic.

All three requests completed in one 58.4-second owned process and exited 0:

| Case | Quantized CPU and GPU | Original checkpoint, float32 CPU |
|---|---|---|
| Arabic transfer | Correct source fields | Correct amount/currency/date; heading changes `تمت` to `تتم` |
| Other real transfer | Wrong heading `Living Expenses` | Same wrong heading; additionally misuses `11:59 AM` as an ending date |
| Currency-free estimate | Invented `$` | Invented `USD` |

Thus the wrong-heading and missing-currency failures **do not require WebGPU or quantization**.
The reference does not exclude additional export/quantization defects, or isolate the cause
of the different Arabic heading/date behavior. It does show that changing precision alone
does not repair this shared prompt. No comparable original-Gemma run has been made.

Original result: `tmp/qwen-original-reference-20260909-29utir0t/result.json`, SHA-256
`f711d502525d21481c5ace6506c0dd11c314281eb29debea6a16036f0e55a36b`.
The helper's 20 independent offline tests passed. Original assets retain about 4.262 GB;
the isolated Python runtime, receipts and one retained CPU wheel use about 0.729 GB.
The approved additional project-temp cap remains 8,000,000,000 bytes. All inference stayed
local. Pip's inherited `TMPDIR` briefly placed its own temporary files outside the project
subfolder; all 28 exact logged paths were already removed by pip. Future launches explicitly
set `TMPDIR`, `TEMP` and `TMP` inside the project.

### One-key interference probe

The next manifest changes exactly one key, `"note":` to `"heading":`, with all other prompt
bytes identical. Baseline SHA remains `384c...`; the new diagnostic prompt SHA-256 is
`498cb237ab9bad7fa5f320894208f0b167c5e80a6e5ad6a0c154fb9febb47dcf`. The manifest is
`admin/common-semantic-key-ablation-20260909.json`, SHA-256
`f0918352fe76af6f1765d53d43a310c6962ca1971a7abe7f1314b3691de2d2fa`.

Qwen completed three fresh baselines and three variants. The baselines reproduce the earlier
raw results. On the other real transfer, renaming the key changes the selected text from
`Living Expenses` to `Your transaction was successful 13,500 EGP`. This supports output-key
interference with the screenshot's literal `Note` field, but **still fails the exact heading
oracle** by merging the adjacent amount. The Arabic variant keeps the correct source fields;
the missing-currency variant still invents `$`. Do not count a renamed field as current
app-schema acceptance: no runtime schema or mapping was changed.

Qwen result: `output/playwright/qwen-production-full-model-20260909-oNjSpw/result.json`,
SHA-256 `45e6c9bf81c811bea2d64ae6e8591e353828c94fdfdba1d4cda15ae6d8eca208`.
Its owned process exited 0, source stayed unchanged, browser/server closed, and exact-path
cleanup removed 1,863,905,255 disposable profile bytes while preserving the result.

Two Gemma attempts (`Zr7ZWm`, `1EJpnl`) failed at the owned Edge CDP connection, before origin
verification, model-cache reads or inference. The browser exited with `0x80000003`; each
attempt ran **zero cases**. These are startup failures, not model-accuracy results. Retained
Gemma weights/profile were preserved. No additional retries or cache clearing are implied.

A third, instrumentation-only attempt added only stderr logging (`--enable-logging=stderr`,
`--v=0`) and reproduced startup failure with **zero inference cases**. Its bounded log now
identifies the immediate cause: Edge's GPU subprocess exits nine times with `-1073741790`
(`0xC0000022`, Windows `STATUS_ACCESS_DENIED`), followed by the browser's fatal
`GPU process isn't usable` check. The denied object or permission is not identified, and a
command-sandbox cause is not yet proven. Do not retry by disabling browser/GPU security,
clearing retained caches, resetting accounts, or modifying system permissions.

This was an explicit permission stop condition for the paired Gemma test. The 8 GB storage
approval did not authorize an execution change. The user subsequently separately authorized
one isolated rerun outside the command sandbox; its outcome is recorded below. Failed logging result:
`output/playwright/gemma-retained-cache-20260909-6BsLeO/result.json`, SHA-256
`d6433487f637870428886bc203d509b1bce925bb24e9d9fa2c1027810828f95d`.
The 4,047-byte owned stderr log has SHA-256
`98edcf36755d483b5e357ff0f98d896b8e040d8fcda762e07283cf2eb21d2aac`.
The owned launcher exited, proxy closed and retained profile was preserved. Microsoft's
[NTSTATUS reference](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-erref/596a1078-e883-4972-9bbc-49e60bebca55)
documents the access-denied code. No original-Gemma download, security bypass, global browser
change was attempted during the blocked phase.

### Separately approved Gemma rerun

The same frozen six-case heading-key diagnostic completed outside the command sandbox after
explicit user approval. The logging adapter, browser security arguments, model revision,
retained cache, prompts and generation settings were unchanged. Result:
`output/playwright/gemma-retained-cache-20260909-lYLbpe/result.json`, SHA-256
`958bfdecc85086427417c66a3ed930809dd7180149fad479916a2aadbc0020d4`.
This supports an execution-permission cause for the earlier startup failure; it does not
identify the exact denied Windows object or prove that the extraction errors were caused by it.

All six requests completed on observed hardware WebGPU. Both prompt versions correctly
extract the Arabic and English transfer headings, amounts, currencies and calendar dates.
Both still invent `USD` for the currency-free estimate and emit empty date fields against
the unchanged omission instruction. All six outputs are unfenced JSON. The heading-key
variant is a diagnostic contract, not an accepted change to the app's schema. In contrast
to Qwen, Gemma's heading selection is unchanged by this one-key substitution. There is still
no qualified common replacement prompt.

The owned process exited 0, the worker retired and terminated, browser/page/proxy closed,
source bindings remained unchanged, and retained cache keys were unchanged. No model was
downloaded or deleted; no account or app-card action was performed. The stderr tail is bounded
to 65,536 bytes. These six calls bring the investigation total to **144 desktop WebGPU
requests in 18 completed batches (61 Gemma, 83 Qwen)**, plus six CPU reference requests.
The three failed browser startups are not inference requests or accuracy results.

Currency-example priming is not a sufficient explanation. Earlier Gemma
currency-line-only probes already exist: literal-currency `f28...` omits a visible symbol on
the range image, whereas literal-empty-currency `532...` retains it and handles absent
currency. Both still emit empty absent dates against their unchanged omission instruction.
The missing Qwen comparison subsequently completed all six requests using the **same exact
earlier manifest**, not new prompt variants. Both currency-line-only prompts preserve the
correct Arabic amount/currency/date and the range amount/dates, but emit `USD` for the
printed `$` instead of the requested literal symbol and **invent `USD` for the currency-free
estimate**. Removing the examples or explicitly asking for an empty missing currency therefore
does not repair Qwen's failure. Correct IOU normalization of the visible dollar example is
separate from its violated literal-output instruction.

Qwen currency result: `output/playwright/qwen-production-full-model-20260909-o1AZxP/result.json`,
SHA-256 `2db2561f5445844ec9c8f453996273a3ee8f3c2aadbfea4619923f96777463b5`.
The owned process exited 0, all source pins stayed unchanged, browser/server closed, and
cleanup removed 1,863,893,696 disposable profile bytes without touching model downloads.
The two six-call Qwen batches are additional diagnostics, not new broad-corpus qualifications.

All completed Qwen runs' fresh profiles were removed after verified closure. The new
fingerprinted run's exact profile cleanup removed 1,863,904,807 logical bytes, preserving all
20 sibling evidence files and pinned sources. This disposable cache can be regenerated from
retained model files; it was not sent to the Recycle Bin. Result evidence, retained models,
the reusable Gemma cache and source images are preserved.

### Currency field-key controls: twelve additional Qwen calls

Two further six-request WebGPU batches compared four output keys on the same Arabic
transfer, dollar-denominated range and currency-free estimate. The baseline is the existing
literal-empty-currency prompt `5327d7735b5ee7f98e3b2f9ef027eef6298bd584d26087f0780460b86878e156`.
Each variant changes **only that field's key**; all instruction text, field order, missing-value
rules, image inputs and the 96-token cap remain unchanged. Independent checks reproduced the
four prompt hashes, manifest/result bindings and all 66 recorded source hashes in each batch.

| Output key | Arabic: printed `EGP` | Range: printed `$` | Estimate: no currency printed |
|---|---|---|---|
| `currency` (baseline `532...`) | `EGP` | `USD` — violates literal copying | `USD` — invented |
| `currency_text` (`cb4...`) | `EGP` | `""` — loses visible symbol | `""` — correct currency absence |
| `currency_as_printed` (`d53...`) | `EGP` | `$` — correct literal symbol | `USD` — invented |
| `currency_symbol` (`fe4...`) | `EGP` | `""` — loses visible symbol | `""` — correct currency absence |

All four keys retain the source amounts, headings and visible dates on these three cases:
12,900 EGP with `14 Aug 2026 09:47 PM`; 1,912.15 with `Sun, Jul 19` through `Thu, Aug 6`;
and the 72.50 estimate. This does not cover the separate wrong-heading English transfer.
All four estimate outputs still include empty date fields despite the unchanged instruction
to **omit both absent dates**. All twelve completions are Markdown-fenced, failing the
unchanged JSON-only requirement. Correct empty currency or correct IOU currency normalization
does not erase these independent failures.

The controlled key substitutions affect Qwen's raw currency selection, but none preserves
both visible-symbol copying and missing-currency handling across these cases. This is
evidence of output-key sensitivity, not an isolated explanation of every model error or a
qualified repair. Renamed fields are a **diagnostic schema**, not the current app contract;
no production schema, parser, prompt or worker was changed. These twelve requests are
additional runtime diagnostics, not additions to the earlier accuracy-pass count. No paired
Gemma currency-key result or phone acceptance is claimed, and no further naming variants are
proposed here.

Pinned records, relative to `F:/Temp/OpenChat-IOU`:

- `admin/common-currency-key-ablation-20260909.json`, SHA-256
  `2872e841a5daf0ef3ae2894dcb45a39b9dc65e5171279c5062fa78ac080759e6`;
  `currency_text` prompt SHA-256
  `cb4d67cb17f84037933dc341094ea1a795886da5098828b8b1946e56eb7bbf1f`.
- `admin/common-currency-two-keys-ablation-20260909.json`, SHA-256
  `73e7ab63dc3d2d65572c9cfa3765e8aa2bb7a74448fc2ecbc9ac7f83064ff8b2`;
  `currency_as_printed` prompt SHA-256
  `d53e2f1a830101f68600a88d3ceca6faa1bb41d2d7db5187a95d3e2a0301d687`;
  `currency_symbol` prompt SHA-256
  `fe4050a5cf1e0ad445d687d8bce37ab6b9f31894eaae41c85149b5c5f7cfc5aa`.
- `output/playwright/qwen-production-full-model-20260909-WFx3ry/result.json`, SHA-256
  `2cc785424ddbc32e0f41c47ebdf27d9083907ea4d723234240497562b37c062e`.
- `output/playwright/qwen-production-full-model-20260909-ymYbXl/result.json`, SHA-256
  `1593cd8c86e49acf4efaea90e45b5deb05093f9cf95ad76cd2e7d2da088a11f7`.

Both receipts record six completed cases, hardware WebGPU, unchanged sources, no errors,
worker retirement/termination and browser/server closure. Both exact disposable
`browser-profile` paths were independently observed absent afterward. The inference receipts
themselves say profile deletion was deferred to separate cleanup, so this review does not
infer freed-byte totals or a deletion audit from those receipts. The result files remain.

### Independent RGB-to-tensor comparison

The original-model inference reused browser tensors, so it did not independently validate
image preprocessing. A new diagnostic captured opaque RGB bytes immediately after the exact
production bounded decode, **before** the JavaScript processor's mutable RGB conversion.
It neither reconstructs RGB from model tensors nor changes the image. All twelve newly
computed JavaScript tensor hashes, types and shapes, plus formatted prompts and size metadata,
match the frozen reference capture exactly. Only three RGB files were retained: 1,456,128
bytes total, with no duplicate tensors, model weights or worker bundle.

The installed original Transformers 4.57.6 **slow** `Qwen2VLImageProcessor` processed those
RGB arrays independently with `do_resize=False`, explicit original configuration, patch size
16, temporal size 2, merge size 2 and mean/std 0.5. Its output matches the browser's
**2,912,256 float32 elements and all three grids bit-for-bit**: zero changed elements,
maximum error 0 and RMS error 0. Separate channel/patch-order and repeated-frame checks pass.
No numerical tolerance or inverse reconstruction was used to declare this exact match.

This clears the tested RGB-to-tensor normalization and packing stage against that original
implementation. It does **not** independently validate browser JPEG decoding, orientation,
bounded resize/information loss, or the checkpoint-configured Fast processor (torchvision
was not installed). It is not another inference or a common-prompt accuracy pass. Because
the independently produced inputs are identical, repeating the original-model inference on
them would not provide a new input comparison.

Both owned commands exited 0; capture browser/server closed and all bound source/input files
remained unchanged. Root reran **8/8** capture-helper tests and **28/28** comparator tests,
including changed hash/type/shape, nonopaque pixels, channel/temporal swaps, one-ULP and
signed-zero negative controls. No browser-security change, download or production edit was
needed for this preprocessing comparison. Pinned receipts:

- `output/playwright/qwen-rgb-comparison-20260909-zlKCd3/result.json`, SHA-256
  `4544d80ce625544edbe3e26a1b3dcc09677ab4ccbc1d4fccd2eb497343b356b0`.
- `output/playwright/qwen-rgb-comparison-20260909-zlKCd3/original-processor-comparison.json`,
  SHA-256 `4150d4967b463572336254af36016a8b213004930d2dbd001435e2016c2c2972`.
- Capture adapter SHA-256 `261b63f12c46e431020cf373f1cc4ce390ab48b94782ca914dc789acd593fa09`;
  original comparator SHA-256 `ef70ca4c08e5dffe817003909d30f009f7e523f3317c3bf1ac2a011050ae2e1f`.

### Fixed evidence skeleton: rejected after Qwen

One new app-owned diagnostic combined a fixed six-key JSON object, visible evidence before
classification, literal currency copying and explicit empty strings for absent text. Its
1,556-byte prompt is `admin/common-evidence-skeleton-20260909.prompt.txt`, SHA-256
`64b875782ed2eb31c5382d6386024dd57223d5391d4e7b9c6ce7809a07e846db`.
The candidate policy was frozen before inference; it does not retroactively change previous
omission, formatting or evidence expectations. This tests the combined contract change,
not a claim that the skeleton alone causes any result. No production schema was modified.

Ten actual Qwen WebGPU requests covered the same eight regression images and repeats of the
two original images, with unchanged production image budget, worker and greedy 96-token
generation. All amounts and date values were correct under the candidate's explicit-empty
policy. However, only **3/8 distinct cases** passed literal-field and actual card/confirmation
checks (**4/10** including repeats):

- The real range and synthetic workshop were incorrectly classified as completed payments.
- The English transfer still selected the later memo instead of the uppermost heading.
- The paper example selected the wrong heading and read `EGP` as `GBP`.
- The currency-free estimate still invented `USD`.
- The real range returned `USD` instead of its printed `$`; correct app mapping does not
  erase the candidate's literal-copy failure or the independently wrong payment classification.

All ten outputs were Markdown-fenced, so **0/10** passed the exact JSON-only skeleton contract.
The repeats were byte-identical, including the incorrect range output. The candidate was
rejected and **not run on Gemma**, because it already cannot qualify as a common prompt.
No unused holdouts, phone acceptance or production changes are claimed.

The separate candidate-bound assessor reuses the unchanged historical checker and real
current host/app card and confirmation construction. Its seven offline tests pass; original
scores remain in the report. This is not an authenticated iframe, private saved-type/direction,
delivery or UI test, and schema readiness cannot establish absent source evidence. Records:

- Manifest SHA-256 `d9802465e4f132c38685cf31b9a6de9746ecb6f72b1b3a40a288b1e9494c6582`;
  candidate-policy SHA-256 `e00a5a7c71e4ba2b1c4a8de5c9b26b88b5c96206425edc07f1151db17873ed03`.
- `output/playwright/qwen-production-full-model-20260909-7SwPW4/result.json`, SHA-256
  `804515291597e061d86fb3ae15f3788b6bd1fb3f5c47c12bb1dd0c9a21af51ea`.
- `admin/evidence-skeleton-assessment-qwen-7swpw4.json`, SHA-256
  `0f02d3b9dafdffeb75f86dcdfc4a33b83f2a38b4e137fbcecba10108df817684`.
- Assessor SHA-256 `c023cdf70f996392737e74c6cb35c1e777912c7723d6997f7474e19749e96604`.

The owned run exited 0, browser/server closed and bound sources stayed unchanged. Separate
cleanup removed exactly its regenerable browser profile: 1,868,332,881 logical bytes,
preserving the result, retained models and reusable Gemma cache. The deletion evidence comes
from that separate cleanup receipt, not the inference result. Investigation totals are now
**154 desktop WebGPU requests in 19 completed batches (61 Gemma, 93 Qwen)**, plus six CPU
reference requests. Runtime completion is not source accuracy or release qualification.

### Original source images at native processor resolution

The next two CPU requests keep original Qwen weights, float32/eager implementation, four
threads, the exact `384c...` prompt and greedy 96-token generation unchanged. Instead of
reusing browser-bounded pixels, Pillow decodes each original source and the original slow
processor applies its native resize configuration. Decoding, resampling and retained
resolution change together; this comparison does not isolate resolution alone.

| Case | Source / processed dimensions | Image / total input tokens | Result versus earlier original CPU |
|---|---|---|---|
| Other real transfer | 809×1280 / 800×1280 | 1,000 / 1,444 | Now copies `Your transaction was successful`, `13 Aug 2026` and empty end date; previously selected the memo and put `11:59 AM` in the end-date field |
| Currency-free estimate | 820×620 / 832×608 | 494 / 938 | Byte-identical incorrect response: invented `USD`, with empty date fields against the unchanged omission instruction |

The transfer's amount, currency and payment classification remain correct. Both responses
remain Markdown-fenced, so neither satisfies the unchanged strict JSON-only instruction.
The 66- and 54-token completions both end at configured EOS, below the cap. This locates a
transfer-field sensitivity in image preparation, while showing the absent-currency failure
survives this larger-input comparison. It is not a qualified prompt, a production image-budget
change or an all-WebGPU/phone acceptance result. The next focused comparison changes only
the original processor pixel budget for the same decoded transfer pixels.

The owned process exited 0 in 133.344 seconds. Its 20 GiB free-RAM admission guard observed
39,560,699,904 available bytes; the guard is not a hard process-RSS limit. Both requests
fit the 2,048-token input-plus-output diagnostic bound. All 58 source/input pins and the
original weight hash were unchanged afterward. No model, image tensor or browser cache was
duplicated on disk; the completed run retained 95,538 bytes of metadata, raw outputs and logs.
Root independently reran all **21/21** focused helper tests. Records:

- `admin/qwen-original-native-images-20260909.py`, SHA-256
  `38ac1c390fc61ad4a3336d9cee7eb5ffb7c78543fa12256b9b9836ebd1701989`;
  test SHA-256 `84f70270934e5c429569bf2e4dabbaea0c6fb8a63d5ef78fe23b9317ca1f9ef7`.
- `tmp/qwen-original-native-images-20260909-rfhuf1gq/result.json`, preprocessing-only
  validation SHA-256 `330b2edb8f66ee1cad84388a78105d846ceecc3d10ba5633e07a5878f1eb32ce`.
- `tmp/qwen-original-native-images-20260909-7tjf_810/result.json`, inference SHA-256
  `6602fe60fe796d83199b28257a88c5367d8169bc7a6942c9521a0c0a7020a146`.

Totals remain 154 desktop WebGPU requests in 19 completed batches, now plus **eight CPU
reference requests**. These CPU requests cannot count toward production backend acceptance.

### Pixel-budget-only control on the other real transfer

One further original-CPU request changes only the original slow processor's `max_pixels`
from 16,777,216 to 163,840; `min_pixels` remains 65,536. The original source's Pillow-decoded
RGB hash, processor class/resampling/normalization, prompt, all non-image token IDs, checkpoint,
runtime and greedy generation match the preceding native reference. The processor selects
**320×480**, with 150 image tokens and 594 total input tokens. This is deliberately not a
claim to reproduce the browser's distinct 320×512 frame or its decoding/resizing.

The heading remains correct (`Your transaction was successful`), as do amount, currency,
payment classification and start date. The model again puts **`11:59 AM` in the end-date
field**, instead of an empty string. Thus the pixel-budget intervention changes endpoint
selection in this controlled original-processor comparison. It does not explain the browser
path's additional wrong-heading selection, prove that every failure is resolution-related,
or isolate lost visual detail from the changed image-token geometry that accompanies resizing.
It does not justify increasing the previously constrained phone GPU budget. The missing-currency case
was not rerun in this one-case control. The response remains Markdown-fenced and stops at
73 tokens with configured EOS, below the unchanged 96-token cap.

The owned process exited 0 in 47.906 seconds. All 56 bound source/input hashes and the original
weight hash stayed unchanged. Both decoded-RGB and non-image-token controls verified. Root
reran **7/7** focused adapter tests; this run retained 40,691 bytes of metadata/logs and no
model weights or tensors. Records:

- `admin/qwen-original-native-budget-20260909.py`, SHA-256
  `b4ea262558da1a92334e3cc599058c0d830313fba629fd398a978330162653e2`;
  test SHA-256 `7bdd35f77a9178bc2973df8ec852beabf4255483d85d19505758fa7994f7ca07`.
- `tmp/qwen-original-native-budget-20260909-1e7ewfq3/result.json`, validation SHA-256
  `6b043d89646e643430985d499a8993017632f214944f951eb5bdb0b088b82b62`.
- `tmp/qwen-original-native-budget-20260909-d4fpj95z/result.json`, inference SHA-256
  `1fca6fd68e0978267a4fd2d34824c750125261c74fe8882fcc53d1fabbbfd0d7`.

Totals remain **154 desktop WebGPU requests in 19 completed batches**, now plus **nine CPU
reference requests**. No new common prompt, production image budget, app registration, worker,
APK or fallback was adopted. Further cause testing must keep the remaining wrong-heading and
invented-currency failures separate from the endpoint sensitivity established here.

### Currency task isolated from the other fields

Two original-Qwen CPU requests reuse the exact native currency-free image, including decoded
RGB, resized 832×608 pixels and image-grid hashes. The first repeats full `384c...`; the
second asks only its exact existing currency instruction, with a minimal JSON preamble.
The currency key, symbol mapping, omission policy, checkpoint, processor and greedy decoding
are unchanged. Removing the other tasks also changes prompt length; this does not isolate
task semantics from token positions.

The full control reproduces the earlier incorrect response byte-for-byte, including `USD`.
The isolated task returns **`{"currency":"USD"}`**, despite no currency being printed.
The two responses stop at 54 and 6 tokens respectively, both at configured EOS. Thus the
combined multi-field task is not necessary for this missing-currency error. This does not
prove a general recognition failure, isolate mapping-example priming, or qualify the isolated
prompt. A shorter response and valid JSON do not make its invented field correct.

The owned process exited 0 in 78.578 seconds; all 57 bound source/input hashes and the weight
hash remained unchanged. Six focused adapter tests pass. Only 79,521 metadata/log bytes were
retained, with no weight download or persisted image tensors. Records:

- `admin/qwen-original-native-currency-20260909.py`, SHA-256
  `0246e2343c56e2fde3ab225c8f011daba85e67979f80b53464c5473ef24f31df`.
- Isolated text SHA-256 `1f9c6edcab42c51d53cd3a2438879cc4cbcbdeb76c0445f69f43d74ad643d0ba`;
  frozen prompt artifact SHA-256 `6576fa3445aa7b4a48be69cea9709b5b088cec16ce07b4d43bcfeff06f52f45b`.
- `tmp/qwen-original-native-currency-20260909-3t4gtews/result.json`, SHA-256
  `52d87de64565360bd6958d94577d569380c36b0abd7452c685dc2ef9b6e59bf7`.

At this point the investigation has 154 completed desktop WebGPU requests in 19 batches,
plus **eleven CPU reference requests**. No CPU result qualifies the production backend.

### Combined monetary evidence and heading contract — rejected

The next app-owned diagnostic makes three changes to the strongest `384c...` prompt:
it asks for the top heading under `heading` with a tighter boundary instruction; replaces
the separately selected currency with literal `total_text` alongside the still-required
numeric amount; and prospectively requires both missing date strings to be empty. The
original omission policy and older scores are unchanged. The candidate prompt and exact
eight-image source expectations were frozen before inference, identically for both models.
No IOU adapter or production schema was implemented for these diagnostic fields.

Ten Qwen requests completed on the unchanged production worker and phone-sized image budget.
All ten preserve numeric amounts, headings and the declared visible/absent date evidence.
The remaining source failures are substantive:

- The Arabic successful transfer is incorrectly classified as `iou`, on both attempts.
- The real range loses its printed `$` from `total_text`, on both attempts.
- The paper receipt loses its printed `EGP` from `total_text`.

The other five distinct inputs match all source fields, including the English transfer's
heading/timestamp and the currency-free estimate's genuinely absent currency/date. Overall
source accuracy is **5/8 distinct images and 5/10 calls**. Seven responses are Markdown-fenced;
the three unfenced responses have currency errors. Consequently **0/10** satisfy the entire
raw contract. This is raw evidence assessment only: there is no implemented adapter or
current-card acceptance result for this candidate. The candidate was rejected before spending
another Gemma run or any of the unused holdouts. Successes from different prompts are not
combined into a common-prompt pass.

The root-owned process exited 0; browser/server closure, hardware WebGPU observation and
unchanged source bindings are recorded. Exact-path cleanup subsequently removed only its
disposable browser profile: 1,868,099,610 logical bytes (1,868,316,672 observed free-space
increase). Retained downloads and the result hash were preserved. That cache is regenerable
from retained model files, not recoverable from the Recycle Bin; the cleanup receipt is
separate from the immutable inference result.

Frozen records under the project-temp root:

- `admin/common-combined-money-heading-20260910.prompt.txt`, SHA-256
  `d18cb22a7638821b955a2f50c63b12a53ed8f6551b23393b03e4f43183e5d973`.
- `admin/common-combined-money-heading-20260910.json`, SHA-256
  `6eab860da9effec35dde8d5a5b94784d2b8b67b027b8bf373210ec13fe7a2aec`.
- `admin/common-combined-money-heading-20260910.policy.json`, SHA-256
  `b66009e27261232d21986215d94ed279fd7ba7900fe6d2971a0ca7e1d768c4d6`.
- `output/playwright/qwen-production-full-model-20260909-d7ssp9/result.json`, SHA-256
  `fa44d4adcf8ecdd0c77773ebda5084c76224837ff477dee8374b501437137287`.
- `admin/combined-money-heading-assessment-qwen-d7ssp9.json`, SHA-256
  `8667a7bcb78d14992650f016bc61bb284c0da6a4920c1b6621304dae1f46622c`.

The final offline raw assessor passed **8/8 focused tests** and verified the recorded
source/worker/ONNX graph hashes without rereading external weight shards. Its first assessment
attempt stopped before writing a report because the source-path guard incorrectly excluded
the already-frozen user images. An exact image-path-and-digest exception and negative tests
corrected the checker; no Downloads-wide allowance or extraction expectation changed. The
final assessor SHA-256 is `f03c475eadee0115d775d8f55d585b8926a738acf5f59d61cf3e036b28ade92a`;
test SHA-256 is `fc30a0668b7a257049007c90ff4c4487197a8a7ae4facbb1d0db90c145b35a75`.
Passing checker tests means these model failures are correctly rejected, not repaired.

This comparison demonstrates another prompt/context intervention, not an isolated explanation
for each error: the three contract changes occur together. A useful next bounded diagnostic
would compare these two already-frozen prompts with frame-fill versus aspect-preserving
content inside the same selected frame. Holding the frame/grid fixed would preserve image
token counts while testing layout/resampling sensitivity, without a crop or larger phone GPU
budget. At this phase that comparison was unrun; its subsequent result follows. It is not a
proposed production change.

### Fixed-frame layout × existing prompt comparison — no universal fix

Eight Qwen calls used the exact two existing prompts and the two original user images, with
one diagnostic worker. The original frame-selection function, model revision/weights, native
chat template, greedy generation and 96-token cap were preserved. Seven reversible source
edits added an explicit test-only layout selector and bounded hash telemetry; production files
were not edited. This is an instrumented diagnostic worker, not an unchanged shipped worker.

The Arabic image retained its **320×512 / 640-patch** frame; the contain variant drew the
complete image at **291×512**, centered at x=14. The range retained **352×448 / 616 patches**,
with contain drawing **352×437**, centered at y=5. No crop, larger GPU budget, alternate
backend, OCR, model download or second model pass supplied either input.

Both runtime and independent offline controls passed: the actual image grids, input token
IDs and attention masks are identical within each image/prompt pair across layouts. Actual
bounded RGBA and processor pixel tensors are identical across prompts within each layout,
but differ between layouts. Encoded dimensions match the frozen images; the observed selected
frames match the current production function. No decode fallback was taken. These checks use
recorded input hashes, not equality inferred from configuration alone.

| Shared prompt | Frame-fill: exact source fields | Contain: exact source fields |
|---|---:|---:|
| Existing proof/heading-second (`384c...`) | 2/2 | 1/2 |
| Combined money/heading (`d18c...`) | 0/2 | 1/2 |

The differences are not formatting-only failures:

- Under the proof prompt, contain changes the range amount from **1912.15 to 191215**.
  The Arabic output remains byte-identical and source-correct.
- Under the combined prompt, contain changes the Arabic classification from incorrect `iou`
  to correct `settlement`. The range output remains byte-identical and still omits its visible
  `$` from `total_text`.
- All eight headings and date/end-date fields match the predeclared visible-source policy.
  Six outputs are fenced; the two unfenced outputs have missing-currency evidence. Thus source
  correctness is **4/8 calls**, strict serialization **2/8**, and both together **0/8**. Existing
  host parsing accepts all eight. Fences alone are not reported as wrong end-user values.

This demonstrates layout-associated output changes while excluding changed token IDs/grid
size as their explanation in this comparison. It does not separate resampling detail from
spatial placement, or recognition from interpretation. All four frame-fill calls precede all
four contain calls, with one observation per cell: session/order effects have not been
independently excluded. Both prompts already failed broader checks, and only two familiar
images were used here. No common prompt, general accuracy, Gemma, current-card or physical-phone
acceptance is established. In particular, the one improved classification is not grounds to
ship containment while ignoring the new monetary error.

The root-owned process exited 0. Hardware WebGPU, runtime retirement, browser/server closure
and unchanged production-source bindings verified. The root reran **16/16 builder/adapter
tests** and **7/7 offline-assessor tests**; tests check deliberate bad inputs/provenance as well
as valid controls. The assessor independently rehashed source/ONNX graph files, not external
weight shards. Exact frozen timestamp spelling was restored in the policy before inference
after a JSON round-trip normalized `.000Z` to `Z`; no date value or expectation changed.

Records under the project-temp root:

- Manifest `admin/common-prompt-layout-factorial-20260910.json`, SHA-256
  `faccddfb0e65c37d635b53962f147a3e58137b832e083803aa1f938bd22c4425`;
  policy SHA-256 `da893dbc72c994dfc0435e0eb4e431d75b47daa60ce2a23a30e1f82903ac808d`.
- Builder `admin/build-qwen-fixed-frame-diagnostic-20260910.mjs`, SHA-256
  `c0e8abd36fa47836875a8953ab2692a52c3628213d48c00ebf5fe53b062ac947`;
  adapter SHA-256 `8ee4fb45aefb9d81951492c1425d4e12100865ae75765c7e7907f0862e1f9e93`.
- Build receipt `tmp/qwen-fixed-frame-diagnostic-worker-only-20260910-joRaIo/build-summary.json`,
  SHA-256 `ed2952990389ca4f14171ba7877568275418d22a9dd72c8f23471ad90d29a418`;
  worker SHA-256 `541842d89b9225280bd698dd4eaac0800eb73ce2e83149f26991010520a30cd1`.
- Result `output/playwright/qwen-production-full-model-20260909-4kyzEZ/result.json`, SHA-256
  `97d307f9a9ca30f4fa21135550f03027ce87687b2ad4c0293fc9aaa00b4a5588`.
- Assessment `admin/prompt-layout-factorial-assessment-qwen-4kyzez.json`, SHA-256
  `1da8772b8b95c97cb0d7de9ec92a7763a407c06530b42aac8e6006b3d4bf7ec1`;
  assessor SHA-256 `0084db323db28f251d034751b9ded8b0c8b6199f599458d391ab209456b570f0`.

Separate immediate post-closure cleanup removed only this run's disposable profile:
**1,868,098,126 logical bytes**, with an observed **1,868,312,576-byte** free-space increase.
The immutable result, original images and retained models were preserved. The profile can be
regenerated from retained models; it was not sent to the Recycle Bin. No worker, app contract,
APK, registration or server deployment changed.

### Direct questions and null absence: rejected after Qwen

A new 1,501-byte shared diagnostic retained the six existing field names but used direct
field questions and explicit JSON `null` for absent currency and both absent dates. A visible
single date still required an empty-string ending. Prompt, manifest and prospective policy
were frozen before inference; none of the historical source oracles was edited. This changes
several instructions together, so it does not isolate null encoding as the sole cause.

Before inference, current host/app replay confirmed that entirely absent optional fields can
be represented by null without inventing defaults. It also confirmed the important boundary:
the host removes a null ending field before IOU receives it; IOU then rejects the incomplete
printed-date pair. A valid single date therefore still needs an explicit `""` ending. Do not
weaken that check to silently repair this candidate: doing so would also hide incomplete ranges.

All ten Qwen calls (the eight regression images plus original-pair repeats) completed on
observed hardware WebGPU with the unchanged production worker, image budget, greedy decoding
and 96-token cap. **0/10 matched the prospective source-field contract and 0/10 matched the
actual current card/confirmation values**; this is also 0/8 distinct images. In particular:

- Arabic, English and Spanish single-date outputs used a null ending, losing the card date.
- The range, workshop and unpaid-hire examples were misclassified as completed payments.
- The currency-free estimate invented `USD` and `2023-04-05`. The card retained the wrong
  currency/classification; its malformed date pair was rejected, not accepted as evidence.
- The English example still selected the later memo rather than the heading.
- The paper example copied the receipt body into the note and ended with incomplete JSON.
- Both repeated completions were byte-identical to their first attempts.

All outputs were fenced; nine were accepted by the existing parser and reached editable
cards, while the incomplete output returned `no_extraction`. These formatting/runtime results
are separate from the content failures above. No Gemma or unused-holdout run is justified for
this already-failed common candidate, and no candidate was registered or deployed.

The candidate assessor reuses the actual unchanged host, app normalization, card and
confirmation path. Root reran **7/7 offline tests**, including twenty correct constructed
replays across both model identities and negative evidence/format/provenance checks. These
constructed positives prove checker/pipeline behavior, not fresh model success. An initial
test incorrectly assumed the host rejects numeric strings and its existing `paid` alias;
inspection and replay showed they normalize correctly. That test now explicitly distinguishes
raw-contract rejection from correct card normalization; no production behavior was changed.

Records under the project-temp root:

- Prompt `admin/common-question-null-20260910.prompt.txt`, SHA-256
  `bd3a4e6b9ed62d011a8704b5f829e3a6a8c0ec1893d6de678f9b26138e2a3a82`.
- Manifest `admin/common-question-null-20260910.json`, SHA-256
  `a5c7374af8b319dd8ded2789868d3a70e98d10376f3ad672699b695015f696a2`;
  policy SHA-256 `04e214047033a1728167b2c28d4b76579e41e8c73652381020cf6a64eb700d08`.
- Result `output/playwright/qwen-production-full-model-20260909-64lwHR/result.json`, SHA-256
  `266d8644f6e064cb7adaf3b4635c46fd8b3715af30a0561ae964aa7866e90a92`.
- Assessment `admin/question-null-assessment-qwen-64lwhr.json`, SHA-256
  `fbdc4566294d1a3f01da80414e8846adae36441f9b8bc76db4766494c9c9b123`;
  assessor SHA-256 `5636dfcfa617e62758d0687007491578e1e2cf88f500cc9da4c0e79611f78693`;
  tests SHA-256 `cfcc6f3bef63623c894e8196e322a55477161c22ce64426be4751f87b100fe2f`.

The owned process exited 0; worker retired/terminated and browser/server closed. Immediate
exact-path cleanup removed the regenerable browser profile: **1,868,151,094 logical bytes**,
with **1,868,369,920 observed free bytes reclaimed**. Result SHA remained unchanged; original
images and retained model downloads were not removed. No production worker, app prompt,
registration, server or APK changed. The release accuracy gate remains unmet.

### App-owned aliases and mapped currency: four-image screen rejected

The next prospective contract used `heading` and `currency_text`, with two in-memory,
app-authored schema aliases to the existing `note` and `currency` fields. The original
approved symbol mapping was retained: a visible `$` could produce `$` or `USD`, while no
visible currency required `""`. Both absent dates also required `""`. Prompt and expectations
were frozen before inference; earlier literal-only policies and recorded oracles were not
relaxed. This joint combination is not an isolated causal comparison. Its completed-payment
instruction was already present in the earlier combined-money candidate, not newly restored.

Four previously used images completed on observed hardware WebGPU with the unchanged
production worker, image budget, native template and greedy 96-token limit:

- Arabic transfer: correct 12900 EGP, heading and single-date pair.
- Range image: correct 1912.15 USD under the predeclared symbol policy, heading and endpoints.
- English transfer: otherwise correct, but heading was `Your transaction was successful
  13,500 EGP`, including the adjacent amount and currency.
- Currency-free estimate: correct amount, heading and empty dates, but invented `USD`.

Thus source fields and prospective app-card/confirmation values passed **2/4**. All four
responses were fenced JSON (**0/4 strict serialization**), but the existing host accepted
them; formatting tolerance is separate from incorrect content. Without the proposed aliases,
the unchanged production app lost the alternate fields and passed **0/4 card comparisons**.
The aliases were tested only in memory, not installed or registered. No raw output was
rewritten, required field relaxed or missing currency supplied by the checker.

The actual generic host, IOU normalization, card and confirmation constructors were replayed
offline. Root independently reran **15/15 alias tests** and **7/7 assessor tests**, including
constructed positives for both model identities, conflicting/equal aliases, invalid types,
missing evidence and provenance failures. Optional-field alias conflicts remove that field;
they do not necessarily reject the whole editable proposal. These tests establish interface
behavior and correctly detect bad model answers; they do not qualify model accuracy. An
independent review found no weakened source requirements.

The predeclared four-case advance gate failed. No broader corpus, Gemma, unused holdouts or
phone run followed, and no production prompt, schema, worker, server or APK changed.

Records under the project-temp root:

- Prompt `admin/common-mapped-aliases-20260910.prompt.txt`, SHA-256
  `c25af49a96ad8b44895a812033b78a9f27058be3f3b60c2c49f94c13c406c92b`.
- Manifest `admin/common-mapped-aliases-screen-20260910.json`, SHA-256
  `690af468a22ad31fb3144c0336da3295e764133b096a6067815e3c59891246e5`;
  policy SHA-256 `0565c3c6707c8869d7534ff500d3d8ba89dca2464bcf4ad4eb41782d5888084e`.
- Result `output/playwright/qwen-production-full-model-20260909-X7jota/result.json`, SHA-256
  `48df91d61058e05ce46bde17e2aad62f9155b56657b817b2b0b5801bd8b88bc8`.
- Assessment `admin/mapped-aliases-assessment-qwen-x7jota.json`, SHA-256
  `673c65e12b57b2e5645d3f4ffe0cbb54da0cbd86146c5eaaf6f361c94d595b3f`.
- Alias replay helper SHA-256
  `da482309479bd7d16c2319b82307ec5826d4f2825ab204a0930d92141a799032`;
  assessor SHA-256 `648197e3c3307325b2bc88efb0dfcfdc1f2eb2e9eda4fa99a8076edf091f60b7`.

The owned process exited 0, retired/terminated its worker and closed the browser/server.
Cleanup removed only its regenerable browser profile: **1,863,903,752 logical bytes** and
**1,864,118,272 observed free bytes reclaimed**, not sent to the Recycle Bin. Models and
immutable evidence were retained; result, production manifest, worker and APK hashes verified
unchanged after cleanup. The shared-prompt release accuracy gate remains unmet.

### Contrastive absent-currency example: targeted improvement, not a common solution

The next four-image screen appended only a 101-byte suffix to the original literal-currency
instruction in the existing `0ba65...` prompt. All earlier instruction bytes, field names,
order and absence rules were unchanged. The suffix contrasted `Total CHF 8.20` with `Total
8.20`, copying the former unit and leaving the latter empty; neither example was image
evidence. Invented example values were explicitly negative test cases. The resulting prompt
was 1,951 bytes. No equivalent contrastive example was found in the 25 prior unique common
prompt texts reviewed. Simple removal of currency mappings was already tested and had failed;
this experiment did not treat map priming as the established cause.

With the unchanged production worker, native template, image budget, greedy decoding and
96-token cap, all four Qwen calls completed on observed hardware WebGPU:

- The currency-free estimate now returned exact empty currency/dates, 72.5 and the correct
  heading/classification. Previously this exact base prompt returned invented `USD`.
- The range still omitted both dates and returned `USD` despite the literal `$` instruction.
- The Arabic transfer still returned `iou` instead of `settlement`.
- The English transfer still selected the visible `Living Expenses` memo instead of the
  diagnostic prompt's required heading. This is wrong selection for that prompt, not invented
  text; see the product-scope distinction above.

The last three raw answers are byte-identical to the first corresponding outputs in the exact
base prompt's `LBSCcX` run (result SHA-256
`c53f23e3189f9d332ac6c904fd51517274fd890d536ec86366e72f889e3f532b`). They are continuing failures,
not regressions attributed to the examples. The missing-currency difference supports a useful
instruction-level intervention for that case, not a universal cure; the runs used different
case orders, with no randomized or repeated comparison in this new screen.

Exact source fields and unchanged actual host/app-card/confirmation values passed **1/4**.
All four answers were fenced, giving **0/4 strict serialization**, separately from content.
No example value leaked. The predeclared advancement gate failed: no broader corpus, Gemma,
unused holdout, registration or phone deployment followed. A passing absent-value case cannot
be combined with successes under a different prompt to claim one qualified common prompt.

The root independently reran **5/5 offline assessor tests**, covering example leakage, exact
source values, absent fields, shape, eight constructed correct card replays across both model
identities, and twelve provenance mutations. Production code and old oracles remain unchanged.

Records under the project-temp root:

- Prompt `admin/common-contrastive-currency-20260910.prompt.txt`, SHA-256
  `fd9b1123cc808a1410e10819e01270af9e220abe31cb83fd0225845f235df584`.
- Manifest `admin/common-contrastive-currency-20260910.json`, SHA-256
  `0011bf4350db647cf8efe200d1d80044332115d90f0351afe29614f449472ce7`;
  policy SHA-256 `1f3acee9ab1e2a850c9a8c1330156e02231146c3bebb57d29dc5553f1d7b5f47`.
- Result `output/playwright/qwen-production-full-model-20260909-I6lr9m/result.json`, SHA-256
  `d8e58963ea325bbac289d21333d54efe48393181ad5f1f76162fad7190cb2ee4`.
- Assessment `admin/contrastive-currency-assessment-qwen-i6lr9m.json`, SHA-256
  `1b2e47f2f9d12947530038a39671ae1997d2563e3e2f08642af186eea4926b16`;
  assessor SHA-256 `2d09296d03742a2af994e019f9e2f7b494a59d145c707b62c9e825d2a8581992`.

The owned process exited 0 and retired its worker/closed the browser and server. Exact-path
cleanup removed **1,863,909,649 logical bytes**, with **1,864,126,464 observed free bytes
reclaimed**. This was only the regenerable browser profile, not sent to the Recycle Bin; retained
models, original images and immutable results remain. Production worker, prompt and APK were
not modified. The release accuracy gate is still unmet.
