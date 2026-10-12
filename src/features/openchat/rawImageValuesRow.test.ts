import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import candidate from "../../../docs/model-prompts/direction-v1-values-row-candidate.json";
import prior from "../../../docs/model-prompts/direction-v1-revision2-candidate.json";
import grouping from "../../../docs/model-prompts/direction-v1-grouping-candidate.json";
import { normalizeRawImageValuesRow } from "./rawImageValuesRow";
import { normalizeRawImageEvidence } from "./rawImageEvidence";
import { processLocalArtifactRequest } from "./localProcessorArtifact";
import { processIouRequest, type IouProcessorOptions } from "./localProcessorBridge";
import { createLocalProcessorContext } from "./localProcessorContext";
import { iouImageProcessorOptions, readIouModelImageProfiles } from "./modelImageProfiles";

const options = { rawImageMoneyFormat: "total-row", rawImageDetailsFormat: "direction-v1", rawImageValuesRowFormat: "split-six-v1" } as const;
const named = (direction: unknown = "You owe") => ({ note: "Invoice A", currency_text: "USD", amount_text: "12.34", date_text: "1 October 2026", kind: "iou", direction_text: direction });
const row = (direction: unknown = "You owe") => ({ values: Object.values(named(direction)) });
const input = (rows: unknown[]) => ({ operation: "normalize_raw", modality: "image", candidates: rows, sourceTimestamp: Date.parse("2026-07-03T12:00:00Z") });
const binding = { frameNonce: "a".repeat(48), requestNonce: "b".repeat(48) };
const bridge = (rows: unknown[], selected: IouProcessorOptions = options) => processIouRequest({ type: "oc:app-process:request", version: 1, actionId: "iou.entry.import", ...binding, input: input(rows) }, binding, selected);
const artifact = (rows: unknown[], context?: unknown, selected: IouProcessorOptions = options) => processLocalArtifactRequest({ type: "oc:local-process:request", version: 1, actionId: "iou.entry.import", input: input(rows), ...(context === undefined ? {} : { context }) }, selected);

// Authored contract inputs; none are new model results or image qualification.
describe("inactive split-six-v1 values-row representation", () => {
  it.each(["You owe", "Owed to you", "", null])("losslessly reuses existing field validation for direction %j", direction => {
    const compact = row(direction), before = JSON.stringify(compact);
    expect(normalizeRawImageValuesRow(compact)).toEqual(normalizeRawImageEvidence(named(direction), "labeled-values", "direction-v1"));
    expect(JSON.stringify(compact)).toBe(before);
    expect(normalizeRawImageValuesRow(compact)).not.toHaveProperty("values");
  });
  it("preserves the complete printed date range, currency token and heading", () => {
    const compact = { values: ["Booking", "$", "1,912.15", "Sun, Jul 19 | Thu, Aug 6", "iou", ""] };
    expect(normalizeRawImageValuesRow(compact)).toEqual({ amount: 1912.15, currency: "USD", kind: "iou", note: "Booking", image_heading: "Booking", printed_date: "Sun, Jul 19", printed_end_date: "Thu, Aug 6" });
    expect(artifact([compact])).toMatchObject({ kind: "candidates", sourceIndexes: [0], candidates: [{ amount: 1912.15, currency: "USD", kind: "iou", date: "2026-07-19", direction: "credit" }] });
  });
  it("keeps absent date and direction absent until existing app defaults", () => {
    const compact = { values: ["Service invoice", "EUR", "42.75", "", "iou", null] };
    const evidence = normalizeRawImageValuesRow(compact);
    expect(evidence).not.toHaveProperty("direction"); expect(evidence).not.toHaveProperty("printed_date");
    expect(artifact([compact])).toEqual({ kind: "candidates", sourceIndexes: [0], candidates: [{ amount: 42.75, currency: "EUR", kind: "iou", direction: "credit", note: "Service invoice" }] });
  });
  it.each([0, 1, 2, 3, 4, 5, 7, 12])("rejects wrong slot count %i", count => {
    expect(normalizeRawImageValuesRow({ values: Array.from({ length: count }, () => "") })).toBeUndefined();
  });
  it.each([0, 1, 2, 3, 4, 5])("rejects nonstring/unsafe slot %i without coercion", index => {
    for (const invalid of [1, false, [], {}, undefined, "bad\u202evalue", ...(index === 5 ? [] : [null])]) {
      const compact = row(); compact.values[index] = invalid;
      expect(normalizeRawImageValuesRow(compact)).toBeUndefined();
    }
  });
  it.each([
    [0, "line\nbreak"], [1, "USD EUR"], [2, "12.34 USD"], [2, "12,34"],
    [3, "From Heading to Total"], [3, "1 Oct 2026 | 2 Oct 2026 | 3 Oct 2026"],
    [4, "paid"], [5, "debt"], [5, "You owe | Owed to you"],
  ])("retains strict semantic validation in slot %i", (index, invalid) => {
    const compact = row(); compact.values[Number(index)] = invalid;
    expect(normalizeRawImageValuesRow(compact)).toBeUndefined();
  });
  it("requires exactly one own values key and exactly six dense own data slots", () => {
    const sparse = row(); delete sparse.values[2];
    const extra = row(); Object.assign(extra.values, { extra: true });
    const symbol = row(); Object.assign(symbol.values, { [Symbol("extra")]: true });
    const hidden = Object.defineProperty(row(), "extra", { value: true });
    const inherited = Object.create({ values: row().values });
    for (const invalid of [undefined, null, {}, row().values, { values: row().values, note: "extra" },
      { values: row().values, [Symbol("extra")]: true }, sparse, extra, symbol, hidden, inherited, JSON.stringify(row())])
      expect(normalizeRawImageValuesRow(invalid)).toBeUndefined();
    const nullPrototype = Object.assign(Object.create(null), row());
    expect(normalizeRawImageValuesRow(nullPrototype)).toEqual(normalizeRawImageValuesRow(row()));
  });
  it("does not invoke getters at the decoder or bridge's pre-serialization boundary", () => {
    let reads = 0;
    const outer = Object.defineProperty({}, "values", { enumerable: true, get() { reads++; return row().values; } });
    const inner = row(); Object.defineProperty(inner.values, "2", { enumerable: true, get() { reads++; return "12.34"; } });
    for (const invalid of [outer, inner]) {
      expect(normalizeRawImageValuesRow(invalid)).toBeUndefined();
      expect(bridge([invalid])).toEqual({ kind: "error" });
    }
    expect(reads).toBe(0);
  });
  it("rejects array subclasses, inherited slots, hidden slots and throwing traps", () => {
    class Extended extends Array<unknown> {}
    const inherited = row(); Object.setPrototypeOf(inherited.values, Object.create(Array.prototype));
    const hidden = row(); Object.defineProperty(hidden.values, "2", { value: "12.34", enumerable: false });
    const proxy = new Proxy(row(), { ownKeys() { throw new Error("untrusted"); } });
    for (const invalid of [{ values: Extended.from(row().values) }, inherited, hidden, proxy]) {
      expect(normalizeRawImageValuesRow(invalid)).toBeUndefined(); expect(bridge([invalid])).toEqual({ kind: "error" });
    }
  });
  it("keeps one raw object per normalized row with exact order/source indexes", () => {
    const rows = [row(), { values: ["Invoice B", "EUR", "56.78", "2 October 2026", "iou", "Owed to you"] }];
    const original = JSON.stringify(rows), result = artifact(rows);
    expect(result).toMatchObject({ kind: "candidates", sourceIndexes: [0, 1], candidates: [
      { amount: 12.34, currency: "USD", date: "2026-10-01", kind: "iou", direction: "debt", note: "Invoice A" },
      { amount: 56.78, currency: "EUR", date: "2026-10-02", kind: "iou", direction: "credit", note: "Invoice B" },
    ] });
    expect(JSON.stringify(rows)).toBe(original);
    expect(JSON.stringify(result)).not.toMatch(/values|direction_text|image_heading|printed_date/);
  });
  it("never expands a wrapper into multiple rows, drops invalid rows or salvages slots", () => {
    const a = row(), b = row("Owed to you");
    for (const rows of [[{ values: [a.values, b.values] }], [{ entries: [a, b] }], [a.values, b.values],
      [a, { values: b.values.slice(0, 5) }], [{ values: [...a.values, ...b.values] }]])
      expect(bridge(rows)).toEqual({ kind: "error" });
    expect(bridge([])).toEqual({ kind: "error" });
    expect(bridge(Array.from({ length: 17 }, row))).toEqual({ kind: "error" });
    expect(bridge(Array.from({ length: 16 }, () => row()))).toMatchObject({ kind: "candidates", sourceIndexes: Array.from({ length: 16 }, (_, index) => index) });
  });
  it("requires trusted app configuration and preserves legacy defaults/named forms", () => {
    expect(artifact([row()], undefined, {})).toEqual({ kind: "error" });
    expect(artifact([row()], undefined, { rawImageDetailsFormat: "direction-v1" })).toEqual({ kind: "error" });
    expect(artifact([{ ...row(), rawImageValuesRowFormat: "split-six-v1" }])).toEqual({ kind: "error" });
    for (const invalid of [{ ...options, rawImageValuesRowFormat: "guess" }, { ...options, rawImageDetailsFormat: "none" }, { rawImageValuesRowFormat: "split-six-v1" }])
      expect(bridge([row()], invalid as IouProcessorOptions)).toEqual({ kind: "error" });
    expect(artifact([named()], undefined, options)).toEqual(artifact([named()], undefined, { rawImageDetailsFormat: "direction-v1" }));
    const legacy = { note: "Invoice", currency_text: "USD", amount_text: "12.34", date_text: "", kind: "iou" };
    expect(artifact([legacy], undefined, {})).toMatchObject({ kind: "candidates", candidates: [{ direction: "credit" }] });
    expect(iouImageProcessorOptions).toEqual({ rawImageMoneyFormat: "total-row" });
  });
  it("preserves matched Type legacy override and host-v1 extracted baseline", () => {
    const context = createLocalProcessorContext([{ id: "matched", name: "Invoice A", keywords: [], direction: "credit", txn_type: "settlement" }], "USD");
    expect(artifact([row()], context)).toMatchObject({ kind: "candidates", candidates: [{ direction: "credit", kind: "iou", typeId: "matched" }] });
    expect(artifact([row()], { ...context, draftEditorDefaults: "host-v1" })).toMatchObject({ kind: "candidates", candidates: [{ direction: "debt", kind: "iou", typeId: "matched" }] });
  });
  it("freezes the explicit opt-in configuration and keeps inactive model changes isolated", () => {
    const parsed = readIouModelImageProfiles(candidate);
    expect(parsed.processorOptions).toEqual(options); expect(Object.isFrozen(parsed.processorOptions)).toBe(true);
    expect(candidate.templates["qwen3-vl-2b-instruct-q4"]).toEqual(prior.templates["qwen3-vl-2b-instruct-q4"]);
    expect(grouping.templates["gemma-4-e2b-it-q4"]).toEqual(prior.templates["gemma-4-e2b-it-q4"]);
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    expect(sha(candidate.templates["gemma-4-e2b-it-q4"].template)).toBe("bdfca3297c574893ed10d714b583d51a722e4c68db0eae985216c2fcb6ad4ede");
    expect(sha(grouping.templates["qwen3-vl-2b-instruct-q4"].template)).toBe("23e98634fb3943174f22ebcafc936f8a5b31e1861161d956772d3c0c5ad5dce1");
    for (const invalid of [undefined, "guess", null]) expect(() => readIouModelImageProfiles({ ...candidate, processorOptions: { ...options, rawImageValuesRowFormat: invalid } })).toThrow();
    for (const details of [undefined, "none", "source-v1", "labels-v1", "labels-v2"]) expect(() => readIouModelImageProfiles({ ...candidate, processorOptions: { ...options, rawImageDetailsFormat: details } })).toThrow();
    expect(iouImageProcessorOptions).toEqual({ rawImageMoneyFormat: "total-row" });
  });
});
