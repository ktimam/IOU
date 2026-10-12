import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { processLocalArtifactRequest } from "./localProcessorArtifact";
import { createIouLocalAppPackage, iouLocalDraftSchema } from "./localAppPackage";
import { iouActionManifest } from "./actionManifest";
import { createLocalProcessorContext, parseLocalProcessorContext } from "./localProcessorContext";
import type { IouProcessorOptions } from "./localProcessorBridge";
import gemmaLabelDetailsCapture from "./fixtures/gemma-labels-v1-synthetic-invoice-20261003.json";
import gemmaSourceDetailsCapture from "./fixtures/gemma-source-v1-synthetic-invoice-20261003.json";
import qwenLabelDetailsCapture from "./fixtures/qwen-labels-v1-synthetic-invoice-20261003.json";
import qwenSourceDetailsCapture from "./fixtures/qwen-source-v1-synthetic-invoice-20261003.json";

describe.each([
  { model: "Gemma", capture: gemmaLabelDetailsCapture, rows: () => [JSON.parse(gemmaLabelDetailsCapture.rawText)] },
  { model: "Qwen", capture: qwenLabelDetailsCapture, rows: () => JSON.parse(qwenLabelDetailsCapture.rawText) },
])("retained actual synthetic $model labels-v1 capture — offline app replay only", ({ capture, rows }) => {
  it.each([false, true])("preserves heading note and printed direction while stripping Type evidence (with Type: %s)", (withType) => {
    const candidates = rows();
    expect(candidates).toHaveLength(1);
    const raw = candidates[0];
    const savedType = { id: "synthetic-acceptance", name: "Synthetic acceptance", keywords: ["TEST ONLY"],
      direction: "credit" as const, txn_type: "settlement" as const };
    const context = { ...createLocalProcessorContext(withType ? [savedType] : [], "USD"), draftEditorDefaults: "host-v1" };
    const value = { type: "oc:local-process:request", version: 1, actionId: "iou.entry.import", context,
      input: { operation: "normalize_raw", modality: "image", candidates,
        sourceTimestamp: Date.parse(capture.sourceTimestamp) } };
    const before = JSON.stringify(value);
    const result = processLocalArtifactRequest(value, { rawImageMoneyFormat: "total-row", rawImageDetailsFormat: "labels-v1" });
    expect(result).toEqual({ kind: "candidates", sourceIndexes: [0], candidates: [{
      amount: 123.45, currency: "USD", kind: "iou", direction: "debt", date: "2026-09-27",
      note: "SYNTHETIC TEST INVOICE", ...(withType ? { typeId: savedType.id, typeName: savedType.name } : {}),
    }] });
    expect(JSON.stringify(value)).toBe(before);
    for (const field of ["image_heading", "image_type_texts", "direction_text", "description_text", "type_texts",
      "keywords", "draftEditorDefaults", "processorContext"])
      expect(JSON.stringify(result)).not.toContain(field);
    expect(JSON.stringify(result)).not.toContain(raw.direction_text);
    for (const text of raw.type_texts) expect(JSON.stringify(result)).not.toContain(text);
    expect(capture.provenance).toMatchObject({ captureKind: "actual-worker-output",
      candidateActivated: false, activeConfigurationChanged: false });
    expect(capture.provenance.broaderQualification).toMatch(/^(failed:|not established:)/);
    // Exact synthetic replay only: the shipped/default processor remains on its legacy format.
    expect(processLocalArtifactRequest(value)).toEqual({ kind: "error" });
  });
});

describe("retained actual synthetic Gemma source-v1 capture — offline app replay only", () => {
  it.each([false, true])("normalizes actual captured fields without Type masking and strips footer evidence (with Type: %s)", (withType) => {
    // The fixture is an observed worker response, not a hand-authored passing model answer.
    // This test runs no model: it qualifies only the exact capture's IOU processing and DTO.
    const raw = JSON.parse(gemmaSourceDetailsCapture.rawText);
    const savedType = { id: "synthetic-acceptance", name: "Synthetic acceptance", keywords: ["TEST ONLY"],
      direction: "credit" as const, txn_type: "settlement" as const };
    const context = { ...createLocalProcessorContext(withType ? [savedType] : [], "USD"), draftEditorDefaults: "host-v1" };
    const value = { type: "oc:local-process:request", version: 1, actionId: "iou.entry.import", context,
      input: { operation: "normalize_raw", modality: "image", candidates: [raw],
        sourceTimestamp: Date.parse(gemmaSourceDetailsCapture.sourceTimestamp) } };
    const before = JSON.stringify(value);
    const result = processLocalArtifactRequest(value, { rawImageMoneyFormat: "total-row", rawImageDetailsFormat: "source-v1" });
    expect(result).toEqual({ kind: "candidates", sourceIndexes: [0], candidates: [{
      amount: 123.45, currency: "USD", kind: "iou", direction: "debt", date: "2026-09-27", note: "Test stationery",
      ...(withType ? { typeId: savedType.id, typeName: savedType.name } : {}),
    }] });
    expect(JSON.stringify(value)).toBe(before);
    for (const field of ["image_heading", "image_type_texts", "direction_text", "description_text", "type_texts", "keywords", "draftEditorDefaults"])
      expect(JSON.stringify(result)).not.toContain(field);
    for (const text of [raw.note, ...raw.type_texts]) expect(JSON.stringify(result)).not.toContain(text);
    expect(gemmaSourceDetailsCapture.provenance.captureKind).toBe("actual-worker-output");
    expect(gemmaSourceDetailsCapture.provenance.activeConfigurationChanged).toBe(false);
    // This replay does not enable the candidate profile in the shipped/default processor.
    expect(processLocalArtifactRequest(value)).toEqual({ kind: "error" });
  });
});

describe("retained actual synthetic Qwen source-v1 capture — offline app replay only", () => {
  it.each([false, true])("normalizes the exact singleton-array capture without Type masking and strips source evidence (with Type: %s)", (withType) => {
    // The fixture is an observed worker response, not a hand-authored passing model answer.
    // This test runs no model: it qualifies only the exact capture's IOU processing and DTO.
    const raw = JSON.parse(qwenSourceDetailsCapture.rawText);
    expect(raw).toHaveLength(1);
    const savedType = { id: "synthetic-acceptance", name: "Synthetic acceptance", keywords: ["TEST ONLY"],
      direction: "credit" as const, txn_type: "settlement" as const };
    const context = { ...createLocalProcessorContext(withType ? [savedType] : [], "USD"), draftEditorDefaults: "host-v1" };
    const value = { type: "oc:local-process:request", version: 1, actionId: "iou.entry.import", context,
      input: { operation: "normalize_raw", modality: "image", candidates: raw,
        sourceTimestamp: Date.parse(qwenSourceDetailsCapture.sourceTimestamp) } };
    const before = JSON.stringify(value);
    const result = processLocalArtifactRequest(value, { rawImageMoneyFormat: "total-row", rawImageDetailsFormat: "source-v1" });
    expect(result).toEqual({ kind: "candidates", sourceIndexes: [0], candidates: [{
      amount: 123.45, currency: "USD", kind: "iou", direction: "debt", date: "2026-09-27", note: "Test stationery",
      ...(withType ? { typeId: savedType.id, typeName: savedType.name } : {}),
    }] });
    expect(JSON.stringify(value)).toBe(before);
    for (const field of ["image_heading", "image_type_texts", "direction_text", "description_text", "type_texts", "keywords", "draftEditorDefaults"])
      expect(JSON.stringify(result)).not.toContain(field);
    for (const text of [raw[0].heading, raw[0].direction_text, ...raw[0].type_texts]) expect(JSON.stringify(result)).not.toContain(text);
    expect(qwenSourceDetailsCapture.provenance).toMatchObject({
      captureKind: "actual-worker-output", modelId: "qwen3-vl-2b-instruct-q4",
      workerSha256: "04ebc7bcb6a5385745a095ace2ba87e3e474775775dbae31f74d165433b39bd8",
      promptSha256: "d29d58f492529b8640d51338d1f7904784a3001fa10cdd6273637fdc49d7ebc0",
      imageSha256: "418c2c5c8689cd4ca54174e0408aa336c2484eeae56900280ba8f85fd979ef37",
      candidateActivated: false, activeConfigurationChanged: false,
    });
    expect(qwenSourceDetailsCapture.provenance.broaderQualification).toMatch(/^failed:/);
    // This replay does not enable the candidate profile in the shipped/default processor.
    expect(processLocalArtifactRequest(value)).toEqual({ kind: "error" });
  });
});

describe("candidate source-v1 image artifact integration", () => {
  const options: IouProcessorOptions = { rawImageMoneyFormat: "total-row", rawImageDetailsFormat: "source-v1" };
  const raw = { note: "TEST INVOICE", currency_text: "USD", amount_text: "123.45", date_text: "27 September 2026", kind: "iou",
    direction_text: "You owe", description_text: "Test stationery", type_texts: ["TEST ONLY"] };
  const type = { id: "synthetic-type", name: "Synthetic acceptance", keywords: ["TEST ONLY"], direction: "credit" as const, txn_type: "settlement" as const };
  const context = { ...createLocalProcessorContext([type], "USD"), draftEditorDefaults: "host-v1" };
  const request = (candidates: unknown[] = [raw], privateContext: unknown = context) => ({
    type: "oc:local-process:request", version: 1, actionId: "iou.entry.import", context: privateContext,
    input: { operation: "normalize_raw", modality: "image", sourceTimestamp: Date.UTC(2026, 8, 27), candidates },
  });
  it("preserves direction and description without a Type, so matching cannot mask missing extraction", () => {
    expect(processLocalArtifactRequest(request([raw], createLocalProcessorContext([], "USD")), options)).toEqual({
      kind: "candidates", sourceIndexes: [0], candidates: [{ amount: 123.45, currency: "USD", direction: "debt", kind: "iou",
        date: "2026-09-27", note: "Test stationery" }],
    });
  });
  it("selects a private footer Type without masking the host-v1 extracted direction or kind", () => {
    const value = request();
    const before = JSON.stringify(value);
    const result = processLocalArtifactRequest(value, options);
    expect(result).toEqual({ kind: "candidates", sourceIndexes: [0], candidates: [{ amount: 123.45, currency: "USD", direction: "debt",
      kind: "iou", date: "2026-09-27", note: "Test stationery", typeId: type.id, typeName: type.name }] });
    expect(JSON.stringify(value)).toBe(before);
    for (const metadata of ["image_heading", "image_type_texts", "direction_text", "description_text", "type_texts", "TEST ONLY", "keywords", "draftEditorDefaults", "processorContext"])
      expect(JSON.stringify(result)).not.toContain(metadata);
    // The opt-in raw contract does not alter old context semantics.
    expect(processLocalArtifactRequest(request([raw], createLocalProcessorContext([type], "USD")), options))
      .toMatchObject({ candidates: [{ direction: "credit", kind: "iou" }] });
  });
  it("uses heading fallback for an absent description but never substitutes Type text for the note", () => {
    expect(processLocalArtifactRequest(request([{ ...raw, description_text: "" }]), options))
      .toMatchObject({ candidates: [{ note: "TEST INVOICE", typeId: type.id }] });
  });
  it("preserves an 800-character description and full range without exceeding either final note limit", () => {
    const description = ` ${"x".repeat(798)} `;
    const value = request([{ ...raw, description_text: description, date_text: "Sun, Jul 19 - Thu, Aug 6" }]);
    const result = processLocalArtifactRequest({ ...value, input: { ...value.input, sourceTimestamp: Date.UTC(2026, 6, 3) } }, options);
    const expectedNote = `${description} | From Sun, Jul 19 to Thu, Aug 6`;
    expect(result).toMatchObject({ kind: "candidates", candidates: [{ note: expectedNote, date: "2026-07-19" }] });
    const hostLimit = iouLocalDraftSchema.properties.entries.items.properties.note.maxLength;
    expect(hostLimit).toBe(4096);
    expect(iouActionManifest.outputSchema).toHaveProperty("properties.note.maxLength", hostLimit);
    // Source detail limit + both maximum 96-character endpoints + separators stays bounded.
    expect(800 + 96 * 2 + " | From  to ".length).toBeLessThanOrEqual(hostLimit);
    expect(expectedNote.length).toBeLessThanOrEqual(hostLimit);
    expect(processLocalArtifactRequest(request([{ ...raw, description_text: "x".repeat(801) }]), options)).toEqual({ kind: "error" });
  });
  it.each(["note", "heading", "footer"])("fails closed when %s evidence selects another Type", (field) => {
    const other = { ...type, id: "other", name: "Other", keywords: ["SECOND MARKER"] };
    const conflicting = field === "note" ? { ...raw, description_text: "SECOND MARKER" }
      : field === "heading" ? { ...raw, note: "SECOND MARKER" } : { ...raw, type_texts: ["TEST ONLY", "SECOND MARKER"] };
    const result = processLocalArtifactRequest(request([conflicting], { ...createLocalProcessorContext([type, other], "USD"), draftEditorDefaults: "host-v1" }), options);
    expect(result).toMatchObject({ kind: "candidates", candidates: [{ direction: "debt", kind: "iou" }] });
    if (!("candidates" in result)) throw new Error("Expected candidates");
    expect(result.candidates?.[0]).not.toHaveProperty("typeId");
  });
  it("keeps each image row's description, direction and Type evidence isolated from shared text", () => {
    const other = { ...type, id: "other", name: "Other", keywords: ["SECOND MARKER"] };
    const value = request([raw, { ...raw, amount_text: "22.22", description_text: "Second item", direction_text: "Owed to you", type_texts: ["SECOND MARKER"] },
      { ...raw, amount_text: "33.33", description_text: "Third item", direction_text: "", type_texts: [] }],
      { ...createLocalProcessorContext([type, other], "USD"), draftEditorDefaults: "host-v1" });
    const result = processLocalArtifactRequest({ ...value, input: { ...value.input, text: "TEST ONLY SECOND MARKER" } }, options);
    expect(result).toEqual({ kind: "candidates", sourceIndexes: [0, 1, 2], candidates: [
      { amount: 123.45, currency: "USD", direction: "debt", kind: "iou", date: "2026-09-27", note: "Test stationery", typeId: type.id, typeName: type.name },
      { amount: 22.22, currency: "USD", direction: "credit", kind: "iou", date: "2026-09-27", note: "Second item", typeId: other.id, typeName: other.name },
      { amount: 33.33, currency: "USD", direction: "credit", kind: "iou", date: "2026-09-27", note: "Third item" },
    ] });
  });
  it("never lets a request select source-v1, and rejects malformed candidate details", () => {
    expect(processLocalArtifactRequest(request())).toEqual({ kind: "error" });
    expect(processLocalArtifactRequest({ ...request(), rawImageDetailsFormat: "source-v1" }, options)).toEqual({ kind: "error" });
    expect(processLocalArtifactRequest({ ...request(), input: { ...request().input, rawImageDetailsFormat: "source-v1" } }, options)).toEqual({ kind: "error" });
    expect(processLocalArtifactRequest(request([{ ...raw, type_texts: ["TEST ONLY", {}] }]), options)).toEqual({ kind: "error" });
  });
  it.each(["text", "audio", "image"])("only enables image Type evidence for an opted-in image, not default %s normalization", (modality) => {
    const value = { ...request(), input: { operation: "normalize", modality, candidates: [{ amount: 20, currency: "USD", kind: "iou",
      note: "Unmatched description", direction: "debt", image_type_texts: ["TEST ONLY"] }] } };
    const result = processLocalArtifactRequest(value, modality === "image" ? undefined : options);
    expect(result).toMatchObject({ kind: "candidates", candidates: [{ note: "Unmatched description", direction: "debt" }] });
    if (!("candidates" in result)) throw new Error("Expected candidates");
    expect(result.candidates?.[0]).not.toHaveProperty("typeId");
    expect(JSON.stringify(result)).not.toContain("image_type_texts");
  });
});

describe("dormant labels-v1 image artifact integration", () => {
  const options: IouProcessorOptions = { rawImageMoneyFormat: "total-row", rawImageDetailsFormat: "labels-v1" };
  const raw = { note: "SYNTHETIC TEST INVOICE", currency_text: "USD", amount_text: "123.45",
    date_text: "27 September 2026", kind: "iou", direction_text: "You owe", type_texts: ["TEST ONLY"] };
  const type = { id: "synthetic-type", name: "Synthetic acceptance", keywords: ["TEST ONLY"],
    direction: "credit" as const, txn_type: "settlement" as const };
  const context = { ...createLocalProcessorContext([type], "USD"), draftEditorDefaults: "host-v1" };
  const request = (candidates: unknown[] = [raw], privateContext: unknown = context) => ({
    type: "oc:local-process:request", version: 1, actionId: "iou.entry.import", context: privateContext,
    input: { operation: "normalize_raw", modality: "image", sourceTimestamp: Date.UTC(2026, 8, 27), candidates },
  });

  it("matches footer Type evidence without replacing the printed direction, heading note or kind", () => {
    const value = request();
    const before = JSON.stringify(value);
    const result = processLocalArtifactRequest(value, options);
    expect(result).toEqual({ kind: "candidates", sourceIndexes: [0], candidates: [{
      amount: 123.45, currency: "USD", direction: "debt", kind: "iou", date: "2026-09-27",
      note: "SYNTHETIC TEST INVOICE", typeId: type.id, typeName: type.name,
    }] });
    expect(JSON.stringify(value)).toBe(before);
    for (const metadata of ["image_heading", "image_type_texts", "direction_text", "description_text", "type_texts",
      "TEST ONLY", "keywords", "draftEditorDefaults", "processorContext"])
      expect(JSON.stringify(result)).not.toContain(metadata);
    expect(processLocalArtifactRequest(value)).toEqual({ kind: "error" });
  });

  it("authored synthetic labels-v1 row keeps unmatched grounded source text untyped", () => {
    const candidate = { ...raw, note: "Repair slip", type_texts: ["Desk repair"] };
    const value = request([candidate]);
    const before = JSON.stringify(value);
    const result = processLocalArtifactRequest(value, options);
    expect(result).toEqual({ kind: "candidates", sourceIndexes: [0], candidates: [{
      amount: 123.45, currency: "USD", direction: "debt", kind: "iou", date: "2026-09-27",
      note: "Repair slip",
    }] });
    expect(JSON.stringify(value)).toBe(before);
    expect(JSON.stringify(result)).not.toContain("Desk repair");
    expect(JSON.stringify(result)).not.toContain("You owe");
    if (!("candidates" in result)) throw new Error("Expected candidates");
    expect(result.candidates?.[0]).not.toHaveProperty("typeId");
    expect(result.candidates?.[0]).not.toHaveProperty("typeName");
    expect(result.candidates?.[0]).not.toHaveProperty("type_texts");
    expect(result.candidates?.[0]).not.toHaveProperty("direction_text");
  });

  it("keeps the heading note and both printed range endpoints through app-owned post-processing", () => {
    const value = request([{ ...raw, note: "Reservation", date_text: "Sun, Jul 19 - Thu, Aug 6" }]);
    expect(processLocalArtifactRequest({ ...value, input: { ...value.input, sourceTimestamp: Date.UTC(2026, 6, 3) } }, options))
      .toMatchObject({ kind: "candidates", candidates: [{
        date: "2026-07-19", note: "Reservation | From Sun, Jul 19 to Thu, Aug 6", direction: "debt",
      }] });
  });

  it("keeps labels-v1 app-owned and rejects source-v1-only or malformed rows", () => {
    expect(processLocalArtifactRequest({ ...request(), rawImageDetailsFormat: "labels-v1" }, options)).toEqual({ kind: "error" });
    expect(processLocalArtifactRequest({ ...request(), input: { ...request().input, rawImageDetailsFormat: "labels-v1" } }, options))
      .toEqual({ kind: "error" });
    expect(processLocalArtifactRequest(request([{ ...raw, description_text: "Not allowed" }]), options)).toEqual({ kind: "error" });
    expect(processLocalArtifactRequest(request([{ ...raw, type_texts: ["TEST ONLY", {}] }]), options)).toEqual({ kind: "error" });
  });
});

describe("opt-in labels-v2 candidate-bearing Type evidence guard", () => {
  const options: IouProcessorOptions = { rawImageMoneyFormat: "total-row", rawImageDetailsFormat: "labels-v2" };
  const first = { id: "arbitrary-first", name: "Copper Lantern", keywords: ["  ORBIT ZEBRA  ", "حبر أزرق"],
    direction: "debt" as const, txn_type: "iou" as const };
  const second = { id: "arbitrary-second", name: "Silver Kite", keywords: ["MOSS COMPASS"],
    direction: "credit" as const, txn_type: "settlement" as const };
  const context = { ...createLocalProcessorContext([first, second], "USD"), draftEditorDefaults: "host-v1" };
  const raw = { heading: "SYNTHETIC DOCUMENT", total_text: "25 USD", dates: [], kind: "settlement",
    direction_text: "", type_texts: ["Category: orbit zebra"] };
  const request = (candidates: unknown[] = [raw], privateContext: unknown = context) => ({
    type: "oc:local-process:request", version: 1, actionId: "iou.entry.import", context: privateContext,
    input: { operation: "normalize_raw", modality: "image", candidates },
  });

  it.each([
    ["Category: orbit zebra"],
    ["  Copper Lantern  ", "Memo: حبر أزرق"],
    ["Category: ORBIT ZEBRA", "Footer: Copper Lantern"],
  ])("accepts unchanged distinct evidence strings using the saved matcher vocabulary: %j", (...type_texts) => {
    const value = request([{ ...raw, type_texts }]);
    const before = JSON.stringify(value);
    expect(processLocalArtifactRequest(value, options)).toEqual({ kind: "candidates", sourceIndexes: [0], candidates: [{
      amount: 25, currency: "USD", kind: "settlement", direction: "credit", note: raw.heading,
      typeId: first.id, typeName: first.name,
    }] });
    expect(JSON.stringify(value)).toBe(before);
  });

  it.each([
    ["Category: orbit zebra", "Category: orbit zebra"],
    ["Category: orbit zebra", "UNLISTED VALUE", "UNLISTED VALUE", "Category: orbit zebra"],
    ["Category: orbit zebra", "UNLISTED VALUE"],
    [""],
    ["   "],
    ["ORBIT ZEBRAS"],
    ["prefixORBIT ZEBRA"],
    ["ORBIT", "ZEBRA"],
  ])("rejects duplicate, unlisted, partial or cross-string evidence atomically: %j", (...type_texts) => {
    const value = request([{ ...raw, type_texts }]);
    const before = JSON.stringify(value);
    expect(processLocalArtifactRequest(value, options)).toEqual({ kind: "error" });
    expect(JSON.stringify(value)).toBe(before);
  });

  it("rejects every row when a later row contains unlisted evidence, even if its heading matches", () => {
    const value = request([raw, { ...raw, heading: first.name, type_texts: ["UNLISTED VALUE"] }]);
    expect(processLocalArtifactRequest(value, options)).toEqual({ kind: "error" });
  });

  it.each([context, createLocalProcessorContext([], "USD"), undefined])(
    "accepts explicit empty evidence, but not nonempty evidence without configured candidate terms: %j", (privateContext) => {
      const empty = request([{ ...raw, type_texts: [] }], privateContext);
      if (privateContext === undefined) delete (empty as { context?: unknown }).context;
      const result = processLocalArtifactRequest(empty, options);
      expect(result).toEqual({ kind: "candidates", sourceIndexes: [0], candidates: [{
        amount: 25, currency: "USD", kind: "settlement", direction: "credit", note: raw.heading,
      }] });
      if (privateContext === context) return;
      const nonempty = { ...empty, input: { ...empty.input, candidates: [raw] } };
      expect(processLocalArtifactRequest(nonempty, options)).toEqual({ kind: "error" });
    },
  );

  it.each([
    ["Copper Lantern / Silver Kite"],
    ["ORBIT ZEBRA", "MOSS COMPASS"],
  ])("keeps individually listed but conflicting Type evidence ambiguous: %j", (...type_texts) => {
    const result = processLocalArtifactRequest(request([{ ...raw, type_texts }]), options);
    expect(result).toEqual({ kind: "candidates", sourceIndexes: [0], candidates: [{
      amount: 25, currency: "USD", kind: "settlement", direction: "credit", note: raw.heading,
    }] });
  });

  it("leaves source-v1's broader bounded evidence behavior unchanged", () => {
    const value = request([{ ...raw, description_text: "Synthetic memo",
      type_texts: ["ORBIT ZEBRA", "UNLISTED VALUE", "UNLISTED VALUE"] }]);
    expect(processLocalArtifactRequest(value, { ...options, rawImageDetailsFormat: "source-v1" }))
      .toMatchObject({ kind: "candidates", candidates: [{ note: "Synthetic memo", typeId: first.id }] });
  });

  it("leaves labels-v1's broader bounded evidence behavior unchanged, with or without a roster", () => {
    const candidates = [{ ...raw, type_texts: ["ORBIT ZEBRA", "UNLISTED VALUE", "UNLISTED VALUE"] }];
    for (const privateContext of [context, createLocalProcessorContext([], "USD")]) {
      const value = request(candidates, privateContext);
      const before = JSON.stringify(value);
      const result = processLocalArtifactRequest(value, { ...options, rawImageDetailsFormat: "labels-v1" });
      expect(result).toEqual({ kind: "candidates", sourceIndexes: [0], candidates: [{
        amount: 25, currency: "USD", kind: "settlement", direction: "credit", note: raw.heading,
        ...(privateContext === context ? { typeId: first.id, typeName: first.name } : {}),
      }] });
      expect(JSON.stringify(value)).toBe(before);
    }
  });

  it("keeps labels-v2 app-owned and accepts the shared exact wire shape across raw money formats", () => {
    const { total_text: _total, ...row } = raw;
    for (const candidate of [raw, { ...row, total_row: "Total 25 USD" }, {
      note: raw.heading, currency_text: "USD", amount_text: "25", date_text: "", kind: raw.kind,
      direction_text: raw.direction_text, type_texts: raw.type_texts,
    }]) {
      expect(processLocalArtifactRequest(request([candidate]), options))
        .toMatchObject({ kind: "candidates", candidates: [{ amount: 25, typeId: first.id }] });
      expect(processLocalArtifactRequest(request([{ ...candidate, description_text: "Not allowed" }]), options))
        .toEqual({ kind: "error" });
    }
    const value = request();
    expect(processLocalArtifactRequest({ ...value, rawImageDetailsFormat: "labels-v2" }, options)).toEqual({ kind: "error" });
    expect(processLocalArtifactRequest({ ...value, input: { ...value.input, rawImageDetailsFormat: "labels-v2" } }, options))
      .toEqual({ kind: "error" });
  });

  it.each([undefined, { rawImageMoneyFormat: "total-row" } as const, { ...options, rawImageDetailsFormat: "none" } as const])(
    "leaves the default and explicit legacy four-field formats unchanged: %j", (legacyOptions) => {
      const { direction_text: _direction, type_texts: _texts, ...legacyRaw } = raw;
      expect(processLocalArtifactRequest(request([legacyRaw]), legacyOptions)).toEqual({
        kind: "candidates", sourceIndexes: [0], candidates: [{
          amount: 25, currency: "USD", kind: "settlement", direction: "credit", note: raw.heading,
        }],
      });
    },
  );
});

describe("standalone IOU local processor export", () => {
  it("ships the verified compiled processor with the same kind-preserving behavior", () => {
    const source = readFileSync(new URL("../../../public/openchat/local-processor-v1.js", import.meta.url));
    const metadata = JSON.parse(readFileSync(new URL("../../../public/openchat/local-processor-v1.sha256.json", import.meta.url), "utf8"));
    const catalog = JSON.parse(readFileSync(new URL("../../../public/openchat/local-app-v1.json", import.meta.url), "utf8"));
    expect(createHash("sha256").update(source).digest("hex")).toBe(metadata.sha256);
    expect(source.byteLength).toBe(metadata.byteLength);
    expect(catalog.apps[0].processor).toEqual({ sha256: metadata.sha256, byteLength: metadata.byteLength });
    for (const draftEditorDefaults of [undefined, "host-v1"] as const) for (const kind of ["iou", "settlement"] as const) {
      const baseContext = createLocalProcessorContext([{ id: "synthetic-kind", name: "Synthetic booking",
        keywords: ["booking"], direction: "debt", txn_type: kind === "iou" ? "settlement" : "iou" }], "USD");
      const privateCatalog = createIouLocalAppPackage("http://localhost:3000/openchat/import", metadata,
        { processorContext: baseContext, recipientLabel: "Synthetic sheet" });
      const context = draftEditorDefaults ? privateCatalog.apps[0].actions[0].processorContext : baseContext;
      expect(privateCatalog.apps[0].processor).toEqual(catalog.apps[0].processor);
      const request = { type: "oc:local-process:request", version: 1, actionId: "iou.entry.import", context,
        input: { operation: "normalize", modality: "text", text: "booking 20 USD",
          candidates: [{ kind, amount: 20, currency: "USD", direction: "credit", note: "booking" }] } };
      let listener: ((event: { data: unknown }) => void) | undefined;
      const replies: unknown[] = [];
      // Execute the actual shipped worker, without any network capability or app account.
      const worker = createContext({ TextEncoder, TextDecoder, requestJson: JSON.stringify(request),
        dispatch: (event: { data: unknown }) => listener!(event), self: {
        addEventListener: (_name: string, handler: typeof listener) => { listener = handler; },
        postMessage: (value: unknown) => replies.push(JSON.parse(JSON.stringify(value))),
      } });
      runInContext(source.toString("utf8"), worker, { timeout: 1000 });
      expect(listener).toBeTypeOf("function");
      // Real postMessage clones into the worker realm; do not pass foreign VM prototypes.
      runInContext("dispatch({ data: JSON.parse(requestJson) }); dispatch({ data: JSON.parse(requestJson) });", worker, { timeout: 1000 });
      expect(replies).toEqual([processLocalArtifactRequest(request)]);
      expect(replies[0]).toMatchObject({ kind: "candidates", candidates: [{ kind,
        direction: draftEditorDefaults ? "credit" : "debt", typeId: "synthetic-kind", typeName: "Synthetic booking" }] });
    }
  });
  it.each(["iou", "settlement"] as const)("preserves extracted %s kind when a different saved Type matches", (kind) => {
    const context = createLocalProcessorContext([{ id: "synthetic-kind", name: "Synthetic booking",
      keywords: ["booking"], direction: "debt", txn_type: kind === "iou" ? "settlement" : "iou" }], "USD");
    const result = processLocalArtifactRequest({ type: "oc:local-process:request", version: 1,
      actionId: "iou.entry.import", context, input: {
        operation: "normalize", modality: "text", text: "booking 20 USD", candidates: [{
          kind, amount: 20, currency: "USD", direction: "credit", note: "booking",
        }],
      } });
    expect(result).toMatchObject({ kind: "candidates", candidates: [{
      kind, direction: "debt", typeId: "synthetic-kind", typeName: "Synthetic booking",
    }] });
  });
  it.each(["iou", "settlement"] as const)("retains the raw direction and %s kind for an opted-in host choice", (kind) => {
    const baseContext = createLocalProcessorContext([{ id: "private-id", name: "Private booking",
      keywords: ["booking"], direction: "debt", txn_type: kind === "iou" ? "settlement" : "iou" }], "EGP");
    const context = { ...baseContext, draftEditorDefaults: "host-v1" };
    const result = processLocalArtifactRequest({ type: "oc:local-process:request", version: 1,
      actionId: "iou.entry.import", context, input: {
        operation: "normalize", modality: "text", text: "booking 20", candidates: [{
          kind, amount: 20, direction: "credit", note: "booking",
        }],
      } });
    expect(result).toMatchObject({ kind: "candidates", candidates: [{ kind, amount: 20, currency: "EGP",
      direction: "credit", typeId: "private-id", typeName: "Private booking" }] });
    expect(JSON.stringify(result)).not.toContain("draftEditorDefaults");
  });
  it("leaves no-Type processing unchanged in both context modes", () => {
    const context = createLocalProcessorContext([], "EGP");
    const request = { type: "oc:local-process:request", version: 1, actionId: "iou.entry.import", context,
      input: { operation: "normalize", modality: "text", text: "20", candidates: [{ kind: "settlement", amount: 20 }] } };
    const legacy = processLocalArtifactRequest(request);
    expect(processLocalArtifactRequest({ ...request, context: { ...context, draftEditorDefaults: "host-v1" } })).toEqual(legacy);
    expect(legacy).toMatchObject({ kind: "candidates", candidates: [{ kind: "settlement", direction: "debt", currency: "EGP" }] });
    expect(processLocalArtifactRequest({ ...request, context: { ...context, draftEditorDefaults: "unknown" } })).toEqual({ kind: "error" });
  });
  it("keeps image matching and visible date/note intact while exposing the pre-Type direction to the host", () => {
    const context = createLocalProcessorContext([{ id: "image-type", name: "Reservation", keywords: [],
      direction: "debt", txn_type: "settlement" }], "EGP");
    const request = { type: "oc:local-process:request", version: 1, actionId: "iou.entry.import", context,
      input: { operation: "normalize_raw", modality: "image", sourceTimestamp: Date.UTC(2026, 6, 3), candidates: [{
        heading: "Reservation", total_text: "Total Payout $1,912.15", dates: ["Sun, Jul 19", "Thu, Aug 6"], kind: "iou",
      }] } };
    const legacy = processLocalArtifactRequest(request);
    const host = processLocalArtifactRequest({ ...request, context: { ...context, draftEditorDefaults: "host-v1" } });
    expect(legacy).toMatchObject({ kind: "candidates", candidates: [{ direction: "debt", kind: "iou", typeId: "image-type" }] });
    expect(host).toEqual({ kind: "candidates", sourceIndexes: [0], candidates: [{ amount: 1912.15, currency: "USD",
      direction: "credit", kind: "iou", date: "2026-07-19", note: "Reservation | From Sun, Jul 19 to Thu, Aug 6",
      typeId: "image-type", typeName: "Reservation" }] });
  });
  it("does not apply an unmatched Type or expose the context to the outgoing candidate", () => {
    const context = createLocalProcessorContext([{ id: "unmatched", name: "Unmatched", keywords: ["other"],
      direction: "debt", txn_type: "settlement" }], "EGP");
    const request = { type: "oc:local-process:request", version: 1, actionId: "iou.entry.import", context,
      input: { operation: "normalize", modality: "text", text: "Lunch 20", candidates: [{ kind: "iou", amount: 20,
        direction: "credit", note: "Lunch" }] } };
    expect(processLocalArtifactRequest(request)).toEqual(processLocalArtifactRequest({ ...request,
      context: { ...context, draftEditorDefaults: "host-v1" } }));
    expect(processLocalArtifactRequest(request)).toEqual({ kind: "candidates", candidates: [{
      amount: 20, currency: "EGP", direction: "credit", kind: "iou", note: "Lunch" }] });
  });
  it("rejects conflicting acceptance-label dates but accepts the same text with one transaction date", () => {
    const context = createLocalProcessorContext([{ id: "synthetic-acceptance", name: "Synthetic acceptance",
      direction: "debt", txn_type: "iou", keywords: ["TEST ONLY"] }], "USD");
    const text = "TEST ONLY — OpenChat IOU acceptance 2026-09-29\nAmount: 123.45 USD\nDate: 27 September 2026\nDirection: You owe\nNote: Synthetic acceptance; not a real balance.";
    const request = (sourceText: string, privateContext = context) => ({
      type: "oc:local-process:request", version: 1, actionId: "iou.entry.import", context: privateContext,
      input: { operation: "extract", modality: "text", text: sourceText, sourceTimestamp: Date.UTC(2026, 8, 29) },
    });
    expect(processLocalArtifactRequest(request(text))).toEqual({ kind: "ambiguous" });
    // Remove only the run-label date. Do not weaken date ambiguity checks or alter the transaction.
    const singleDate = text.replace(" acceptance 2026-09-29\n", " acceptance\n");
    expect(processLocalArtifactRequest(request(singleDate))).toEqual({ kind: "candidates", candidates: [{
      amount: 123.45, direction: "debt", note: "", currency: "USD", kind: "iou", date: "2026-09-27",
      typeId: "synthetic-acceptance", typeName: "Synthetic acceptance",
    }] });
    // Text cues are sender-relative; the exported matching Type separately supplies its direction.
    const noTypes = createLocalProcessorContext([], "USD");
    expect(processLocalArtifactRequest(request(singleDate, noTypes))).toMatchObject({
      kind: "candidates", candidates: [{ direction: "credit", date: "2026-09-27" }],
    });
    expect(processLocalArtifactRequest(request(singleDate.replace("Direction: You owe", "Direction: I owe"), noTypes))).toMatchObject({
      kind: "candidates", candidates: [{ direction: "debt", date: "2026-09-27" }],
    });
  });
  it("normalizes a raw image and composes the full source range into the visible note", () => {
    expect(processLocalArtifactRequest({ type: "oc:local-process:request", version: 1, actionId: "iou.entry.import", input: {
      operation: "normalize_raw", modality: "image", sourceTimestamp: Date.UTC(2026, 6, 3), candidates: [{
        heading: "Reservation", total_text: "Total Payout $1,912.15", dates: ["Sun, Jul 19", "Thu, Aug 6"], kind: "iou",
      }],
    } })).toEqual({ kind: "candidates", sourceIndexes: [0], candidates: [{
      amount: 1912.15, currency: "USD", direction: "credit", kind: "iou", date: "2026-07-19",
      note: "Reservation | From Sun, Jul 19 to Thu, Aug 6",
    }] });
  });
  it.each([
    { model: "small Qwen", raw: { heading: "SYNTHETIC TEST INVOICE", total_text: "123.45 USD",
      dates: ["27 September 2026"], kind: "iou" } },
    { model: "Gemma", raw: { note: "SYNTHETIC TEST INVOICE", currency_text: "USD", amount_text: "123.45",
      date_text: "27 September 2026", kind: "iou" } },
  ])("characterizes $model's omitted image evidence without claiming source fidelity", ({ raw }) => {
    // Hand-authored representations of the shipped contracts, NOT captured model responses.
    // The independent source oracle also prints these facts, but neither selected profile
    // requests them. Successful parsing cannot recover facts missing from the raw evidence.
    const printed = { direction: "debt", description: "Test stationery", footer: "TEST ONLY" };
    const context = createLocalProcessorContext([{ id: "synthetic-acceptance", name: "Synthetic acceptance",
      direction: "debt", txn_type: "iou", keywords: [printed.footer] }], "USD");
    const request = { type: "oc:local-process:request", version: 1, actionId: "iou.entry.import", context,
      input: { operation: "normalize_raw", modality: "image", sourceTimestamp: Date.UTC(2026, 8, 27), candidates: [raw] } };
    const result = processLocalArtifactRequest(request);
    expect(result).toEqual({ kind: "candidates", sourceIndexes: [0], candidates: [{
      amount: 123.45, currency: "USD", kind: "iou", direction: "credit", date: "2026-09-27",
      note: "SYNTHETIC TEST INVOICE",
    }] });
    if (result.kind !== "candidates" || !("candidates" in result)) throw new Error("Expected a parseable contract");
    const candidate = result.candidates[0];
    expect({
      printedDirectionPreserved: candidate.direction === printed.direction,
      printedDescriptionPreserved: candidate.note === printed.description,
      footerTypeMatched: candidate.typeId === context.types[0].id,
    }).toEqual({ printedDirectionPreserved: false, printedDescriptionPreserved: false, footerTypeMatched: false });
    expect(JSON.stringify(raw)).not.toContain(printed.description);
    expect(JSON.stringify(raw)).not.toContain(printed.footer);
    expect(raw).not.toHaveProperty("direction");
    // A prompt-only extra field is not a fix: exact raw schemas reject the entire row.
    expect(processLocalArtifactRequest({ ...request, input: { ...request.input,
      candidates: [{ ...raw, direction: printed.direction }] } })).toEqual({ kind: "error" });
  });
  it("does not transmit raw source or arbitrary fields and rejects wrong actions", () => {
    const request = { type: "oc:local-process:request", version: 1, actionId: "iou.entry.import", input: {
      operation: "normalize", modality: "text", text: "owe 20 USD", candidates: [{
        amount: 20, currency: "USD", kind: "iou", direction: "debt", note: "Lunch", message: "owe 20 USD", hidden: "secret",
      }],
    } };
    expect(processLocalArtifactRequest(request)).toEqual({ kind: "candidates", candidates: [{
      amount: 20, currency: "USD", kind: "iou", direction: "debt", note: "Lunch",
    }] });
    expect(processLocalArtifactRequest({ ...request, actionId: "other" })).toEqual({ kind: "error" });
  });
  it("exports explicit config without legacy delivery permissions/endpoints", () => {
    const catalog = createIouLocalAppPackage("http://localhost:3000/openchat/import", { sha256: "a".repeat(64), byteLength: 1234 });
    expect(catalog.apps[0].actions[0].definition).not.toHaveProperty("endpoint");
    expect(catalog.apps[0]).not.toHaveProperty("surfaces");
    expect(catalog.apps[0].actions[0].definition.responseSchema).toHaveProperty("x-openchat-image-prompt-by-model");
    expect(catalog.apps[0].actions[0].handoff).toEqual({ kind: "wrapped-list", field: "entries" });
    expect(() => createIouLocalAppPackage("https://iou.example/openchat/import?payload=private", { sha256: "a".repeat(64), byteLength: 1234 })).toThrow();
  });
  it("uses only the explicitly exported private account vocabulary and currency", () => {
    const context = createLocalProcessorContext([{ id: "t1", name: "Stay", keywords: ["booking"], direction: "debt", txn_type: "iou", fee_percent: 50 }], "EGP");
    expect(JSON.stringify(context)).not.toContain("fee");
    expect(Object.isFrozen(context.types[0])).toBe(true);
    const result = processLocalArtifactRequest({ type: "oc:local-process:request", version: 1, actionId: "iou.entry.import", context, input: {
      operation: "normalize", modality: "text", text: "booking 20", candidates: [{ kind: "iou", amount: 20, note: "booking" }],
    } });
    expect(result).toMatchObject({ kind: "candidates", candidates: [{ amount: 20, currency: "EGP", direction: "debt", typeId: "t1", typeName: "Stay" }] });
    expect((result as { candidates: unknown[] }).candidates[0]).not.toHaveProperty("date");
    const catalog = createIouLocalAppPackage("http://localhost:3000/openchat/import", { sha256: "a".repeat(64), byteLength: 1234 }, { processorContext: context, recipientLabel: "Sheet to review" });
    expect(catalog.apps[0].recipientLabel).toBe("Sheet to review");
    expect(catalog.apps[0].actions[0].processorContext).toEqual({ ...context, draftEditorDefaults: "host-v1" });
    const publicCatalog = createIouLocalAppPackage("http://localhost:3000/openchat/import", { sha256: "a".repeat(64), byteLength: 1234 });
    expect(publicCatalog.apps[0].actions[0]).not.toHaveProperty("processorContext");
  });
  it("rejects unknown private context fields, duplicate types and oversized vocabulary", () => {
    const context = { version: 1, types: [{ id: "t1", name: "Stay", keywords: [], direction: "debt", txn_type: "iou" }] };
    expect(parseLocalProcessorContext({ ...context, accountKey: "secret" })).toBeUndefined();
    expect(parseLocalProcessorContext({ ...context, types: [...context.types, ...context.types] })).toBeUndefined();
    expect(parseLocalProcessorContext({ ...context, defaultCurrency: "invalid" })).toBeUndefined();
    expect(parseLocalProcessorContext({ ...context, types: [{ ...context.types[0], keywords: ["x".repeat(129)] }] })).toBeUndefined();
  });
});
