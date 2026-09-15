// Browser-safe IOU-owned integration suite, shared by desktop and emulator wrappers.
// Only model generation is injected: parsing, schema/rules, app normalization, initial card,
// editable card and confirmation payload use the actual production implementations.
// There is deliberately no network/client/send capability here. This is not a GPU or UI test.
import fixtures from "../../src/features/openchat/fixtures/model-proposal-contract-v1.json";
import expectationFixture from "../../src/features/openchat/fixtures/packaged-worker-date-range-expectation.json";
import singleDateExpectation from "../../src/features/openchat/fixtures/packaged-worker-single-date-expectation.json";
import printedSingleDateExpectation from "../../src/features/openchat/fixtures/packaged-worker-printed-single-date-expectation.json";
import printedFullTimestampExpectation from "../../src/features/openchat/fixtures/packaged-worker-printed-full-timestamp-expectation.json";
import printedRangeExpectation from "../../src/features/openchat/fixtures/packaged-worker-printed-range-expectation.json";
import literalCurrencyRangeExpectation from "../../src/features/openchat/fixtures/packaged-worker-literal-currency-range-expectation.json";
import declaredSymbolCurrencyRangeExpectation from "../../src/features/openchat/fixtures/packaged-worker-declared-symbol-currency-range-expectation.json";
import { buildIouRules, iouActionManifest } from "../../src/features/openchat/actionManifest";
import { buildManifestWire } from "../../src/features/openchat/registerAiApp";
import { processIouRequest } from "../../src/features/openchat/localProcessorBridge";
import { buildConfirmPayload, initToFormState } from "../../src/features/openchat/cardBridge";
import { checkPackagedResponse, parsePackagedExpectation } from "./packagedTransformersAcceptance";

// Host source is selected by each wrapper, never a baked-in filesystem path or copied parser.
export type ModelProposalHost = Record<
  "runAiAction" | "aiActionDefinitionFromWire" | "postProcessAiActionCandidate" |
  "missingRequired" | "buildActionCardContent",
  (...args: any[]) => any
>;

export function modelProposalExpectation(fixture: { expectation?: string }) {
  if (fixture.expectation === "arabic-single-date") return parsePackagedExpectation(singleDateExpectation);
  if (fixture.expectation === "printed-single-date") return parsePackagedExpectation(printedSingleDateExpectation);
  if (fixture.expectation === "printed-full-timestamp") return parsePackagedExpectation(printedFullTimestampExpectation);
  if (fixture.expectation === "printed-date-range") return parsePackagedExpectation(printedRangeExpectation);
  if (fixture.expectation === "literal-currency-date-range") return parsePackagedExpectation(literalCurrencyRangeExpectation);
  if (fixture.expectation === "declared-symbol-currency-date-range") return parsePackagedExpectation(declaredSymbolCurrencyRangeExpectation);
  if (fixture.expectation !== undefined) throw new Error("Unknown proposal fixture expectation");
  return parsePackagedExpectation(expectationFixture);
}

export async function runModelProposalContract(host: ModelProposalHost) {
  const wire = (buildManifestWire("") as { actions: Record<string, any>[] }).actions[0];
  const definition = {
    ...host.aiActionDefinitionFromWire({ ...wire, card: { ...wire.card, disclosure: wire.card.disclosure[0] }, rules: [] }),
    rules: buildIouRules([]),
  };
  const binding = { frameNonce: "a".repeat(48), requestNonce: "b".repeat(48) };
  const cases = [];
  for (const fixture of fixtures.cases) {
    const expected = modelProposalExpectation(fixture);
    const sourceTimestamp = Date.parse(expected.sourceTimestamp);
    const issues: string[] = [];
    const check = (ok: boolean, label: string) => { if (!ok) issues.push(label); };
    let inferCalls = 0;
    let inferenceRequestMatches = false;
    let appCalls = 0;
    let initialCardBuilt = false;
    let projectedDate: string | null = null;
    let projectedNote: string | null = null;
    let projectedAmount: number | null = null;
    let projectedCurrency: string | null = null;
    let projectedKind: string | null = null;
    let finalAmount: number | null = null;
    let finalCurrency: string | null = null;
    let finalKind: string | null = null;
    let finalDate: string | null = null;
    let finalNote: string | null = null;
    let initialRowsMatch = false;
    const result = await host.runAiAction(definition,
      { image: new Uint8Array([1]), sourceTimestamp }, "test-only-key",
      async (request: Record<string, any>) => {
        inferCalls++;
        inferenceRequestMatches = request.image instanceof Uint8Array && request.image.byteLength === 1 &&
          request.prompt === (iouActionManifest.outputSchema["x-openchat-image-prompt-template"] as { template: string }).template &&
          request.responseMode === "json" && request.maxTokens === 256 && request.text === undefined;
        return { kind: "success", text: fixture.raw };
      });
    check(inferCalls === 1, "expected exactly one recorded image completion");
    check(inferenceRequestMatches, "image request did not use the current app prompt and bounded JSON path");
    check(result.kind === fixture.hostKind, "host result kind changed");
    check(JSON.stringify(result.missingFields ?? []) === JSON.stringify(fixture.missingFields), "required field result changed");

    if (result.kind === "ready") {
      appCalls++;
      const appResult = processIouRequest({ type: "oc:app-process:request", version: 1, ...binding,
        actionId: iouActionManifest.id, input: { operation: "normalize", modality: "image",
          sourceTimestamp, candidates: [result.extracted] } }, binding);
      check(appResult.kind === "candidates", "app normalization did not return candidates");
      if (appResult.kind === "candidates") {
        check(appResult.candidates.length === 1, "app changed candidate cardinality");
        check(!("printed_date" in appResult.candidates[0]) && !("printed_end_date" in appResult.candidates[0]),
          "app leaked transient printed date evidence into the card candidate");
        if (fixture.expectation === "arabic-single-date" || fixture.expectation === "printed-single-date" || fixture.expectation === "printed-full-timestamp") {
          check(!("interval_start" in appResult.candidates[0]) && !("interval_end" in appResult.candidates[0]),
            "single-date candidate retained or invented an interval");
        }
        const candidate = host.postProcessAiActionCandidate(definition, appResult.candidates[0],
          { hasImage: true, rulesAlreadyResolved: true });
        check(host.missingRequired(candidate, definition.responseSchema).length === 0, "app-normalized candidate failed required fields");
        const card = host.buildActionCardContent(definition, candidate, "test-only-key");
        initialCardBuilt = true;
        const payload = JSON.parse(new TextDecoder().decode(card.confirmPayload));
        check(JSON.stringify(payload) === JSON.stringify(candidate), "initial card payload changed the app-normalized candidate");
        const wantedRows = iouActionManifest.card.fields
          .map(({ key, label }) => ({ label, value: payload[key] === undefined ? "" : String(payload[key]) }))
          .filter(({ value }) => value.length > 0);
        initialRowsMatch = JSON.stringify(card.rows) === JSON.stringify(wantedRows);
        check(initialRowsMatch, "initial card rows differ from registered app fields");
        const form = initToFormState(payload, new Date(sourceTimestamp));
        const confirmed = buildConfirmPayload(form);
        projectedDate = form.date || null;
        projectedNote = form.note || null;
        projectedAmount = form.amount === "" ? null : Number(form.amount);
        projectedCurrency = form.currency || null;
        projectedKind = form.kind || null;
        finalAmount = typeof confirmed.amount === "number" && Number.isFinite(confirmed.amount)
          ? confirmed.amount : null;
        finalCurrency = confirmed.currency ?? null;
        finalKind = confirmed.kind ?? null;
        finalDate = confirmed.date ?? null;
        finalNote = confirmed.note || null;
        check(!("interval_start" in confirmed) && !("interval_end" in confirmed), "confirmation leaked transient endpoint fields");
        check(!("printed_date" in confirmed) && !("printed_end_date" in confirmed), "confirmation leaked transient printed dates");
      }
    } else {
      check(result.card === undefined, "non-ready result unexpectedly carried a card");
    }

    const strict = checkPackagedResponse(fixture.raw, expected);
    const cardDateTypeNoteAccepted = initialCardBuilt &&
      (expected.raw.kind === undefined || (projectedKind === expected.raw.kind && finalKind === expected.raw.kind)) &&
      projectedDate === expected.card.date && projectedNote === expected.card.note &&
      finalDate === expected.confirmed.date && finalNote === expected.confirmed.note;
    const dateTypeNoteAccepted = strict.dateTypeNoteAccepted && cardDateTypeNoteAccepted;
    const fullCardAccepted = cardDateTypeNoteAccepted && projectedAmount === expected.raw.amount &&
      finalAmount === expected.raw.amount &&
      (expected.raw.currency === undefined ||
        (projectedCurrency === (Object.hasOwn(expected.card, "currency") ? expected.card.currency : expected.raw.currency) &&
          finalCurrency === (Object.hasOwn(expected.confirmed, "currency") ? expected.confirmed.currency : expected.raw.currency)));
    const accepted = strict.exact && fullCardAccepted;
    check(strict.exact === fixture.strictAccepted, "strict raw acceptance changed");
    check(accepted === fixture.strictAccepted, "full proposal qualification changed");
    // A supported array/fence can fail strict raw formatting while its card is valid. Conversely,
    // host-ready never proves source correctness. Pin these boundaries independently where reviewed.
    if (fixture.fullCardAccepted !== undefined) {
      check(fullCardAccepted === fixture.fullCardAccepted, "independent full-card acceptance changed");
      check(projectedCurrency === fixture.projectedCurrency && finalCurrency === fixture.projectedCurrency,
        "reviewed card/confirmation currency changed");
      check(projectedKind === fixture.projectedKind && finalKind === fixture.projectedKind,
        "reviewed card/confirmation kind changed");
    }
    check(projectedDate === fixture.projectedDate, "projected date changed");
    check(projectedNote === fixture.projectedNote, "projected note changed");
    check(projectedAmount === fixture.projectedAmount, "projected amount changed");
    check(finalAmount === fixture.projectedAmount, "confirmation lost the reviewed amount");
    check(finalDate === fixture.projectedDate && finalNote === fixture.projectedNote, "confirmation lost the reviewed date/note");
    // In particular, host-ready with discarded nested endpoints is an observed incomplete card,
    // not a successful model qualification. Do not turn the raw/checker failure into a pass.
    cases.push({ id: fixture.id, pass: issues.length === 0, issues, hostKind: result.kind,
      inferCalls, appCalls, initialCardBuilt, initialRowsMatch,
      strictRawAccepted: strict.exact, fullCardAccepted, dateTypeNoteAccepted, accepted,
      projectedDate, projectedNoteMatches: projectedNote === fixture.projectedNote,
      projectedAmount, finalAmount, projectedCurrency, finalCurrency, projectedKind, finalKind, postCalls: 0 });
  }
  return { version: 1, mode: "recorded-model-output-integration-replay", pass: cases.every((value) => value.pass),
    realModelInference: false, realGpuInference: false, realUiProposeFlow: false,
    postingAvailable: false, cases };
}
