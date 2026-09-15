# OpenChat application boundary review — 2026-09-05

Local artifact references use `<project-temp>` for the operator-configured evidence location.
Artifact filenames and recorded hashes are unchanged; these are not published downloads.

The active OpenChat working tree no longer owns IOU transaction parsing, date inference,
financial text-sequence grammars, field-role declarations, or IOU-specific fixtures. Those
implementations and their app regression coverage now live under `src/features/openchat/`
in IOU. Generic host tests use independent measurement and specimen schemas.

OpenChat invokes an app-declared local processor in the exact registered card surface.
IOU implements that processor without mounting account providers or requesting backend data.
The app receives bounded source text, profile-tagged OCR transcripts, or model candidates.
IOU owns their interpretation. OpenChat validates generic JSON/schema bounds and retains the
existing attestation, review, and confirmation workflow.

OCR-only mode runs IOU's deterministic algorithm without loading or probing a model. Model-only
mode reads the original image through the selected model. Verified mode normalizes each
independent model/OCR-decoder result in IOU before comparing app-declared fields. This preserves
agreement between equivalent visible and ISO dates without allowing a conflicting date through.
Optional audio remains on the selected model path.

## Review coverage

- Removed host transaction/date engines and their exports; retained strict, generic JSON Schema
  date validation, app-supplied prompts, aliases, defaults, and field lists.
- Replaced IOU-specific host examples, fixture schemas, and the remaining backend comment.
- Reviewed app processor nonce binding, exact iframe source and opaque origin checks, size/count
  bounds, safe JSON handling, timeouts, concurrency, teardown, and account-change cancellation.
- Reviewed both OpenChat documentation illustrations; neither contains IOU content.
- Added `scripts/live/audit-openchat-app-boundary.ts --repo <OpenChat checkout>` in IOU to repeat
  the current-tree text audit. The final scan checked 5,098 text files with zero findings.
  Git history and ignored runtime caches are outside this source audit; history was not rewritten.

## Verification

- OpenChat: 127 test files, 1,766 tests passed; Svelte/TypeScript check has zero errors.
- IOU: 94 test files, 1,335 tests passed; both TypeScript configurations pass.
- Live Edge test of the supplied Arabic transfer image through actual OCR and the isolated IOU
  processor returned amount `12900`, currency `EGP`, and date `2026-08-14` in about 2.3 seconds.
  No model ran and no chat message was posted in that test.
- Live isolated processing of the supplied text returned `26400 EGP`, date `2026-08-06`, and
  complete interval endpoints. An unrelated category heading produced the same correct range.
  IOU's card projection produces `From 2026-08-06 to 2026-08-10` while preserving the existing note.
- The IOU manifest is published as app 1, revision `1788613298234`; anonymous read-back verified
  the exact schema and the installed backend manifest binding.

## Initial-card attestation regression found on the phone

After the user completed reconnecting, OpenChat observed the newer connection and retried the
same prepared extraction without running inference again. The retry still returned
`app_unavailable`. Capturing the initial card proved a payload-contract mismatch, not a failed
reconnect: the source text produced the correct `26400 EGP`, `2026-08-06`, and the paired
`interval_start` / `interval_end` values `2026-08-06` / `2026-08-10`, but IOU's Rust attester
rejected these app-declared endpoint fields as unknown. IOU's editable card folds the endpoints
into its note only after this initial attestation, so its final-payload projection could not prevent
the earlier rejection. Retrying or reconnecting does not change that payload mismatch.

The earlier verification missed this boundary: TypeScript tests checked local extraction and
the eventual edited confirmation payload, while Rust's date-range test manually constructed an
older initial payload without endpoint fields. Neither passed the actual initial payload from
the current host builder through the app attester. Passing those suites did not establish a
successful end-to-end proposal.

The fix remains IOU-owned: its attester accepts bounded paired endpoint evidence only in the
initial card, retains strict duplicate/unknown-field rejection and exact public-row checks, and
continues to reject endpoint fields in the final confirmation payload. OpenChat's generic host
logic and the installed APK do not need an app-specific change.

The shared fixture `src/features/openchat/fixtures/initial-card-content-v1.json` now pins the exact
initial title, rows, and payload bytes across IOU's processor, OpenChat's actual generic builder,
and IOU's Rust attester. The first fixture retains the phone's failing payload structure and
values, replacing only the private property identifier with a synthetic label before check-in. The
other fixtures cover an unrelated category heading, a non-interval image date normalized to
`2026-08-14` with amount `12900`, and image endpoint evidence. The image-candidate fixtures test
contract handling, not actual model inference.

Run this gate from the IOU checkout, supplying the OpenChat checkout being released:

```sh
node node_modules/tsx/dist/cli.mjs scripts/live/verify-initial-card-contract.ts --openchat-repo "<OpenChat checkout>"
node node_modules/vitest/vitest.mjs run src/features/openchat/initialCardContract.test.ts
cargo test --lib tests::app_local_candidates_built_by_openchat_pass_exact_card_attestation -- --exact
```

The host fixture check now reports five passing cases and the TypeScript test reports ten
passing tests, including the exact decimal amount and field order observed on the phone.
The exact Rust filter must execute **one** test, never zero. Fixture updates are explicit
reviewed changes, not automatically accepted by the checking script. At the initial backend
fix, the complete IOU suites passed 1,340 TypeScript tests and 100 Rust tests; subsequent
coverage and device results are recorded below.

The local IOU canister was snapshotted, upgraded in place, and restarted successfully. The new
snapshot `0000000000000001ffffffffffe000010101` was retained; the previous snapshot was not
overwritten. Deployed module hash
`607fe10eb0dce1118eeddda71fb66aad2a4e98f8791d6cf6f654ccacc0df009d` matches the rebuilt WASM.
Independent read-back confirmed Running status, unchanged revision `1788613298234`, and exact
manifest schema/binding. No account reset, manifest re-registration, or APK rebuild was performed.

On the same physical phone and installed APK, the same date-range proposal changed from
`app_unavailable` before the backend upgrade to `success` afterward. One pending review card
was posted. Its actual IOU iframe showed amount `26400`, date `2026-08-06`, note
`From 2026-08-06 to 2026-08-10`, and the user's saved type `Reservation`. Private app data finished
loading and Add to IOU became enabled. No IOU entry was confirmed. The temporary in-memory
diagnostic hook was removed. This verifies text proposal/card preparation, not model image inference.

## Image endpoint semantics follow-up

The supplied image prints `Sun, Jul 19` and `Thu, Aug 6`, but the model assigned
headings to the interval fields. IOU then synthesized `From Reservation to Total Payout`
from those bounded strings while its separate date parser rejected them. The invented
connective note and empty date therefore crossed two unchecked boundaries: ambiguous
app prompt semantics and missing date-value validation before note construction.

The app-owned image prompt now requests calendar values beside or below their labels,
preserves printed weekdays and yearless dates, and explicitly excludes headings, totals,
amounts, and counts as endpoints. IOU validates the complete date-like pair before both
initial attestation and editable-card rendering. Invalid endpoints are removed without
overwriting a valid existing date. Valid original endpoint spelling remains in the note;
the canonical start date uses an explicit source year or a unique weekday-consistent year
within the source calendar anchor's adjacent years. No year is added to model evidence.
The visible pair resolves to `2026-07-19` for the fixture anchors; this does not by itself
prove that a model extracted it correctly.

IOU's final tested manifest was published as revision `1788626925418`, with exact schema and
installed backend binding verified by read-back. IOU's live processor/card source is updated.
No OpenChat source change, backend code upgrade, or APK rebuild was made for this follow-up.

Verification now passes 97 TypeScript test files / 1,399 tests, both TypeScript configurations,
all four actual OpenChat initial-card builder fixtures, and the exact Rust shared-fixture test
(one executed test). The current-tree OpenChat boundary audit still reports 5,098 files and
zero findings. The image fixture now includes IOU's derived canonical date before signing;
negative fixtures include both the reported labels and unrelated category/summary headings.

The packaged-worker acceptance harness also accepts an app-owned exact-image expectation
file and rejects malformed/truncated responses rather than salvaging a JSON prefix. It checks
raw model evidence, IOU normalization, the editable card, and confirmation projection separately.
Expectations are never supplied to the model; no OCR fallback or entry confirmation is used.
Real inference results are recorded separately from these passing contract tests.

### Actual model results for this follow-up

The original supplied image ran through OpenChat's production all-WebGPU singleton engine
with Gemma 4 E2B, 96 output tokens, and JSON response mode, in an isolated persistent desktop
Edge profile on an NVIDIA Ampere adapter. No OCR fallback, chat posting, or entry confirmation
was used. The first revised prompt still failed twice: its output assigned month-only values
to the endpoints. This is a recorded failure, not accepted evidence that the guard fixed extraction.

The final 1,583-character app prompt emphasizes keeping each complete date together and not
splitting an endpoint into the separate date field. Two repeated runs returned numeric amount
`1912.15`, kind `iou`, exact endpoints `Sun, Jul 19` / `Thu, Aug 6`, and only the heading as
the note. The raw date was omitted rather than inventing a year. IOU's real processor, card, and
confirmation projection produced `2026-07-19` and
`Reservation | From Sun, Jul 19 to Thu, Aug 6`. Both runs passed the declared exact target
assertions in 8.8 and 10.0 seconds. The model also returned `USD`; the image prints only `$`,
so the currency-code origin is not proven by this test and currency is not an exact target assertion.

Two runs of the earlier Arabic transfer image retained numeric `12900`, `EGP`, and a full
visible `14 Aug 2026` date. IOU normalized it to `2026-08-14` and discarded an unmatched interval
endpoint. Its card/confirmation amount and date checks passed, but the strict raw-output gate
remains failed because the model did not emit the requested ISO date. These are deliberately
separate results, not a relaxed raw-output pass.

The bounded report is `output/playwright/exact-image-model-acceptance-20260905.json`.
It preserves initial failures and final results without image bytes, raw note text, or runtime
identifiers. The production source and registered schema were checked against the exact tested
prompt. The physical phone was not connected during these runs; this is desktop GPU evidence,
not a phone or Qwen acceptance result. All test inference engines were disposed after use.

## Environment and device limits

### Physical-phone no-action regression

After reconnecting the phone, its actual APK Propose action path used Gemma 4 E2B with
the same 96-token limit, exact 77,389-byte image, and exact 1,583-character published prompt
as the earlier successful desktop test. The observed image and prompt SHA-256 values matched.
The phone nevertheless emitted an invalid quoted object wrapper. Its amount, full endpoints,
heading, and kind were present, but the complete response was not valid JSON. The host returned
`no_extraction`, displayed as “The model found no action in this message.” This was not a stale
manifest, date-validation rejection, missing action, or card-attestation failure.

The earlier unit tests supplied model candidates; they did not execute the model on the phone.
The desktop-only GPU acceptance was explicitly scoped, but was insufficient release evidence
for the phone workflow. The exact malformed phone output now has a strict rejection regression
alongside its valid counterpart. No malformed-output repair or schema relaxation is allowed as
a way to turn this failure into a passing test. A phone proposal and its rendered app card must
be verified before claiming this phone regression is fixed.

### Desktop and emulator regression gates

The IOU-owned `model-proposal-contract-v1.json` preserves four actual phone responses:
malformed object wrapping, nested endpoints, an unrecognized amount key, and the complete
valid counterpart. Desktop unit tests reject the three bad outputs as model acceptance.
The shared integration replay runs the selected OpenChat checkout's real parser, required-field
checks, rules and initial-card builder, plus IOU's real normalization, editable-card projection
and confirmation-payload builder. Only the model completion is recorded test data.

A host `ready` result is explicitly insufficient: the nested-endpoint case reaches `ready`
but has no projected date, so it must remain unqualified. A passing regression suite means
the observed failures were detected, **not** that those failed model runs became successful.
The same source replay passed all four cases on desktop and inside the running emulator's
Android APK WebView. The emulator has no WebGPU adapter; this is not GPU inference, a test
of packaged UI event handlers, or live backend attestation. No chat messages were sent,
accounts reset, or cached models removed. The runner checks that page and browser storage
remain unchanged, and removes only its own temporary CDP forward.

The acceptance checker also rejects duplicate keys, including escaped key aliases, instead
of allowing a final duplicate to hide an earlier wrong amount/date/note. Amount equality is
checked across raw output, card projection and confirmation payload. Mutation-style unit
tests deliberately corrupt the card/confirmation amount and verify that qualification fails.
The final desktop suite passes 98 test files / 1,419 tests, including 38 checker/recorded-output
regressions; both application TypeScript configurations pass.

Run from the IOU checkout, passing the exact OpenChat checkout and Android tools to test:

```sh
pnpm test
pnpm test:openchat:model-proposal --openchat-repo "<OpenChat checkout>"
pnpm test:openchat:model-proposal:emulator --openchat-repo "<OpenChat checkout>" --adb "<adb executable>" --emulator emulator-5554 --output output/playwright/emulator-model-proposal-contract.json
```

The emulator APK must already be running. Both replay runners exit nonzero on regression.
Keep the actual initial-card/Rust gate above as a separate check: its fifth fixture now uses
the phone's exact valid `1912.15` / `USD` candidate and field order. All five actual-host
fixtures and the one Rust attestation test pass; this does not prove the user's current
connection authorizes that card.

### Final prompt and actual device results

Several trial prompts still produced invalid structures and were rejected. The final change
adds only an instruction that the JSON object itself is the answer, without enclosing the
whole object in quotation marks. It does not add image labels or business logic to OpenChat.
This 1,675-character IOU prompt was published as revision `1788628785922`; read-back verified
the exact registered schema and installed backend binding. No APK rebuild or backend code
upgrade was needed for this app-prompt change.

The final prompt produced valid, complete output in two desktop all-WebGPU Gemma runs
(45.780 seconds including initial cache verification, then 6.681 seconds), one direct phone
worker run (32.987 seconds), and the phone's actual Propose action (33.743 seconds).
The actual phone UI used the original 77,389-byte image and 96 output tokens. It returned
amount `1912.15` and the complete visible endpoints `Sun, Jul 19` / `Thu, Aug 6`; IOU's
tested projection derives `2026-07-19` and preserves the full pair in the note. The generated
`USD` code is consistent across these runs, but only the `$` symbol is printed in the image.

The live phone no longer stopped at `no_extraction`. It reached the separate
`Reconnect may help — iou` verification sheet. No pending card was posted in this attempt,
and no entry was confirmed. The end-to-end phone proposal therefore remains **unverified**
until the current connection and rendered app card pass. A new manifest revision can make
an existing revision-bound connection stale; that possibility is not proof of this refusal's
cause. The bounded model/device report and emulator replay report are under `output/playwright`.
Their filenames are `phone-model-proposal-acceptance-20260905.json` and
`emulator-model-proposal-contract-20260905.json`, respectively.

### September 8 paired-image contract and phone verification

The subsequent phone regression was real: the receipt's full single date was generated as an
incomplete interval after the range-oriented prompt rewrite. IOU correctly rejected that pair,
leaving Date empty. Earlier parser/range tests did not qualify both original images under the
same prompt. The acceptance suite now keeps all captured failures, distinguishes synthetic
controls from actual phone outputs, and pins the pair to the tested prompt bytes.

The new IOU-owned image contract uses `printed_date` and `printed_end_date`; a single date
requires the explicit empty ending string. IOU alone converts the full printed date or valid
range to its canonical fields. Incomplete/malformed pairs and mixed legacy representations
cannot revive a rejected date through card fallback. Legacy aliases are transported separately
and conflict-checked inside IOU. No app date fields, aliases, parsing rules or image fixtures
were added to OpenChat. The tested prompt's final newline is part of its byte identity.

Under the earlier `c79e08cbf13abd38dab634420664cb6dfeea09260b3ed373978db5057477b6dd`
prompt, both exact images produced repeatable date/type/note outputs in the packaged physical-phone
Gemma worker. After the local manifest and backend binding were refreshed, the user made fresh
proposals for both. The receipt card showed 12,900 EGP and 2026-08-14 with its Arabic heading;
the range card showed 1,912.15, saved type Reservation, 2026-07-19, and the complete From-to
note without the unrelated row-label text. Both were verified/editable with confirmation
enabled and 338 px viewport/document/body widths. Those captures did not check direction, and the
range output guessed `USD` where the source printed only `$`. They qualify the recorded
date/type/note and layout checks, not the complete proposal. Confirmation and delivery were not
exercised, and the reconnect interaction itself was not observed. No APK rebuild was needed.

Currency review exposed a separate acceptance overclaim: the range source prints only `$`;
earlier expected outputs copied the model's `USD`, contrary to the code-only prompt instruction.
Those raw captures remain unchanged, but overall grounding now rejects them while separately
recording their correct date/type/note fields. Synthetic currency-omitted controls verify the
strict negative rule without pretending a model emitted them. The user approved IOU's existing
`$` to `USD` policy for image proposals. That is an app-owned interpretation of the literal symbol,
not permission for the model to invent a printed ISO code or add currency logic to OpenChat.

The current prompt changes only its currency instruction to:

> "currency": copy only the visibly printed currency code or symbol exactly. Do not translate or expand symbols into codes.

Its SHA-256, including the final newline, is
`2ed2358df07dc8c42a25eb8c3b6b27f183202c384dc460335d7d476fde34bda1`.
Four actual packaged-phone Gemma 4 E2B runs at 96 output tokens preserved the correct amount,
printed date or complete range, kind, heading, and literal currency. The Arabic image returned
`12900`, `EGP`, `14 Aug 2026`, and an empty ending date in 33,396 and 32,757 ms. The range image
returned `1912.15`, `$`, `Sun, Jul 19` / `Thu, Aug 6` in 34,205 and 33,034 ms. IOU's replay maps
the raw `$` to card/confirmation currency `USD` using the approved existing policy. No OCR,
chat posting or confirmation was used in these four worker runs. Their unchanged receipts are
`arabic-worker-currency-copy.json`, `arabic-worker-currency-copy-repeat.json`,
`range-worker-currency-copy.json`, and `range-worker-currency-copy-repeat.json` under the project's
external `output/playwright/phone-release-20260908` evidence folder.

A separate direction bug remained after type selection: loading the private saved-type roster
did not apply the matched type's saved direction. IOU's card hydration now applies that saved
direction while preserving explicit manual edits and readonly cards. This is generic saved-type
behavior, with no `Reservation`-specific branch or other hard-coded category keyword. The earlier
phone captures omitted direction, so their passing date/type/note assertions could not detect it.

The latest complete IOU unit run passes **1,736/1,736 tests across 105 files**, with at most two
workers. The preceding 1,654/1,654 full run across 104 files and 922/922 focused selection across
49 files remain historical evidence. Both application TypeScript checks pass. All 16 recorded-output
replays through the actual selected OpenChat host
and IOU normalization/card/confirmation-payload code pass; rejected historical outputs remain
rejected, not retroactively qualified. These source replays are separate from fresh UI acceptance.
The production-mode IOU frontend candidate also built successfully into
`<project-temp>/iou-candidate-ui-20260908-be2829186e224e139f85895a94264813`.
This is an isolated candidate bundle, not a deployment or APK update; it predates the localized
date normalization follow-up below.

The updated literal-currency definition is now published locally as app 1 revision
`1788864441555`, replacing revision `1788862105373` and its earlier `c79e08cb…` prompt.
Anonymous read-back verified that the full response schema equals the regenerated app source
and that the backend manifest commitment matches exactly. The existing registrar and default
administrator were reused; no owner change, account reset or production deployment was performed.
The existing IOU frontend serves the direction fix: loopback checks returned HTTP 200 and verified
the exact direction assignment and labels in the delivered modules. The PowerShell Tailscale
HTTPS check failed TLS authentication; no certificate bypass was attempted. This is not phone
or Tailscale UI acceptance.

At `2026-09-08T10:54:29.928Z`, read-only inspection after the user's fresh physical-APK proposal
verified one editable IOU frame and one enabled confirmation control. The range card contained
amount `1912.15`, currency `USD`, kind `iou`, date `2026-07-19`, the full expected From-to note,
saved type `Reservation`, and direction `debt` displayed as **You owe**. Viewport, document and
body widths were all 338 px. The unchanged receipt is
`output/playwright/phone-release-20260908/literal-currency-range-direction-proposal.json` in the
project's external evidence directory. This closes the fresh rendered-card direction check.
It did **not** capture the card's manifest revision; revision `1788864441555` and source/binding
identity were verified separately above and must not be presented as a captured card revision.

The inspector did not press confirmation or independently read backend delivery. The user then
explicitly reported that **Add to IOU appeared correct**. Record that outcome as **user-confirmed
delivery**, not independent end-to-end/backend acceptance, and preserve the receipt's original
`confirmationClicked:false` / `deliveryVerified:false`. No reconnect journey was independently
observed.

The phone temporarily disconnected: the earlier read-only CDP preflight could not attach, and device
and forwarding inventories were empty. No selection, download, cache change or inference was
attempted. Earlier UI recognition of downloaded Qwen and uninstalled optional voice support
does not establish current Qwen cache readiness or audio acceptance. Those device checks remain
outstanding; the preflight failure is preserved in the same evidence directory as
`model-cache-preflight-blocked.json`.
Later the phone reconnected, cached base-model metadata matched, and Qwen was selected through
the actual model manager without deleting Gemma. Full-file verification stalled before attachment.
The subsequent user-initiated Qwen APK proposal completed in 44,716 ms with amount `12900`,
currency `EGP`, kind `settlement`, the correct Arabic heading, and `printed_date:"14 أب 2026"`.
The raw output also contained Markdown fences. IOU's English-only month parser discarded the
date: the actual verified editable card had Date empty, despite correct amount/currency and one
enabled confirmation control. Its 338 px layout did not overflow; the card was not saved.
Original evidence remains in `qwen-arabic-first-proposal-trace.json` and
`qwen-arabic-first-proposal-card.json` in the same external phone evidence directory.

The bounded fix is entirely IOU-owned. Its anchored Gregorian date grammar accepts complete
Arabic month and weekday names, exact decimal Arabic digit forms, and alef/vowel-mark variants
inside name tokens. In this date position, `أب` normalizes to August; arbitrary prose, incomplete
month names, impossible dates, weekday conflicts, controls and unjustified years remain rejected.
Original interval spelling is retained. The source actually prints `Aug`, so this is a semantic
normalization repair, **not** a claim that Qwen obeyed the literal-copy instruction. Neither the
prompt, manifest nor OpenChat's generic transport changed for this fix.

The exact fenced output is retained in the shared desktop/emulator replay. The actual PR2 host
parser, IOU normalization and both card boundaries now preserve `2026-08-14` and the correct
amount/currency/note. All 16 desktop cases pass their assertions, while this Qwen case remains
strictly unqualified for literal raw fidelity. The 80 new localized regressions include a
failing-first reproduction; 322 focused tests and the full 1,736-test suite now pass. Receipts include
`iou-localized-date-before.json`, `iou-localized-date-after-host-fixture.json`,
`iou-localized-date-desktop-replay.json` and `iou-full-after-localized-date.json` in the external
phone evidence directory. This is recorded-output replay, not new GPU or emulator inference.
The live server returned HTTP 200 for the updated normalization module. After USB reconnected,
the user's fresh proposal was inspected at approximately `2026-09-08T12:21Z`. The new visible
card, distinguished from the older undated card, showed amount `12900`, currency `EGP`, kind
`settlement`, date `2026-08-14`, the expected Arabic note, direction `credit` / **Owed to you**,
and no saved type. The verified frame had Add to IOU enabled and 338 px viewport/document/body
widths without overflow. Receipt: `arabic-post-localized-date-proposal-card.json` in the same
external evidence directory. This closes the fresh rendered-card check for this app-only fix
on the same September 7 APK. Confirmation, delivery, card revision and new raw model output
were not captured in this repeat; the prior Qwen selection is not a fresh model-identity assertion.

The installed APK is still the reviewed September 7 artifact. Separate generic OpenChat fixes
avoid redundant full-weight verification on a stale-worker refresh and yield during cached
SHA hashing; their focused source tests pass 106/106 on PR1 and 111/111 on PR2. A new local-test
APK is required for those dirty runtime changes and has not yet been built or phone-verified.
Independently verified confirmation/delivery and reconnect, repeated phone/model cache reuse,
optional voice if enabled, and final-head hosted checks remain separate gates.

The user-approved RAM-backed socket plan has now executed the selected 54 app/model tests.
The first run returned 26 passed / 28 failed / one ignored, with 411 filtered: shared failures
were traced to stale test pagination/lookup assumptions, invalid test card rows and a legacy
ingress expectation. Three integration-test files were corrected without changing production
WASMs or weakening security assertions; a source-bound harness-only relink succeeded. A fresh
run of the same 54 tests returned **52 passed / 2 failed / one ignored**, with 411 filtered,
under `tmp/pr2-selected-integration-45b05627a0274980aa41b75cf5ed562c`. The remaining assertions
concern LF/CRLF public-key text equality and an unexpected cancellation response; neither is
waived. Final source/input bindings passed and owned process/RAM cleanup completed. This is
not a passing integration gate or hosted Linux acceptance.
The earlier 2.2 GiB disk preflight and 465-test socket failure remain historical, not the current
execution state or an expanded runtime gate. The feature-only advisory request remains blocked
pending explicit user approval; no query succeeded and no whole lockfile was uploaded.

OpenChat's two unfiltered frontend workflows now contain a separate, exact nine-test-file
**Check offline feature inventory and CI contracts** step. Its contract guard checks the actual
single-line run, omitted tests, commented/conditional/ignored execution, repository-root working
directory and inherited shell. Those nine helpers plus model-CI coverage pass 262/262 tests on
PR1 and 304/304 on PR2, entirely offline, including four failing-first YAML-scalar regressions.
This completes that bounded wiring check, not overall CI:
the remaining old whole-lockfile commands still fail closed and must not be represented as green.

The eight target/feature-specific Rust inventories and advisory request plans are now extracted
and validated offline. PR1 uses its own four metadata profiles and 183 unchanged dependency
inputs; PR2 uses four profiles and 190 inputs. The retained
`<project-temp>/tmp/rust-advisory-offline-plans-e8cUoE/summary.json` plans 474 PR1 and 473 PR2
registry queries, with seven Git identities separately unqueried in each scope. **None were sent**.
`rootCompletenessVerified:false` records the bounded coverage limit, not a newly identified
missing root or authority to expand into optional development tools, unchanged core fixtures,
or a general native C audit. Historical findings remain preserved without current security clearance.

### Earlier environment recovery and APK smoke evidence

The preserved PocketIC replica, OpenChat frontend/background worker, and IOU frontend were
restored and checked locally. Recovery retained a verified 1,183-file / 5,105,680,298-byte backup
before reopening crash-incomplete state. No accounts or chats were reset.

Tailscale initially reported `NoState`, and Windows service control denied a restart, including
from the tool's elevated execution context. A later check found Tailscale running with no health
errors and the physical phone online. The complete `start-environment.ps1 -Action Status` check
then passed: preserved PocketIC, exact published app schema/binding, both local frontends,
OpenChat background-worker initialization, all-WebGPU model assets, original-image routes, and
both configured Tailscale HTTPS routes were healthy. OpenChat also completed initialization and
anonymous authentication through HTTPS. No service restart, route change, or authentication reset
was needed during that follow-up. After the user's reconnect and the attester fix above, the
phone's current IOU link successfully authorized card preparation and private app-data loading.
Entry confirmation was intentionally not performed.

The ARM64 v2 APK keeps all-WebGPU model support and disables production OTA replacement.
Final artifact: `<project-temp>/openchat-v2-all-webgpu-app-boundary-arm64-20260905-161936.apk`.
Its SHA-256 is `DDE7CDC9D54575A16FA967BC79E8D635DDA388899485ECB0DF8197484BE5BD3C`.
The installed APK's WebView reported `http://tauri.localhost/`, a secure context, and credentialless
iframe support. Its exact version, generic processing protocol, profile-tagged OCR bridge, OCR-only
UI, and Gemma/Qwen GPU worker assets passed the emulator smoke check. Removed host parser markers
were absent. The report is `<project-temp>/openchat-apk-final-app-boundary-smoke-20260905-161936.json`.
The emulator launches its packaged v2 UI, but its WebView returns no WebGPU adapter. No physical
phone was attached during that emulator check.

In the subsequent physical-phone check, the APK installed successfully without clearing app data,
and the signed-in Chats screen was visible. The installed bundle reported version
`2.0.0-local-webgpu-app-boundary-20260905-161936`, with no OTA bundle active. Its WebView exposed
a WebGPU adapter identified as `qualcomm` / `adreno-7xx`. These checks establish that the updated
packaged UI runs on the phone and can obtain a GPU adapter. Text action preparation subsequently
passed as recorded above. Image inference was still unverified at that point; the later
actual model and phone-Propose results are recorded separately above.

The phone's existing message menu exposed both Propose action and Process with AI. The initial
date-range attempt reached the `Reconnect may help — iou` sheet and testing paused. The user
then reconnected, but the same refusal persisted. The captured request established that the
actual cause was IOU's initial-card payload contract, not a connection failure; see the fix and
successful post-upgrade phone test above.
