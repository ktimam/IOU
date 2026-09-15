# Small-Qwen v21 upper-heading candidate — rejected, not selected

This separate candidate changes only v20's heading instruction: it explicitly forbids joining
vertically stacked title/subtitle lines. Money, dates/ranges, kind, field order, model parameters
and all source/card expectations are unchanged. It contains no receipt-specific vocabulary.

- Candidate: `qwen3-vl-2b-upper-heading-v21-image.txt`, SHA-256
  `68b1260da41324b9e1ba11b275faf148a1ea3aea886dcf06697cdde4eaf9b514`.
- Active v20 remains `qwen3-vl-2b-total-row-image.txt`, SHA-256
  `2d73ebab0701a7adb4256072ef4625c30964b46766172bae05602bc72e045cc8`.
- No `modelImageProfiles.json`, app manifest, verification binding, backend, host or live
  registration is changed. Historical v20 files and failure receipts remain unchanged.

## September 15 result: rejected

The isolated ten-request run completed on hardware WebGPU. All ten runtime/retirement
checks passed, but only eight cards matched their frozen expectations:

- The synthetic receipt still produced `RIVER MARKET SERVICE RECEIPT`, rather than the
  requested first-line heading `RIVER MARKET`. Both phrases are printed in the source;
  this is a heading-selection mismatch, not invented receipt text.
- The synthetic workshop agreement returned `settlement`, whereas the historical v20
  capture returned `iou`. Its amount,
  currency, dates and note were correct, but an agreement is not evidence of completed payment.

All three user-supplied original images and the Arabic/range repeats matched their expected
card fields. The source bindings remained unchanged; the isolated browser and loopback server
closed normally, without forced cleanup or transport/browser errors. These results do not
qualify v21, and it was not activated. The current small-Qwen profile remains the unchanged v20
prompt above; its successful three-request phone sequence is recorded in [README.md](README.md).

Private local evidence, relative to the project-specific temporary root:
`output/playwright/small-qwen-upper-heading-v21-aFAYOf/result.json`, SHA-256
`7e5b38ac1902d59d053a665f3a5fd07cdf99e31e0c15ec54599b61be81d652cc`.
The raw result and original expectations are retained without rescoring either failure.

This is an observed difference from historical v20, not a proven prompt-only regression.
The historical smaller-Qwen v20 run used worker
`0febb1b1a7b907db1ac41f0daff33a0c12399c328cf7686e551db708ad4b405a`, while this v21 run used
the current cleanup worker `04ebc7bcb6a5385745a095ace2ba87e3e474775775dbae31f74d165433b39bd8`.
The model specification and frozen rasters match. That comparison gap motivated the fresh
same-worker active-v20 control recorded below; the historical run is not relabelled.

## Fresh unchanged-v20 control on the current worker

The explicit `--baseline-v20` run completed all ten requests on the same cleanup worker as
v21. All ten runtime/retirement checks passed, with nine exact card matches. The only mismatch
was the existing receipt heading/subtitle join. All amounts, currencies, dates and kinds were
correct, including the workshop agreement's `iou` kind. All three original images and both
repeats passed. Source bindings remained unchanged, both owned processes closed normally,
and there were no transport/browser errors or forced cleanup.

This fresh control supports retaining active v20 over v21 on this corpus: v21 did not fix
the receipt and returned the wrong workshop kind, whereas unchanged v20 returned the correct
kind on the same worker. It is not an unseen-image guarantee, a phone rerun, or a claim that
the receipt's note now meets the first-line contract. Both failed overall reports remain red.
No replacement prompt was activated or model downloaded.

Private local result: `output/playwright/small-qwen-v20-baseline-XvJ4YN/result.json`, SHA-256
`4e6659b5c8660f7c081575fdabf559e1e4dbebf65a8518695939a21964a8dc6e`.

### User-directed release disposition

On September 15 the user chose: keep the tested prompt and document the limitation.
Only the known receipt's inclusion of its printed subtitle in the note is accepted for
release with active v20. The first-line oracle, raw capture, failing 9/10 aggregate and
rejected v21 result remain intact. No extraction repair or test expectation was changed.
This does not accept invented text, wrong monetary/date/kind fields, different note failures,
or unverified private-Type/direction/delivery behavior. No further prompt candidate is selected.

## Bounded local diagnostic harness

This is an optional, non-standalone harness for reproducing the retained local evidence,
not a release test gate. The published sources alone are insufficient: even `--plan`
requires the existing evidence root's `admin/new-model-prompts-20260910/catalog-cache-fixture-v2.mjs`
and `admin/qwen-integrated-worker-observer-20260910.mjs`, plus the retained historical
plan, image policy and read-only image/model cache layout. Those local diagnostic helpers
and private captures are not part of the publication. `--run` additionally requires the
pinned compiled worker and the harness's fixed local Windows Chrome executable path. The instructions
below document evidence reproduction; they do not require another run for release.

`scripts/live/qualify-small-qwen-upper-heading.ts` reads the actual currently registered
small-Qwen profile, verifies its v20 identity, then substitutes v21 only into an in-memory test
copy. Other model profiles and app rules are preserved. The historical admin harness and
its retired comparison modes are not executed or modified.

The existing four-argument invocation still explicitly plans or runs v21. An optional final
`--baseline-v20` selects the **unchanged active v20** profile instead, after verifying its exact
bytes and registered configuration. It makes no prompt substitution or active-profile change.
Both selectors use the same current cleanup worker, eight frozen images plus the same two
repeats, original expectations, 96-token generation settings, deadlines and cleanup checks.
Plan, per-case and result records identify `candidateId` (`v21` or `v20-baseline`) and the exact
prompt hash. Baseline directories use `small-qwen-v20-baseline-*`; historical directories and
captures are never rewritten. The name `candidateId` labels the tested profile, not activation.

The harness requires an explicit mode and three absolute paths: host checkout, existing
evidence root, and local compiled worker. It pins the cleanup worker
`04ebc7bcb6a5385745a095ace2ba87e3e474775775dbae31f74d165433b39bd8`, the original small-Qwen
model specification, image policy and actual small-Qwen fixture. It rejects changed model
artifacts, source/card oracles, ordering, prompt, timestamps and missing cache inputs.
No model downloads or alternate/mixed model are used. Local graphs are derived in memory
and checked against the existing catalog; all weight inputs are read-only existing files.

From the IOU checkout, using its existing `tsx` installation:

```text
node node_modules/tsx/dist/cli.mjs scripts/live/qualify-small-qwen-upper-heading.ts --plan "<host-checkout>" "<project-temp>" "<compiled-worker>"
```

For the unchanged current-worker baseline plan, add the selector only at the end:

```text
node node_modules/tsx/dist/cli.mjs scripts/live/qualify-small-qwen-upper-heading.ts --plan "<host-checkout>" "<project-temp>" "<compiled-worker>" --baseline-v20
```

Replace the placeholders with absolute paths to the reviewed host checkout, existing
project-specific temporary evidence root, and the pinned compiled worker described above.

`--plan` binds the reviewed first-party runtime import tree before loading the current host/app
code, then verifies the same immutable hashes immediately after imports and at completion.
This includes catalog parsing, artifact transformation and all six graph helper modules;
app/host package and lockfile identities and the explicit ONNX schema input are also recorded.
The bootstrap helper is measured before its dynamic import; the entry file records its own
observed bytes. This is not a complete third-party runtime/source attestation.
It verifies the worker, hashes existing image/model inputs before and after, and writes a new
external `small-qwen-upper-heading-v21-plan-*/plan.json` or `small-qwen-v20-baseline-plan-*/plan.json`.
It starts no browser/server, performs no inference, and grants no qualification.

Only after separate authorization, change **only** `--plan` to `--run`. This runs eight frozen
unique images followed by the original Arabic and range repeats (ten requests total), one fixed
selected prompt throughout (unchanged active v20 for the baseline), all-q4 small Qwen on hardware WebGPU, and the existing 96-token
ceiling. It uses the standalone lazy cache fixture and an isolated loopback server/context;
external browser requests are denied. No existing browser profile/account or app delivery is used.

The new external `small-qwen-upper-heading-v21-*/` directory retains `plan.json`, each raw case
and `result.json`. A pass requires all ten actual worker/card results, buffer/device retirement,
one inference callback per image, zero transport/browser errors or warnings, closed browser/server
and unchanged bound inputs. The worker's existing EOS/no-partial-output validation is preserved.
Wrong values are retained as failures; the receipt expectation stays `RIVER MARKET`.
There are no automatic retries, source-specific repairs or OCR/CPU/model fallbacks.

An independent 195-second Node deadline covers each complete image fetch/inference/disposal
operation, in addition to the worker's renderer timer. A timed-out case is retained and stops
the remaining sequence; late renderer responses cannot update its evidence. Browser setup
also has a Node deadline. Cleanup allows ten seconds each for graceful browser close, the
exact owned browser-server handle's force-kill fallback, and loopback-server close. Any timeout
or forced cleanup fails qualification even if termination succeeds. A failed cleanup receipt
is written before the harness exits; unconfirmed termination is never reported as a clean close.

## Limits and subsequent activation

Offline contract tests and a successful plan do not show that the candidate improves accuracy.
Even a fresh 10/10 exposed-corpus pass does not establish unseen-image, caption/multiple-entry,
current phone, private Type/direction, attestation or authenticated delivery acceptance.
The v21 plan/run is an explicit candidate-schema clone, not evidence from a deployed v21 profile.
The v20 baseline uses an unchanged clone of the registered definition, but its isolated harness
is not a phone or authenticated-delivery test and never changes any model or app selection.
Any later selection requires its own app-owned configuration/registration update and fresh
current-manifest replay; do not overwrite historical captures or relabel the v20 mismatch.
Gemma's unchanged v15 captures remain independent; changing this Qwen candidate does not retest Gemma.
