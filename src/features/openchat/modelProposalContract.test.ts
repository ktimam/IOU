import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fixtures from "./fixtures/model-proposal-contract-v1.json";
import qwenLocalizedDate from "./fixtures/qwen-apk-arabic-month-date-20260908.json";
import { checkPackagedResponse } from "../../../scripts/live/packagedTransformersAcceptance";
import { modelProposalExpectation } from "../../../scripts/live/modelProposalContract";
import { processIouRequest } from "./localProcessorBridge";
import { iouActionManifest } from "./actionManifest";
import { buildConfirmPayload, initToFormState } from "./cardBridge";

// Recorded completions remain bound to their original literal-only prompt, not a later prompt.
const HISTORICAL_LITERAL_PROMPT_SHA256 = "2ed2358df07dc8c42a25eb8c3b6b27f183202c384dc460335d7d476fde34bda1";
const PRODUCTION_PROMPT_SHA256 = "a921746fc62f9e7fe3d8bc4d89f766f92fa57530e832832b0fdd5b97454fcb82";
const productionCases = [
  { id: "desktop-qwen-production-arabic-full-timestamp", requestId: 1, identicalRepeatRequestId: 3,
    imageSha256: "b93fbf4cb198c70f5da865e98d1b17ac5c2da465c09e8ff60b4ec01d8cc0f68f",
    rawSha256: "f4063efe8ebb32dfdfdd3f298e173fce0010d883ab55b09d69a87f6fc6ed9f2c" },
  { id: "desktop-qwen-production-declared-symbol-date-range", requestId: 2, identicalRepeatRequestId: 4,
    imageSha256: "b7acf1d1c8b54aa54d48af29ff9cb022a9a36c59f6144e623519d86e7531e6f1",
    rawSha256: "3660a19cfe7d043ba226ae92c2b77c74fcc35f486363a2a01e958929d1ddea49" },
] as const;
const gemmaCases = [
  { id: "desktop-gemma-production-arabic-single-date", requestId: 1, identicalRepeatRequestId: 3,
    imageSha256: "b93fbf4cb198c70f5da865e98d1b17ac5c2da465c09e8ff60b4ec01d8cc0f68f",
    rawSha256: "5337006c640118accf6c5719718de72c17c83564acc5ad28d547c3581a12a892", accepted: true },
  { id: "desktop-gemma-production-range-wrong-kind", requestId: 2, identicalRepeatRequestId: 4,
    imageSha256: "b7acf1d1c8b54aa54d48af29ff9cb022a9a36c59f6144e623519d86e7531e6f1",
    rawSha256: "05f2d975c11b06d9d50dd1dc08c3252245934f272615b05aacfd9841fbe61425", accepted: false },
] as const;
const candidateGemmaCases = [
  { id: "desktop-gemma-payment-proof-arabic-positive", requestId: 1, receipt: "UX8Soz",
    rawSha256: "5337006c640118accf6c5719718de72c17c83564acc5ad28d547c3581a12a892", array: false, fields: true },
  { id: "desktop-gemma-payment-proof-range-positive", requestId: 2, receipt: "UX8Soz",
    rawSha256: "c658be29065418558c1ecb6953ddb5739fdd2cb5d6cf51cb47a438d812e2ec59", array: false, fields: true },
  { id: "desktop-gemma-interval-arabic-singleton-array", requestId: 1, receipt: "arw6JC",
    rawSha256: "baf3bb3f4966f9c9fb7ed42bc0d205883647f903043ce14f3354195798187f7e", array: true, fields: true },
  { id: "desktop-gemma-interval-range-singleton-array-negative", requestId: 2, receipt: "arw6JC",
    rawSha256: "57ede996101c643e8b235df9fdaefeec77b0087aa401c62e9a8268d0e337c5e8", array: true, fields: false },
] as const;

function projectPrintedCandidate(candidate: Record<string, unknown>, sourceTimestamp: string) {
  const binding = { frameNonce: "a".repeat(48), requestNonce: "b".repeat(48) };
  const result = processIouRequest({ type: "oc:app-process:request", version: 1, ...binding,
    actionId: iouActionManifest.id, input: { operation: "normalize", modality: "image",
      sourceTimestamp: Date.parse(sourceTimestamp), candidates: [candidate] } }, binding);
  if (result.kind !== "candidates" || result.candidates.length !== 1) throw new Error("Expected one app-normalized image candidate");
  const normalized = result.candidates[0];
  const form = initToFormState(normalized, new Date(sourceTimestamp));
  return { normalized, form, confirmed: buildConfirmPayload(form) };
}

describe("recorded model proposal integration fixture contract", () => {
  it("keeps every observed failure and the valid counterpart in the desktop/emulator gate", () => {
    expect(fixtures.version).toBe(1);
    expect(fixtures.cases.map(({ id }) => id)).toEqual([
      "phone-malformed-wrapper", "phone-nested-endpoints", "phone-source-label-as-key", "phone-complete-valid-output",
      "phone-single-date-in-incomplete-interval", "phone-correct-date-wrong-amount", "synthetic-correct-single-date-control",
      "phone-flat-values-single-date-output", "phone-flat-values-range-regression",
      "phone-printed-pair-single-date", "phone-printed-pair-date-range",
      "synthetic-currency-omitted-range-control", "synthetic-currency-omitted-printed-range-control",
      "phone-literal-currency-single-date", "phone-literal-currency-date-range",
      "phone-qwen-fenced-localized-single-date",
      "phone-qwen-current-range-inaccurate-raw",
      "desktop-qwen-deepstack-range-inaccurate-raw",
      "desktop-qwen-deepstack-arabic-full-timestamp-fenced",
      "synthetic-unfenced-full-timestamp-control",
      "desktop-qwen-production-arabic-full-timestamp",
      "desktop-qwen-production-declared-symbol-date-range",
      "desktop-gemma-production-arabic-single-date",
      "desktop-gemma-production-range-wrong-kind",
      ...candidateGemmaCases.map(({ id }) => id),
    ]);
    expect(fixtures.cases.filter(({ strictAccepted }) => strictAccepted)).toHaveLength(13);
    // New successful completions must not rewrite or requalify any of the 20 historic records.
    expect(createHash("sha256").update(JSON.stringify(fixtures.cases.slice(0, 20))).digest("hex"))
      .toBe("9a3bd74aa6d2dbe417cde6c6256d423e743c7a670cbabb07a767d0f8aea9a50f");
    // Gemma evidence is additive; neither prior Qwen success nor any earlier failure is rewritten.
    expect(createHash("sha256").update(JSON.stringify(fixtures.cases.slice(0, 22))).digest("hex"))
      .toBe("3bb53c2561e498940b4de2fff5c88af6a2a4a297461ee201b885ea4a72c20825");
    expect(createHash("sha256").update(JSON.stringify(fixtures.cases.slice(0, 24))).digest("hex"))
      .toBe("4731cc2a6ca3677699c1581c22175411a9cdf70d551c63d83d6ed8ff4bf0d4b0");
  });

  it.each(productionCases)("pins the exact repeated production completion and its prospective prompt: $id", (record: typeof productionCases[number]) => {
    const fixture = fixtures.cases.find(({ id }) => id === record.id);
    expect(fixture).toBeDefined();
    if (!fixture) throw new Error("Missing recorded production completion");
    expect(fixture.promptSha256).toBe(PRODUCTION_PROMPT_SHA256);
    // This capture's prompt hash is immutable provenance, not a claim about later prompt revisions.
    expect(createHash("sha256").update(fixture.raw).digest("hex")).toBe(record.rawSha256);
    expect(fixture.source).toContain("actual desktop production Qwen worker");
    expect(fixture.provenance).toEqual({
      receipt: "output/playwright/qwen-production-full-model-20260909-heUSm0/result.json",
      receiptSha256: "331552d740b208315eb575277419a3199578a0ee8b02453ed47b14c99ffa1e87",
      buildReceipt: "tmp/qwen-production-worker-only-20260909-SudX1I/build-summary.json",
      buildReceiptSha256: "c6edf739464782f6b0da28de2db1b03d563818a25e9d38f21c0c165165ff6e8d",
      workerSha256: "5c86880afd9105ca2f5fd26427420a702ff6719e46397e4f7fb08909c5ca38ea",
      requestId: record.requestId, identicalRepeatRequestId: record.identicalRepeatRequestId,
      imageSha256: record.imageSha256, rawSha256: record.rawSha256, maxTokens: 96,
      productionWorkerUnmodified: true, sameWorkerAllRequests: true, physicalPhoneVerified: false,
    });
    const expected = modelProposalExpectation(fixture);
    expect(checkPackagedResponse(fixture.raw, expected)).toMatchObject({
      completeJsonObject: true, invalidOrTruncatedOutput: false, exact: true,
      currencyAccepted: true, dateTypeNoteAccepted: true,
    });
    const { normalized, form, confirmed } = projectPrintedCandidate(JSON.parse(fixture.raw), expected.sourceTimestamp);
    const currency = expected.card.currency ?? expected.raw.currency;
    expect(form).toMatchObject({ amount: String(expected.raw.amount), currency,
      kind: expected.raw.kind, date: expected.card.date, note: expected.card.note });
    expect(confirmed).toMatchObject({ amount: expected.raw.amount, currency,
      kind: expected.raw.kind, date: expected.confirmed.date, note: expected.confirmed.note });
    for (const field of ["printed_date", "printed_end_date"]) {
      expect(normalized).not.toHaveProperty(field);
      expect(confirmed).not.toHaveProperty(field);
    }
    // Validated endpoints are app-owned intermediate evidence used to compose the editable note.
    // A single date never gains a range, and neither form nor confirmation transports endpoints.
    for (const field of ["interval_start", "interval_end"]) {
      if (expected.raw.printed_end_date === "") expect(normalized).not.toHaveProperty(field);
      else expect(normalized[field]).toBe(field === "interval_start" ? expected.raw.printed_date : expected.raw.printed_end_date);
      expect(form).not.toHaveProperty(field);
      expect(confirmed).not.toHaveProperty(field);
    }
  });

  it.each(gemmaCases)("pins exact Gemma runtime evidence without confusing runtime completion with accuracy: $id", (record: typeof gemmaCases[number]) => {
    const fixture = fixtures.cases.find(({ id }) => id === record.id)!;
    expect(fixture.promptSha256).toBe(PRODUCTION_PROMPT_SHA256);
    expect(createHash("sha256").update(fixture.raw).digest("hex")).toBe(record.rawSha256);
    expect(fixture.source).toContain("actual desktop production Gemma worker");
    expect(fixture.provenance).toEqual({
      receipt: "output/playwright/gemma-retained-cache-20260909-byJHtm/result.json",
      receiptSha256: "bbccc5ea9eb1cba1078bcc9e5c16ed3cfa867694faaa0fa8066090237186bd8d",
      buildReceipt: "tmp/qwen-production-worker-only-20260909-SudX1I/build-summary.json",
      buildReceiptSha256: "c6edf739464782f6b0da28de2db1b03d563818a25e9d38f21c0c165165ff6e8d",
      workerSha256: "5c86880afd9105ca2f5fd26427420a702ff6719e46397e4f7fb08909c5ca38ea",
      cardReplay: "output/playwright/gemma-retained-cache-20260909-byJHtm/card-replay-current-policy.json",
      cardReplaySha256: "1af02adf17c32a8c8120081bc606195350535148a34262bc96aa31812f86d90d",
      hostSourceSha256: "380673dfd5795470a0ce5b0d7979ac2e57be6a98b9ca6def141dac3c9fa6de83",
      modelId: "gemma-4-e2b-it-q4", modelRevision: "9f4bef82ea6e296bc69f8a2f5939f73af81b07a6",
      requestId: record.requestId, identicalRepeatRequestId: record.identicalRepeatRequestId,
      imageSha256: record.imageSha256, rawSha256: record.rawSha256, maxTokens: 96,
      runtimePassed: true, sourceUnchanged: true, physicalPhoneVerified: false,
    });
    expect(fixture.strictAccepted).toBe(record.accepted);
    const expected = modelProposalExpectation(fixture);
    const candidate = JSON.parse(fixture.raw);
    const evidence = checkPackagedResponse(fixture.raw, expected);
    expect(evidence).toMatchObject({ completeJsonObject: true, invalidOrTruncatedOutput: false,
      currencyAccepted: true, dateTypeNoteAccepted: record.accepted, exact: record.accepted });
    expect(candidate).toMatchObject({ amount: expected.raw.amount, note: expected.raw.note,
      printed_date: expected.raw.printed_date, printed_end_date: expected.raw.printed_end_date });
    const { normalized, form, confirmed } = projectPrintedCandidate(candidate, expected.sourceTimestamp);
    expect(normalized.kind).toBe("settlement");
    expect(form).toMatchObject({ amount: String(expected.raw.amount), currency: expected.card.currency ?? expected.raw.currency,
      kind: "settlement", date: expected.card.date, note: expected.card.note });
    expect(confirmed).toMatchObject({ amount: expected.raw.amount, currency: expected.confirmed.currency ?? expected.raw.currency,
      kind: "settlement", date: expected.confirmed.date, note: expected.confirmed.note });
    expect(expected.raw.kind).toBe(record.accepted ? "settlement" : "iou");
    expect(form.kind === expected.raw.kind).toBe(record.accepted);
    expect(confirmed.kind === expected.raw.kind).toBe(record.accepted);
    // Do not repair the negative capture's kind. Its correct dates/amount/currency do not qualify it.
    for (const field of ["printed_date", "printed_end_date"]) expect(normalized).not.toHaveProperty(field);
    for (const field of ["printed_date", "printed_end_date", "interval_start", "interval_end"]) {
      expect(form).not.toHaveProperty(field);
      expect(confirmed).not.toHaveProperty(field);
    }
    if (record.accepted) {
      expect(normalized).not.toHaveProperty("interval_start");
      expect(normalized).not.toHaveProperty("interval_end");
    }
  });

  it("opts only the prospective range records into the declared symbol policy", () => {
    const fixture = fixtures.cases.find(({ id }) => id === productionCases[1].id)!;
    const expected = modelProposalExpectation(fixture);
    const historical = modelProposalExpectation({ expectation: "literal-currency-date-range" });
    expect(expected).toEqual({ ...historical, currencyPolicy: { version: 1, mode: "literal-or-declared-symbol" } });
    expect(expected.raw.currency).toBe("$");
    expect(JSON.parse(fixture.raw).currency).toBe("USD");
    expect(checkPackagedResponse(fixture.raw, expected)).toMatchObject({ exact: true, literalCurrencyAccepted: false });
    expect(checkPackagedResponse(fixture.raw, historical)).toMatchObject({ exact: false, currencyAccepted: false });
    const literal = JSON.stringify({ ...JSON.parse(fixture.raw), currency: "$" });
    expect(checkPackagedResponse(literal, expected).exact).toBe(true);
    expect(checkPackagedResponse(literal, historical).exact).toBe(true);
    expect(fixtures.cases.filter((value) => modelProposalExpectation(value).currencyPolicy !== undefined)
      .map(({ id }) => id)).toEqual([productionCases[1].id, gemmaCases[1].id,
        candidateGemmaCases[1].id, candidateGemmaCases[3].id]);
  });

  it.each(candidateGemmaCases)("keeps candidate provenance, strict format and actual card fields independent: $id", (record) => {
    const fixture = fixtures.cases.find(({ id }) => id === record.id)!;
    const expected = modelProposalExpectation(fixture);
    const paymentProof = record.receipt === "UX8Soz";
    expect(createHash("sha256").update(fixture.raw).digest("hex")).toBe(record.rawSha256);
    expect(fixture.promptSha256).toBe(paymentProof
      ? "cbcf3b280f368812931678382a8fa4990fde6ccd6fe50452acbb8bfd69b581c0"
      : "68587c5d79bb31648b9d6c4a94761244d54b10260c2810168169440a147fbda3");
    expect(fixture.provenance).toEqual({
      receipt: `output/playwright/gemma-retained-cache-20260909-${record.receipt}/result.json`,
      receiptSha256: paymentProof ? "e59b21c4a6f2f7450922729a4e0c57e036335c9b8e660d6c236525cdbb03d201"
        : "8ef7ddd4218d2492c2af26e38e942651d90578941dd187f0b316c75b1a1b9faf",
      buildReceipt: "tmp/qwen-production-worker-only-20260909-SudX1I/build-summary.json",
      buildReceiptSha256: "c6edf739464782f6b0da28de2db1b03d563818a25e9d38f21c0c165165ff6e8d",
      workerSha256: "5c86880afd9105ca2f5fd26427420a702ff6719e46397e4f7fb08909c5ca38ea",
      sourcePromptSha256: PRODUCTION_PROMPT_SHA256,
      ...(paymentProof ? {} : { candidateManifestSha256: "cf7552afd51f34d066b289e62e26ad5b7a90ce14a856daa88fafddd441807c10" }),
      modelId: "gemma-4-e2b-it-q4", modelRevision: "9f4bef82ea6e296bc69f8a2f5939f73af81b07a6",
      requestId: record.requestId, identicalRepeatRequestId: record.requestId + 2,
      imageSha256: record.requestId === 1 ? productionCases[0].imageSha256 : productionCases[1].imageSha256,
      rawSha256: record.rawSha256, maxTokens: 96, runtimePassed: true, candidateOnly: true,
      actualCurrentAppPromptReplay: false, physicalPhoneVerified: false,
    });
    expect(fixture).toMatchObject({ hostKind: "ready", missingFields: [], strictAccepted: !record.array,
      fieldAccepted: record.fields, fullCardAccepted: record.fields });
    expect(checkPackagedResponse(fixture.raw, expected)).toMatchObject({
      completeJsonObject: !record.array, exact: !record.array,
    });
    const parsed = JSON.parse(fixture.raw);
    if (record.array) expect(parsed).toHaveLength(1);
    // Exact complete singleton-array interior only: retain byte-level duplicate-key checking.
    // This app-only test does not implement a host parser; desktop/emulator replay receives raw unchanged.
    const fieldText = record.array ? fixture.raw.trim().slice(1, -1).trim() : fixture.raw;
    const candidate = record.array ? parsed[0] : parsed;
    expect(JSON.parse(fieldText)).toEqual(candidate);
    const fields = checkPackagedResponse(fieldText, expected);
    expect(fields).toMatchObject({ completeJsonObject: true, currencyAccepted: true,
      dateTypeNoteAccepted: record.fields, exact: record.fields });
    const { normalized, form, confirmed } = projectPrintedCandidate(candidate, expected.sourceTimestamp);
    expect(form).toMatchObject({ amount: String(fixture.projectedAmount), currency: fixture.projectedCurrency,
      kind: fixture.projectedKind, date: fixture.projectedDate ?? "", note: fixture.projectedNote });
    expect(confirmed).toMatchObject({ amount: fixture.projectedAmount, currency: fixture.projectedCurrency,
      kind: fixture.projectedKind, note: fixture.projectedNote });
    expect(confirmed.date ?? null).toBe(fixture.projectedDate);
    expect(form.date === expected.card.date && form.note === expected.card.note &&
      form.kind === expected.raw.kind && form.currency === (expected.card.currency ?? expected.raw.currency))
      .toBe(fixture.fullCardAccepted);
    for (const field of ["printed_date", "printed_end_date"]) expect(normalized).not.toHaveProperty(field);
    for (const field of ["printed_date", "printed_end_date", "interval_start", "interval_end"]) expect(confirmed).not.toHaveProperty(field);
    if (!record.fields) {
      expect(candidate).toMatchObject({ printed_date: "Jun 19", printed_end_date: "", kind: "iou", amount: 1912.15 });
      expect(expected.raw).toMatchObject({ printed_date: "Sun, Jul 19", printed_end_date: "Thu, Aug 6" });
      expect(confirmed).not.toHaveProperty("date");
      expect(form.note).not.toContain("From");
      expect(fields.projected).toMatchObject({ date: null, noteMatches: false, confirmedDate: null, confirmedNoteMatches: false });
    }
  });

  it("never mistakes differently pinned model successes or one correct array card for a shared passing prompt", () => {
    const positive = candidateGemmaCases.slice(0, 2).map(({ id }) => fixtures.cases.find(value => value.id === id)!);
    const interval = candidateGemmaCases.slice(2).map(({ id }) => fixtures.cases.find(value => value.id === id)!);
    expect(new Set(positive.map(value => value.promptSha256)).size).toBe(1);
    expect(positive.every(value => value.fullCardAccepted && value.strictAccepted)).toBe(true);
    expect(positive[0].promptSha256).not.toBe(fixtures.cases.find(value => value.id === productionCases[0].id)!.promptSha256);
    expect(new Set(interval.map(value => value.promptSha256)).size).toBe(1);
    expect(interval.every(value => value.strictAccepted)).toBe(false);
    expect(interval.map(value => value.fullCardAccepted)).toEqual([true, false]);
  });

  it.each(productionCases)("rejects corrupted fields and wrappers instead of repairing a recorded success: $id", ({ id }: typeof productionCases[number]) => {
    const fixture = fixtures.cases.find((value) => value.id === id)!;
    const expected = modelProposalExpectation(fixture);
    const candidate = JSON.parse(fixture.raw);
    const mutations = [
      { amount: candidate.amount * 10 },
      { amount: String(candidate.amount) },
      { kind: candidate.kind === "iou" ? "settlement" : "iou" },
      { currency: candidate.currency === "USD" ? "EUR" : "USD" },
      { currency: "cp" },
      { currency: "USD/CAD" },
      { currency: undefined },
      { printed_date: candidate.kind === "iou" ? "Sun, Jul 12" : "13 Aug 2026 09:47 PM" },
      { printed_date: { date: candidate.printed_date } },
      { printed_end_date: candidate.printed_end_date === "" ? "15 Aug 2026" : "" },
      { printed_end_date: undefined },
      { note: "Invented heading" },
      { date: "2026-08-14" },
    ];
    for (const mutation of mutations) {
      expect(checkPackagedResponse(JSON.stringify({ ...candidate, ...mutation }), expected).exact,
        JSON.stringify(mutation)).toBe(false);
    }
    for (const malformed of ["```json\n" + fixture.raw + "\n```", fixture.raw.slice(0, -1),
      fixture.raw + " Additional explanation", '{"amount":1,' + fixture.raw.slice(1)]) {
      expect(checkPackagedResponse(malformed, expected)).toMatchObject({ completeJsonObject: false, exact: false });
    }
  });

  it("passes the exact captured fenced Qwen completion to the real-host desktop/emulator replay, without excusing literal deviations", () => {
    const fixture = fixtures.cases.find(({ id }) => id === "phone-qwen-fenced-localized-single-date")!;
    expect(fixture.raw).toBe(qwenLocalizedDate.rawText);
    expect(fixture.promptSha256).toBe(qwenLocalizedDate.provenance.promptSha256);
    expect(fixture.source).toContain("actual user-initiated packaged Qwen APK proposal");
    expect(fixture).toMatchObject({ hostKind: "ready", strictAccepted: false,
      projectedDate: qwenLocalizedDate.expectedDate, projectedAmount: 12900,
      projectedNote: qwenLocalizedDate.capturedCandidateBeforeFix.note });
    expect(checkPackagedResponse(fixture.raw, modelProposalExpectation(fixture)).exact).toBe(false);
    // Even removing only the wrapper would not make the translated month a literal copy.
    const unfenced = fixture.raw.slice("```json\n".length, -"\n```".length);
    const evidence = checkPackagedResponse(unfenced, modelProposalExpectation(fixture));
    expect(evidence.completeJsonObject).toBe(true);
    expect(evidence.projected.date).toBe(qwenLocalizedDate.expectedDate);
    expect(evidence.exact).toBe(false);
  });

  it.each(fixtures.cases)("strict raw checker agrees with the full pipeline fixture: $id", (fixture) => {
    const expected = modelProposalExpectation(fixture);
    expect(fixture.raw.length).toBeLessThan(1024);
    expect(checkPackagedResponse(fixture.raw, expected).exact).toBe(fixture.strictAccepted);
  });

  it.each(fixtures.cases.filter(({ expectation }) => expectation === "arabic-single-date"))(
    "replays single-date evidence through IOU normalization and editable card without inventing a range: $id", (fixture) => {
      const expected = modelProposalExpectation(fixture);
      const binding = { frameNonce: "a".repeat(48), requestNonce: "b".repeat(48) };
      const result = processIouRequest({ type: "oc:app-process:request", version: 1, ...binding,
        actionId: iouActionManifest.id, input: { operation: "normalize", modality: "image",
          sourceTimestamp: Date.parse(expected.sourceTimestamp), candidates: [JSON.parse(fixture.raw)] } }, binding);
      expect(result.kind).toBe("candidates");
      if (result.kind !== "candidates") throw new Error("Expected app normalization candidate");
      expect(result.candidates).toHaveLength(1);
      const candidate = result.candidates[0];
      expect(candidate).not.toHaveProperty("interval_start");
      expect(candidate).not.toHaveProperty("interval_end");
      const form = initToFormState(candidate, new Date(expected.sourceTimestamp));
      const confirmed = buildConfirmPayload(form);
      expect(Number(form.amount)).toBe(fixture.projectedAmount);
      expect(form.date || null).toBe(fixture.projectedDate);
      expect(form.note).toBe(fixture.projectedNote);
      expect(confirmed.amount).toBe(fixture.projectedAmount);
      expect(form.currency).toBe(expected.raw.currency);
      expect(confirmed.currency).toBe(expected.raw.currency);
      expect(form.kind).toBe(expected.raw.kind);
      expect(confirmed.kind).toBe(expected.raw.kind);
      expect(confirmed.date ?? null).toBe(fixture.projectedDate);
      expect(confirmed.note).toBe(fixture.projectedNote);
      expect(checkPackagedResponse(fixture.raw, expected).exact).toBe(fixture.strictAccepted);
    },
  );

  it("rejects a corrected date when the same completion has an incorrect amount", () => {
    const fixture = fixtures.cases.find(({ id }) => id === "phone-correct-date-wrong-amount")!;
    const expected = modelProposalExpectation(fixture);
    const evidence = checkPackagedResponse(fixture.raw, expected);
    expect(evidence.projected.date).toBe(expected.card.date);
    expect(evidence.projected.amount).toBe(129000);
    expect(evidence.exact).toBe(false);
  });

  it("rejects the recorded Qwen range output without repairing its amount or inventing an endpoint", () => {
    const fixture = fixtures.cases.find(({ id }) => id === "phone-qwen-current-range-inaccurate-raw")!;
    expect(fixture.promptSha256).toBe(HISTORICAL_LITERAL_PROMPT_SHA256);
    expect(fixture.source).toContain("actual user-initiated packaged Qwen APK proposal");
    const expected = modelProposalExpectation(fixture);
    const evidence = checkPackagedResponse(fixture.raw, expected);
    expect(evidence.completeJsonObject).toBe(true);
    expect(evidence.invalidOrTruncatedOutput).toBe(false);
    expect(evidence.observed).toMatchObject({ amount: 1912.5, currency: "USD", kind: "settlement",
      printed_date: "Jul 19", printed_end_date: "" });
    expect(evidence.projected).toMatchObject({ amount: 1912.5, date: null,
      kind: "settlement", confirmedKind: "settlement", currency: "USD", confirmedCurrency: "USD" });
    expect(evidence.currencyAccepted).toBe(false);
    expect(evidence.dateTypeNoteAccepted).toBe(false);
    expect(evidence.exact).toBe(false);
    expect(fixture).toMatchObject({ hostKind: "ready", strictAccepted: false,
      projectedDate: null, projectedAmount: 1912.5, projectedNote: "Reservation" });
  });

  it("rejects the exact production desktop DeepStack completion despite correct range dates", () => {
    const fixture = fixtures.cases.find(({ id }) => id === "desktop-qwen-deepstack-range-inaccurate-raw")!;
    expect(fixture).toBeDefined();
    expect(fixture.promptSha256).toBe(HISTORICAL_LITERAL_PROMPT_SHA256);
    expect(fixture.source).toContain("actual desktop production Qwen worker");
    expect(fixture.source).toContain("qwen-production-full-model-20260909-uaYIgE/result.json");
    expect(fixture.source).toContain("b7acf1d1c8b54aa54d48af29ff9cb022a9a36c59f6144e623519d86e7531e6f1");
    expect(fixture.source).toContain("2c42b78d399ca81e703285cb667253b50e13acd9d9fde4bd9674016fb0ccba92");
    expect(fixture.raw).toBe('{\n  "amount": 191215.0,\n  "printed_date": "Sun, Jul 19",\n  "printed_end_date": "Thu, Aug 6",\n  "note": "Reservation",\n  "kind": "settlement",\n  "currency": "USD"\n}');
    const expected = modelProposalExpectation(fixture);
    expect(expected.raw).toMatchObject({ amount: 1912.15, currency: "$", kind: "iou" });
    const evidence = checkPackagedResponse(fixture.raw, expected);
    expect(evidence.completeJsonObject).toBe(true);
    expect(evidence.invalidOrTruncatedOutput).toBe(false);
    expect(evidence.observed).toMatchObject({ amount: 191215, currency: "USD", kind: "settlement",
      printed_date: "Sun, Jul 19", printed_end_date: "Thu, Aug 6", noteMatches: true });
    expect(evidence.projected).toMatchObject({ amount: 191215, confirmedAmount: 191215,
      kind: "settlement", confirmedKind: "settlement", currency: "USD", confirmedCurrency: "USD",
      date: expected.card.date, confirmedDate: expected.confirmed.date,
      noteMatches: true, confirmedNoteMatches: true });
    expect(evidence.currencyAccepted).toBe(false);
    expect(evidence.dateTypeNoteAccepted).toBe(false);
    expect(evidence.exact).toBe(false);

    const binding = { frameNonce: "a".repeat(48), requestNonce: "b".repeat(48) };
    const sourceTimestamp = Date.parse(expected.sourceTimestamp);
    const result = processIouRequest({ type: "oc:app-process:request", version: 1, ...binding,
      actionId: iouActionManifest.id, input: { operation: "normalize", modality: "image",
        sourceTimestamp, candidates: [JSON.parse(fixture.raw)] } }, binding);
    if (result.kind !== "candidates") throw new Error("Expected the observed schema-valid candidate");
    expect(result.candidates).toHaveLength(1);
    const form = initToFormState(result.candidates[0], new Date(sourceTimestamp));
    const confirmed = buildConfirmPayload(form);
    expect(confirmed).toMatchObject({ amount: 191215, currency: "USD", kind: "settlement",
      date: expected.confirmed.date, note: expected.confirmed.note });
    expect(confirmed.amount).not.toBe(expected.raw.amount);
    expect(confirmed.kind).not.toBe(expected.raw.kind);
    expect(fixture).toMatchObject({ hostKind: "ready", strictAccepted: false,
      projectedDate: "2026-07-19", projectedAmount: 191215,
      projectedNote: "Reservation | From Sun, Jul 19 to Thu, Aug 6" });
    // This negative replay catches a failed model result; it is not a new inference or phone pass.
  });

  it("retains the exact repeated desktop Arabic timestamp completion without qualifying its fences", () => {
    const captured = fixtures.cases.find(({ id }) => id === "desktop-qwen-deepstack-arabic-full-timestamp-fenced")!;
    const control = fixtures.cases.find(({ id }) => id === "synthetic-unfenced-full-timestamp-control")!;
    expect(captured.raw).toBe('```json\n{\n"amount": 12900,\n"printed_date": "14 Aug 2026 09:47 PM",\n"printed_end_date": "",\n"note": "تمت العملية بنجاح",\n"kind": "settlement",\n"currency": "EGP"\n}\n```');
    expect(captured.promptSha256).toBe(HISTORICAL_LITERAL_PROMPT_SHA256);
    expect(captured).toMatchObject({ hostKind: "ready", strictAccepted: false, projectedDate: "2026-08-14",
      projectedNote: "تمت العملية بنجاح", projectedAmount: 12900, provenance: {
        receipt: "output/playwright/qwen-production-full-model-20260909-uaYIgE/result.json",
        receiptSha256: "f53cb56dc15b29f97f991876e8e6e8b04331e192c30c88af0be5db5e99523687",
        requestId: 1, identicalRepeatRequestId: 3, maxTokens: 96,
        imageSha256: "b93fbf4cb198c70f5da865e98d1b17ac5c2da465c09e8ff60b4ec01d8cc0f68f",
        workerSha256: "2c42b78d399ca81e703285cb667253b50e13acd9d9fde4bd9674016fb0ccba92",
      } });
    expect(control.source).toContain("Synthetic wrapper-only control");
    expect(control.raw).toBe(captured.raw.slice("```json\n".length, -"\n```".length));
    const expected = modelProposalExpectation(captured);
    expect(expected.raw).toMatchObject({ printed_date: "14 Aug 2026 09:47 PM", printed_end_date: "",
      amount: 12900, currency: "EGP", kind: "settlement", note: "تمت العملية بنجاح" });
    expect(checkPackagedResponse(captured.raw, expected)).toMatchObject({ completeJsonObject: false, exact: false });
    expect(checkPackagedResponse(control.raw, expected)).toMatchObject({ completeJsonObject: true, exact: true });
    // The existing date-only oracle remains exact: adding a clock cannot silently widen it.
    expect(checkPackagedResponse(control.raw, modelProposalExpectation({ expectation: "printed-single-date" })).exact).toBe(false);
  });

  it.each(["desktop-qwen-deepstack-arabic-full-timestamp-fenced", "synthetic-unfenced-full-timestamp-control"])(
    "preserves the decoded source-backed full timestamp through app, card and confirmation: %s", (id) => {
      const fixture = fixtures.cases.find((value) => value.id === id)!;
      const expected = modelProposalExpectation(fixture);
      // Supply the exact decoded object to this app-only unit test. The shared real-host replay
      // separately receives fixture.raw unchanged and verifies its actual fenced parsing policy.
      const decodedText = fixture.strictAccepted ? fixture.raw : fixture.raw.slice("```json\n".length, -"\n```".length);
      const { normalized, form, confirmed } = projectPrintedCandidate(JSON.parse(decodedText), expected.sourceTimestamp);
      expect(form).toMatchObject({ amount: "12900", currency: "EGP", kind: "settlement",
        date: "2026-08-14", note: "تمت العملية بنجاح" });
      expect(confirmed).toMatchObject({ amount: 12900, currency: "EGP", kind: "settlement",
        date: "2026-08-14", note: "تمت العملية بنجاح" });
      for (const field of ["printed_date", "printed_end_date", "interval_start", "interval_end"]) {
        expect(normalized).not.toHaveProperty(field);
        expect(confirmed).not.toHaveProperty(field);
      }
      expect(checkPackagedResponse(fixture.raw, expected).exact).toBe(fixture.strictAccepted);
    },
  );

  it.each([
    { date: "14 Aug 2026 09:48 PM", projectedDate: "2026-08-14", reason: "wrong printed minute despite the same card day" },
    { date: "13 Aug 2026 09:47 PM", projectedDate: "2026-08-13", reason: "wrong printed calendar day" },
    { date: "14 Aug 2026 09:99 PM", projectedDate: null, reason: "invalid clock must not be discarded as harmless text" },
  ])("rejects full-timestamp qualification for $reason", ({ date, projectedDate }) => {
    const control = fixtures.cases.find(({ id }) => id === "synthetic-unfenced-full-timestamp-control")!;
    const expected = modelProposalExpectation(control);
    const candidate = { ...JSON.parse(control.raw), printed_date: date };
    const evidence = checkPackagedResponse(JSON.stringify(candidate), expected);
    expect(evidence.completeJsonObject).toBe(true);
    expect(evidence.observed.printed_date).toBe(date);
    expect(evidence.projected.date).toBe(projectedDate);
    expect(evidence.projected.confirmedDate).toBe(projectedDate);
    expect(evidence.dateTypeNoteAccepted).toBe(false);
    expect(evidence.exact).toBe(false);
    const { form, confirmed } = projectPrintedCandidate(candidate, expected.sourceTimestamp);
    expect(form.date || null).toBe(projectedDate);
    expect(confirmed.date ?? null).toBe(projectedDate);
    expect(confirmed).toMatchObject({ amount: 12900, currency: "EGP", kind: "settlement", note: "تمت العملية بنجاح" });
  });

  it("does not qualify a shared prompt from a correct single-date output when its range output regresses", () => {
    const singleDate = fixtures.cases.find(({ id }) => id === "phone-flat-values-single-date-output")!;
    const range = fixtures.cases.find(({ id }) => id === "phone-flat-values-range-regression")!;
    expect(singleDate.promptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(range.promptSha256).toBe(singleDate.promptSha256);
    expect(checkPackagedResponse(singleDate.raw, modelProposalExpectation(singleDate)).exact).toBe(true);
    const evidence = checkPackagedResponse(range.raw, modelProposalExpectation(range));
    expect(evidence.observed).toMatchObject({ amount: 1912.15, currency: "USD", kind: "settlement",
      date: "2024-07-19", interval_start: null, interval_end: null, noteMatches: false });
    expect(evidence.exact).toBe(false);
    expect([singleDate, range].every((fixture) =>
      checkPackagedResponse(fixture.raw, modelProposalExpectation(fixture)).exact)).toBe(false);
  });

  it("retains historical date/type/note success without qualifying the guessed range currency", () => {
    const historicalPromptSha256 = "c79e08cbf13abd38dab634420664cb6dfeea09260b3ed373978db5057477b6dd";
    const ids = ["phone-printed-pair-single-date", "phone-printed-pair-date-range"];
    const pair = fixtures.cases.filter(({ id }) => ids.includes(id));
    expect(pair.map(({ id }) => id)).toEqual(ids);
    const accepted = pair.map((fixture) => {
      expect(fixture.promptSha256).toBe(historicalPromptSha256);
      expect(fixture.source).toContain("real packaged Gemma worker");
      expect(fixture.source).not.toContain("Synthetic");
      const expected = modelProposalExpectation(fixture);
      const evidence = checkPackagedResponse(fixture.raw, expected);
      expect(evidence.observed).toMatchObject({ amount: expected.raw.amount,
        kind: expected.raw.kind, printed_date: expected.raw.printed_date,
        printed_end_date: expected.raw.printed_end_date, noteMatches: true });
      const binding = { frameNonce: "a".repeat(48), requestNonce: "b".repeat(48) };
      const sourceTimestamp = Date.parse(expected.sourceTimestamp);
      const result = processIouRequest({ type: "oc:app-process:request", version: 1, ...binding,
        actionId: iouActionManifest.id, input: { operation: "normalize", modality: "image",
          sourceTimestamp, candidates: [JSON.parse(fixture.raw)] } }, binding);
      if (result.kind !== "candidates") throw new Error("Both real-image fixtures must normalize successfully");
      expect(result.candidates).toHaveLength(1);
      const confirmed = buildConfirmPayload(initToFormState(result.candidates[0], new Date(sourceTimestamp)));
      expect(confirmed).toMatchObject({ amount: expected.raw.amount,
        kind: expected.raw.kind, date: expected.confirmed.date, note: expected.confirmed.note });
      for (const field of ["printed_date", "printed_end_date", "interval_start", "interval_end"]) {
        expect(confirmed).not.toHaveProperty(field);
      }
      expect(evidence.dateTypeNoteAccepted).toBe(true);
      if (fixture.id === "phone-printed-pair-date-range") {
        expect(expected.raw.currency).toBeNull();
        expect(evidence.observed.currency).toBe("USD");
        expect(confirmed.currency).toBe("USD"); // Preserve the actual unsafe projection as evidence.
        expect(evidence.currencyAccepted).toBe(false);
      } else {
        expect(evidence.observed.currency).toBe(expected.raw.currency);
        expect(confirmed.currency).toBe(expected.raw.currency);
        expect(evidence.currencyAccepted).toBe(true);
      }
      return evidence.exact;
    });
    // A passing replay is not new inference, a packaged UI action, or a repeat-device qualification.
    expect(accepted).toEqual([true, false]);
    expect(accepted.every(Boolean)).toBe(false);
  });

  it("preserves both recorded literal-only prompt results including literal currency and IOU mapping", () => {
    const pair = fixtures.cases.filter(({ id }) => id.startsWith("phone-literal-currency-"));
    expect(pair).toHaveLength(2);
    for (const fixture of pair) {
      expect(fixture.promptSha256).toBe(HISTORICAL_LITERAL_PROMPT_SHA256);
      expect(fixture.source).toContain("real packaged Gemma worker");
      const expected = modelProposalExpectation(fixture);
      const evidence = checkPackagedResponse(fixture.raw, expected);
      expect(evidence.exact).toBe(true);
      expect(evidence.currencyAccepted).toBe(true);
      expect(evidence.observed.currency).toBe(expected.raw.currency);
      expect(evidence.projected.currency).toBe(expected.card.currency ?? expected.raw.currency);
      expect(evidence.projected.confirmedCurrency).toBe(expected.confirmed.currency ?? expected.raw.currency);
      if (fixture.expectation === "literal-currency-date-range") {
        expect(evidence.observed.currency).toBe("$");
        expect(evidence.projected.currency).toBe("USD");
        expect(evidence.projected.confirmedCurrency).toBe("USD");
      }
    }
  });

  it.each(["phone-complete-valid-output", "phone-printed-pair-date-range"])(
    "does not qualify historically accepted range fields with a guessed ISO code: %s", (id) => {
      const fixture = fixtures.cases.find((value) => value.id === id)!;
      const expected = modelProposalExpectation(fixture);
      expect(expected.raw.currency).toBeNull();
      const evidence = checkPackagedResponse(fixture.raw, expected);
      expect(evidence.observed.currency).toBe("USD");
      expect(evidence.projected.currency).toBe("USD");
      expect(evidence.projected.confirmedCurrency).toBe("USD");
      expect(evidence.dateTypeNoteAccepted).toBe(true);
      expect(evidence.currencyAccepted).toBe(false);
      expect(evidence.exact).toBe(false);
    },
  );

  it.each(fixtures.cases.filter(({ id }) => id.startsWith("synthetic-currency-omitted-")))(
    "keeps a clearly synthetic complete range control with currency absent: $id", (fixture) => {
      expect(fixture.source).toContain("Synthetic");
      const evidence = checkPackagedResponse(fixture.raw, modelProposalExpectation(fixture));
      expect(evidence.exact).toBe(true);
      expect(evidence.dateTypeNoteAccepted).toBe(true);
      expect(evidence.currencyAccepted).toBe(true);
      expect(evidence.observed.currency).toBeNull();
      expect(evidence.projected.currency).toBeNull();
      expect(evidence.projected.confirmedCurrency).toBeNull();
    },
  );

  it("does not equate host-ready with a complete model result", () => {
    const nested = fixtures.cases.find(({ id }) => id === "phone-nested-endpoints")!;
    expect(nested.hostKind).toBe("ready");
    expect(nested.strictAccepted).toBe(false);
    expect(nested.projectedDate).toBeNull();
    const valid = fixtures.cases.find(({ id }) => id === "phone-complete-valid-output")!;
    expect(valid.hostKind).toBe("ready");
    expect(valid.strictAccepted).toBe(false); // Valid JSON does not ground the guessed ISO currency.
    expect(valid.projectedDate).toBe("2026-07-19");
  });
});
