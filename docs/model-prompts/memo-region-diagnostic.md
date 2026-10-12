# Arabic memo: full image versus focused region

## Result — 11 September 2026

All four desktop WebGPU calls completed, but **none extracted the printed memo**.
This is a narrow diagnostic, not full extraction, card, phone or release qualification.

| Model | Full original image | Existing focused region |
| --- | --- | --- |
| Qwen3-VL 2B | Account/party details | Reference number |
| Gemma4 E2B | Total-amount label | Note label `ملاحظة` |

The expected value is `نفقات المعيشة`. The independently transcribed expectation was
not changed. All replies contain complete, parseable note objects; factual checks reject
the wrong values instead of treating valid JSON as success.

## Controlled inputs and interpretation

Both models received the same English memo-only prompt, unchanged between their two
calls. The expected answer was kept outside the prompt and browser request. Each call
used a fresh worker, the existing cached model and the same 192-token diagnostic worker
as the preceding comparisons. No OCR, retries, CPU model fallback, downloads or model
copies were used. These independent calls do not enable a second pass in production.

The first input was the unchanged 909×1600 Arabic transfer image. The second used the
existing `prepareImageRegionForInference` default canvas cropper and content-agnostic
`lower_detail_rows` region: x=0, y=1088, width=909, height=352. Its 768×297 JPEG, quality
0.85, was visually checked to contain the reference, date and memo rows. The preparation
browser was closed and only its new scratch profile removed; model profiles were retained.
Both model runs passed cache/source checks and closed cleanly, freeing all 16,119 observed
buffers. No live server, app registration, production schema/prompt or APK changed.

The crop and shorter question are **not sufficient** to fix this example. They do not
prove resolution irrelevant or every glyph legible to a model: the region also changes
context, position, aspect ratio, scale, JPEG resampling and model input geometry. This
is not a pure-resolution comparison. It does not test payment classification because
the region excludes much of the payment-status evidence.

## Explicit Arabic label control — also rejected

A second four-call control inserted only this sentence into the original English prompt:
`On Arabic documents, "ملاحظة" is a memo label; copy its associated value, not that label.`
The expected memo, original/prepared image bytes, output budget and runtime were unchanged.
The expected answer was not supplied to either model.

| Model | Full original image | Existing focused region |
| --- | --- | --- |
| Qwen3-VL 2B | Note label `ملاحظة` | Note label `ملاحظة` |
| Gemma4 E2B | Total-amount label | Note label `ملاحظة` |

Again, **0/4 exact memos** and no empty/abstaining answers. All four calls completed without
unexpected GPU errors and passed source/cache/cleanup verification. Six independently rerun
offline report tests passed; that validates the checks, not these incorrect answers. This
rules out simply naming the label as a sufficient fix; it does not establish a general
inability to read Arabic or identify the underlying model/preprocessing cause.

The reusable runners/report accept a predeclared, hash-bound prompt policy. No new runtime
wrapper layer or model cache was created for this control. No production activation.

- Policy: `F:/Temp/OpenChat-IOU/admin/new-model-prompts-20260910/memo-probe-arabic-label.json`,
  SHA-256 `90e1320075935901f8aea60dc987f3979e0767447d40d123429d9f2e138047c2`.
- Submitted prompt SHA-256: `c4becc6655cfd5ea105715b4173c9b1a23061a48e170dd66905808e859600ea4`.
- Qwen run: `F:/Temp/OpenChat-IOU/output/playwright/memo-probe-qwen-MCMmLT/result.json`,
  SHA-256 `eeec6751aeec5ea6b8a28811b7726e8b13446653cef8e82a962bddf7c653c779`.
- Gemma run: `F:/Temp/OpenChat-IOU/output/playwright/memo-probe-gemma-ZT4i0q/result.json`,
  SHA-256 `b964072c30ba41bf37974f18b9bf13313009081ce7935cb3100322413d4c84e6`.
- Report: `F:/Temp/OpenChat-IOU/output/playwright/memo-probe-report-HOl5bh/result.json`,
  SHA-256 `6271d2deaf7f9876f30c79748e656c194b411257f76b14c928cb943d4faa84f9`.

## Short Arabic question — reading evidence, not a correct extraction

A further control replaced the English instructions with a short Arabic question asking
for the memo value, not its field name, with JSON/empty-answer and source-data instructions.
Both models received that same question and the same two image byte sequences. This changes
language and phrasing together, so it is not an isolated translation experiment.

| Model | Full original image | Existing focused region |
| --- | --- | --- |
| Qwen3-VL 2B | Transaction date/time | Reference, date, **correct memo**, and field labels together |
| Gemma4 E2B | Account identifier | An Arabic sentence saying the memo was not clearly supplied |

The result is still **0/4 exact memos**. In particular, Gemma's sentence is not the requested
empty value and Qwen's combined note is not accepted by extracting a correct substring.
However, Qwen's unchanged raw region response contains the exact printed memo. It can read
that value under these conditions; selecting and isolating the requested field still fails.
This does not prove equivalent readability on the full image or for Gemma.

All four calls completed, passed the runtime/cache/source/cleanup checks and used the same
192-token diagnostic worker. No production prompt, app/card schema, server or APK changed.
The previously tested reusable report was used without modifying its factual acceptance.

- Policy: `F:/Temp/OpenChat-IOU/admin/new-model-prompts-20260910/memo-probe-arabic-question.json`,
  SHA-256 `e38468b5dc91ed7b1c5af2266bd2ea7de3f282165fca0b27dda1310cddd4ae65`.
- Submitted prompt SHA-256: `0f73b15400c335027ed19ca8278a48adea3fdc4763ad888f532ce368a592e3fa`.
- Qwen run: `F:/Temp/OpenChat-IOU/output/playwright/memo-probe-qwen-w4lZe6/result.json`,
  SHA-256 `d51dbe610c313f1abd778e2cdb9aa8eaf3c865f41ee150390458ba9e24236be0`.
- Gemma run: `F:/Temp/OpenChat-IOU/output/playwright/memo-probe-gemma-Q4RHMg/result.json`,
  SHA-256 `2d366c9104e3655cdb088c694781f80e3949152ac3ae20de0afd6036d571371e`.
- Report: `F:/Temp/OpenChat-IOU/output/playwright/memo-probe-report-BHMGeQ/result.json`,
  SHA-256 `d8ab4f1d6af71332642bd57ac1233bc231033101769d0f74d3f227c8534bce73`.

## Arabic label/value pair — still rejected

A fourth control requested two explicit strings, `label` and `note`, rather than a
single note. This is a new diagnostic response shape, not relaxed full-card acceptance.
The expected label and memo stayed outside the prompt; image bytes and runtime stayed
unchanged. All four calls completed without GPU errors.

| Model | Full original image | Existing focused region |
| --- | --- | --- |
| Qwen3-VL 2B | Wrong label and an invented explanation | Wrong label and reference number |
| Gemma4 E2B | Correct label, but copied that label as the note | Correct label, empty note |

There were **0/4 exact memos** and **0/4 correct pairs**. Gemma's region response is a
safe empty note, not successful reading of the visible memo. The current host parser
accepted the complete JSON envelopes; factual checks rejected their contents. Ten
independently rerun offline assessor tests passed, including exact key/value checking
and refusal to reinterpret old one-key results as pair results. Historical reports
remain unchanged. No production prompt, app registration, server or APK was updated.

- Policy: `F:/Temp/OpenChat-IOU/admin/new-model-prompts-20260910/memo-probe-label-value-pair.json`,
  SHA-256 `2a35e7f52661a9a0d6ad685fa373a12c8f1788ebe00047ada517ffcef65e9088`.
- Submitted prompt SHA-256: `c39fa94e92a1b4edfc60dac5ce912a711d37b21255cbf53ffb11985dfe6bb901`.
- Qwen run: `F:/Temp/OpenChat-IOU/output/playwright/memo-probe-qwen-8V6p7n/result.json`,
  SHA-256 `c03ee4a484a6e6c100c48a98e69f54a3f1f6f6fb0b460b70079dacfcb233615c`.
- Gemma run: `F:/Temp/OpenChat-IOU/output/playwright/memo-probe-gemma-s6wVTe/result.json`,
  SHA-256 `282af04ce9adf03b06c049791498f6f10a092847ead10cdf30c36bccbc3ccf5a`.
- Report: `F:/Temp/OpenChat-IOU/output/playwright/memo-reading-report-edeamQ/result.json`,
  SHA-256 `915bef49178870bf465b9c2067cae1f6e5e6c26b2e96756aedef21ea576f484a`.

Further memo-only wording probes are not the next full-card qualification step. These
controls establish repeated source-selection failures, not a general inability to read
Arabic or a reason to weaken the independently transcribed card expectations.

## Original control evidence

- Policy: `F:/Temp/OpenChat-IOU/admin/new-model-prompts-20260910/memo-region-policy.json`,
  SHA-256 `e7d50b312232dfc647beec45fdb1f04d4acac716b717bb09fb1871d42f9c47ac`.
- Prompt SHA-256: `b2052f302420b8b3d0859626353e53a6e359b510d1ff0d23386019fc462e8702`.
- Prepared JPEG: `F:/Temp/OpenChat-IOU/output/playwright/memo-region-preparation-axGiZy/lower-detail-rows.jpg`,
  12,754 bytes, SHA-256 `ce6cc82643594317d05209af359753d8dec8d19d13b05b28e8be07f0a085297d`.
- Qwen receipt: `F:/Temp/OpenChat-IOU/output/playwright/memo-region-qwen-XKePjI/result.json`,
  SHA-256 `39cb9efc720a99963a2d4559b8417cd81b27039fa685673191ee8dfa0f1313d4`.
- Gemma receipt: `F:/Temp/OpenChat-IOU/output/playwright/memo-region-gemma-20260911-zoA468/result.json`,
  SHA-256 `9184f804a7742b4c3c027f2130092493265387f61a10990130786d420f566378`.
- Consolidated report: `F:/Temp/OpenChat-IOU/output/playwright/memo-region-report-znKSOh/result.json`.

The preparer has two passing offline tests; each runner has five; the assessor has
seven. They check input/source identity, unchanged runtime safeguards, actual host parsing,
wrong-value/duplicate/partial-JSON rejection and cleanup—not successful model extraction.
The raster hash identifies this exact preparation. Browser and tool binaries are not all
pinned, so byte-identical preparation across different browser versions is not claimed.
