# IOU complete-total-row image profile

Status: candidate infrastructure, not enabled by the deployed app manifest/page.
This is IOU-owned interpretation. OpenChat still passes complete app JSON to the
registered processor and contains no amount, currency, date or label rules.

The `total-row` profile lets a model copy a complete monetary row, including its
printed label, instead of deciding which words to remove. The processor is invoked
with the app-owned option `{ rawImageMoneyFormat: "total-row" }`. This is a local
processor configuration option, **not** a model-output or OpenChat request field.
Without that option, `total_text` retains the existing strict money-only contract.

The configured four-field response is:

```json
{"heading":"Visible document heading","total_text":"Amount due: EGP 350.00","dates":["04 JUL 2026"],"kind":"iou"}
```

The same grammar is also available under the explicit `total_row` key. Qwen's
key-renaming experiment regressed unrelated heading/payment classification, so
that prompt variant is rejected. Do not select it merely because its JSON parses.
Gemma's existing five-field split-money format remains unchanged by this option.

## Parsing contract

- One entire bounded row, with one monetary number and at most one recognized
  currency token. Existing IOU symbol mappings apply, including `$` to USD.
- An optional alphabetic label precedes the monetary value. Labels have no
  document/type-specific vocabulary. Currency codes cannot be discarded as labels.
- Without a printed currency, a nonempty label must end in `:`. Unknown unit words
  cannot silently become currency-free amounts.
- Numeric grouping, decimal precision, minor-unit representability and bounds use
  the existing strict money validator. No digit correction, rounding, conversion,
  second-number selection or missing-currency default.
- Labels do not enter the note. Heading, complete dates and kind use the existing
  validators; private type/direction selection and card construction remain later
  IOU operations. No OCR, image retry or second model call is introduced.
- Unknown/mixed shapes or one malformed row reject the complete candidate batch.
  Both the default and configured processors leave input objects untouched.

Successful parsing does not prove faithful image transcription. Acceptance must
compare raw row text with the source image and independently check the final card.
The source checks include the label: dropping a unit or copying the wrong total
does not pass just because a plausible numeric amount can be parsed.

## Current evidence

The complete-row diagnostic with Qwen's original `total_text` key recovered the
receipt currency that the money-only prompt omitted. Its retained answers fit the
new declared profile and the unchanged eight card-field expectations in offline
replay. This does not retroactively qualify that diagnostic under its old format.

The fresh `total_row`-key variant completed all eight hardware-WebGPU calls but
passed only 6/8 source/card checks: the Arabic transfer kind and receipt heading
regressed. The reports are retained; no expected card fields were loosened.

The fresh original-key/configured-profile run passes **8/8 source checks and 8/8
actual host/IOU card-field replays**, with all eight hardware-WebGPU calls completed
and their devices/buffers retired. The worker is unchanged; this result uses the
mixed-precision Qwen candidate, not the older all-q4 configuration.

Prompt: `qwen3-vl-2b-total-row-image.txt`, SHA-256
`2d73ebab0701a7adb4256072ef4625c30964b46766172bae05602bc72e045cc8`.
Runtime result: `c5404f050bbd50953dd69b67ffaf201964eb50f27dc9e064be69f7c3c7555b3d`.
Assessment: `ab0902f12750b129154ff706f1d7c2236de43e3f4849d75133f9a90da53c3579`.
Actual answers are retained in `test/fixtures/openchat/model-acceptance/qwen-v20-total-row-app-replay.json`.

Current IOU feature tests: **1,622 passed**, including the nine captured-answer
regressions; both TypeScript configurations have **zero errors**. Neither this
document nor the unit tests establish phone accuracy, live card verification,
private type/direction behavior, saved delivery or a release-ready APK.

September 13: four further desktop calls through the production host/worker and native model
cache also pass **4/4 source checks and 4/4 offline host/IOU card-field replays**. The sequence
is three exposed images plus an Arabic-transfer repeat, using the same prompt, model, explicit
profile and source/card expectations. Catalog retention, corruption rejection and single-file
repair pass separately. Assessment SHA-256:
`b955d3b55929bf9052a0f3f864706dc43a621d74e45c967385ae972ac99c36e0`.
This does not activate the app profile or qualify a phone/new APK/live card delivery.
