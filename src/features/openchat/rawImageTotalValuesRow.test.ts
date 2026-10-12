import { describe, expect, it } from "vitest";
import { normalizeRawImageTotalValuesRow } from "./rawImageTotalValuesRow";
import { normalizeRawImageTotalRowText } from "./rawImageTotalRow";
import { processLocalArtifactRequest } from "./localProcessorArtifact";
import { createLocalProcessorContext } from "./localProcessorContext";
import { iouImageProcessorOptions } from "./modelImageProfiles";

const row = (direction: unknown = "You owe"): { values: unknown[] } => ({
  values: ["Invoice A", "Total 12.34 USD", ["1 October 2026"], "iou", direction],
});
const named = (direction: unknown = "You owe") => ({
  heading: "Invoice A", total_text: "Total 12.34 USD", dates: ["1 October 2026"],
  kind: "iou", direction_text: direction,
});
const sourceTimestamp = Date.parse("2026-07-03T12:00:00Z");
const options = { rawImageMoneyFormat: "total-row", rawImageDetailsFormat: "direction-v1" } as const;

// Test-only composition through the existing public-evidence projection. The raw
// five-slot representation is deliberately NOT wired into the public processor.
function project(rows: unknown[], context?: unknown, text?: string) {
  const candidates = rows.map(normalizeRawImageTotalValuesRow);
  if (candidates.some(candidate => candidate === undefined)) return { kind: "error" };
  return processLocalArtifactRequest({
    type: "oc:local-process:request", version: 1, actionId: "iou.entry.import",
    ...(context === undefined ? {} : { context }),
    input: { operation: "normalize", modality: "image", sourceTimestamp, candidates,
      ...(text === undefined ? {} : { text }) },
  }, options);
}

// Authored synthetic contract inputs, not captured model output or image qualification.
describe("inactive total-five-v1 values-row representation", () => {
  it.each(["You owe", "Owed to you", "you OWE", "", null])(
    "delegates unchanged total-row/direction validation for %j", direction => {
      const compact = row(direction), before = JSON.stringify(compact);
      expect(normalizeRawImageTotalValuesRow(compact)).toEqual(normalizeRawImageTotalRowText(named(direction), "direction-v1"));
      expect(normalizeRawImageTotalValuesRow(compact)).toMatchObject({ amount: 12.34, currency: "USD", kind: "iou",
        note: "Invoice A", image_heading: "Invoice A", printed_date: "1 October 2026", printed_end_date: "" });
      expect(JSON.stringify(compact)).toBe(before);
      expect(normalizeRawImageTotalValuesRow(compact)).not.toHaveProperty("values");
    },
  );

  it("retains a full printed period and the app's existing currency mapping", () => {
    const compact = { values: ["Equipment hire", "Total Payout $1,912.15", ["Sun, Jul 19", "Thu, Aug 6"], "iou", ""] };
    expect(normalizeRawImageTotalValuesRow(compact)).toEqual({ amount: 1912.15, currency: "USD", kind: "iou",
      note: "Equipment hire", image_heading: "Equipment hire", printed_date: "Sun, Jul 19", printed_end_date: "Thu, Aug 6" });
    expect(project([compact])).toEqual({ kind: "candidates", candidates: [{ amount: 1912.15, currency: "USD", kind: "iou",
      direction: "credit", date: "2026-07-19", note: "Equipment hire | From Sun, Jul 19 to Thu, Aug 6" }] });
  });

  it.each(["", null])("keeps absent source date/direction absent before app defaults: %j", direction => {
    const compact = { values: ["Service invoice", "Total 42.75 EUR", [], "iou", direction] };
    expect(normalizeRawImageTotalValuesRow(compact)).toEqual({ amount: 42.75, currency: "EUR", kind: "iou",
      note: "Service invoice", image_heading: "Service invoice" });
    // The existing app default is not evidence that a direction was printed.
    expect(project([compact])).toEqual({ kind: "candidates", candidates: [{ amount: 42.75, currency: "EUR",
      kind: "iou", direction: "credit", note: "Service invoice" }] });
  });

  it("does not invent a unit, note or direction when its slots contain no such evidence", () => {
    expect(normalizeRawImageTotalValuesRow({ values: ["", "12.34", [], "settlement", ""] }))
      .toEqual({ amount: 12.34, kind: "settlement" });
  });

  it.each([0, 1, 2, 3, 4, 6, 10])("rejects wrong slot count %i", count => {
    expect(normalizeRawImageTotalValuesRow({ values: Array.from({ length: count }, () => "") })).toBeUndefined();
  });

  it.each([0, 1, 3, 4])("rejects nonstring scalar slot %i without coercion", index => {
    for (const invalid of [0, false, [], {}, undefined, ...(index === 4 ? [] : [null])]) {
      const compact = row(); compact.values[index] = invalid;
      expect(normalizeRawImageTotalValuesRow(compact)).toBeUndefined();
    }
  });

  it.each([
    [0, "Heading\ncontinued"], [0, "bad\u202eheading"], [0, "x".repeat(801)],
    [1, "Total 12,34 USD"], [1, "Total 12.345 USD"], [1, "USD 12.34 EUR"],
    [1, "First 12.34 USD then 56.78 EUR"], [1, "Total -12.34 USD"],
    [1, "Total 900719925474099.99 USD"], [1, "Total 0 USD"], [1, "x".repeat(193)],
    [3, "paid"], [3, ""], [4, "debt"], [4, "credit"], [4, "Direction: You owe"],
    [4, "You owe me"], [4, "You owe | Owed to you"], [4, "You\nowe"], [4, "You owe\u202e"],
  ])("retains strict semantic rejection in slot %i: %j", (index, invalid) => {
    const compact = row(); compact.values[Number(index)] = invalid;
    expect(normalizeRawImageTotalValuesRow(compact)).toBeUndefined();
  });

  it.each([
    undefined, null, "1 October 2026", {}, [null], [1], [""], [" 1 October 2026"],
    ["1 October 2026\n"], ["31 February 2026"], ["From Heading to Total"],
    ["1 October 2026", "2 October 2026", "3 October 2026"],
    ["2 October 2026", "1 October 2026"], ["x".repeat(97)],
  ].map(dates => ({ dates })))("rejects malformed date slots without salvage: $dates", ({ dates }) => {
    const compact = row(); compact.values[2] = dates;
    expect(normalizeRawImageTotalValuesRow(compact)).toBeUndefined();
  });

  it("requires one own enumerable values property and dense own enumerable slots", () => {
    const sparse = row(); delete sparse.values[1];
    const extra = row(); Object.assign(extra.values, { extra: true });
    const symbol = row(); Object.assign(symbol.values, { [Symbol("extra")]: true });
    const hidden = Object.defineProperty(row(), "extra", { value: true });
    const hiddenWrapper = Object.defineProperty({}, "values", { value: row().values });
    const hiddenSlot = row(); Object.defineProperty(hiddenSlot.values, "1", { enumerable: false });
    for (const invalid of [undefined, null, {}, row().values, JSON.stringify(row()),
      { values: row().values, note: "extra" }, { values: row().values, [Symbol("extra")]: true },
      Object.create({ values: row().values }), sparse, extra, symbol, hidden, hiddenWrapper, hiddenSlot])
      expect(normalizeRawImageTotalValuesRow(invalid)).toBeUndefined();
    expect(normalizeRawImageTotalValuesRow(Object.assign(Object.create(null), row())))
      .toEqual(normalizeRawImageTotalValuesRow(row()));
  });

  it("rejects nested date-array holes, hidden/extra/symbol properties and subclasses", () => {
    class Extended extends Array<unknown> {}
    const sparse = ["1 October 2026"]; delete sparse[0];
    const hidden = Object.defineProperty(["1 October 2026"], "0", { enumerable: false });
    const extra = Object.assign(["1 October 2026"], { extra: true });
    const symbol = Object.assign(["1 October 2026"], { [Symbol("extra")]: true });
    const inherited = ["1 October 2026"]; Object.setPrototypeOf(inherited, Object.create(Array.prototype));
    for (const dates of [sparse, hidden, extra, symbol, inherited, Extended.from(["1 October 2026"])]) {
      const compact = row(); compact.values[2] = dates;
      expect(normalizeRawImageTotalValuesRow(compact)).toBeUndefined();
    }
    expect(normalizeRawImageTotalValuesRow({ values: Extended.from(row().values) })).toBeUndefined();
    const inheritedSlots = row(); Object.setPrototypeOf(inheritedSlots.values, Object.create(Array.prototype));
    expect(normalizeRawImageTotalValuesRow(inheritedSlots)).toBeUndefined();
  });

  it("does not invoke getters at any of the wrapper, slot or date boundaries", () => {
    let reads = 0;
    const outer = Object.defineProperty({}, "values", { enumerable: true, get() { reads++; return row().values; } });
    const slot = row(); Object.defineProperty(slot.values, "1", { enumerable: true, get() { reads++; return "12.34 USD"; } });
    const dates = ["1 October 2026"];
    Object.defineProperty(dates, "0", { enumerable: true, get() { reads++; return "1 October 2026"; } });
    const nested = row(); nested.values[2] = dates;
    for (const invalid of [outer, slot, nested]) expect(normalizeRawImageTotalValuesRow(invalid)).toBeUndefined();
    expect(reads).toBe(0);
  });

  it("catches throwing descriptor/prototype traps without accepting a partial row", () => {
    const badOuter = new Proxy(row(), { ownKeys() { throw new Error("untrusted"); } });
    const badRow = row(); badRow.values = new Proxy(badRow.values, { getPrototypeOf() { throw new Error("untrusted"); } });
    const badDates = row(); badDates.values[2] = new Proxy(["1 October 2026"], { ownKeys() { throw new Error("untrusted"); } });
    for (const invalid of [badOuter, badRow, badDates]) expect(normalizeRawImageTotalValuesRow(invalid)).toBeUndefined();
  });

  it("preserves frozen caller-owned JSON data without mutation or date-array reuse", () => {
    const compact = Object.freeze({ values: Object.freeze([
      "Invoice A", "Total 12.34 USD", Object.freeze(["1 October 2026"]), "iou", "You owe",
    ]) });
    const result = normalizeRawImageTotalValuesRow(compact);
    expect(result).toEqual(normalizeRawImageTotalValuesRow(row()));
    expect(result).not.toHaveProperty("dates");
  });

  it("keeps independent rows and ranges through the existing pure Type/card pipeline", () => {
    const a = row(), b = { values: ["Invoice B", "Total 56.78 EUR", ["2 October 2026", "3 October 2026"], "iou", "Owed to you"] };
    const context = createLocalProcessorContext([
      { id: "type-a", name: "Invoice A", keywords: [], direction: "credit", txn_type: "settlement" },
    ], "USD");
    const before = JSON.stringify([a, b]);
    // A shared caption must not select A's Type or smear its dates onto B.
    const result = project([a, b], { ...context, draftEditorDefaults: "host-v1" }, "Invoice A from 7 July 2026 to 8 July 2026");
    expect(result).toEqual({ kind: "candidates", candidates: [
      { amount: 12.34, currency: "USD", kind: "iou", direction: "debt", date: "2026-10-01", note: "Invoice A", typeId: "type-a", typeName: "Invoice A" },
      { amount: 56.78, currency: "EUR", kind: "iou", direction: "credit", date: "2026-10-02", note: "Invoice B | From 2 October 2026 to 3 October 2026" },
    ] });
    expect(JSON.stringify([a, b])).toBe(before);
    expect(JSON.stringify(result)).not.toMatch(/values|direction_text|image_heading|printed_date|interval_start/);
    // Existing legacy Type defaults and host-v1 extracted baselines stay distinct.
    expect(project([a], context)).toMatchObject({ candidates: [{ direction: "credit", kind: "iou", typeId: "type-a" }] });
  });

  it("retains ambiguous/no-match Type behavior without a model-supplied private ID", () => {
    const context = createLocalProcessorContext([
      { id: "type-a", name: "First", keywords: ["Invoice A"], direction: "credit", txn_type: "iou" },
      { id: "type-b", name: "Second", keywords: ["Invoice A"], direction: "credit", txn_type: "iou" },
    ], "USD");
    const result = project([row()], context);
    expect(result).toEqual({ kind: "candidates", candidates: [{ amount: 12.34, currency: "USD", kind: "iou",
      direction: "debt", date: "2026-10-01", note: "Invoice A" }] });
    expect(normalizeRawImageTotalValuesRow({ ...row(), typeId: "type-a" })).toBeUndefined();
  });

  it("never expands nested rows, filters failed rows or repairs B's direction prefix", () => {
    const a = row(), b = row("Direction: You owe");
    for (const invalid of [{ values: [a.values, row().values] }, { entries: [a] },
      { values: [...a.values, ...row().values] }, a.values]) expect(normalizeRawImageTotalValuesRow(invalid)).toBeUndefined();
    expect(project([a, b])).toEqual({ kind: "error" });
    expect(project([b, a])).toEqual({ kind: "error" });
    expect(normalizeRawImageTotalValuesRow(a)).toBeDefined();
    expect(normalizeRawImageTotalValuesRow(b)).toBeUndefined();
  });

  it("remains inactive: existing raw processors and shared active options do not accept it", () => {
    const request = { type: "oc:local-process:request", version: 1, actionId: "iou.entry.import",
      input: { operation: "normalize_raw", modality: "image", sourceTimestamp, candidates: [row()] } };
    expect(processLocalArtifactRequest(request)).toEqual({ kind: "error" });
    expect(processLocalArtifactRequest(request, options)).toEqual({ kind: "error" });
    expect(processLocalArtifactRequest(request, { ...options, rawImageValuesRowFormat: "split-six-v1" })).toEqual({ kind: "error" });
    expect(processLocalArtifactRequest(request, { ...options, rawImageValuesRowFormat: "split-six-v2" })).toEqual({ kind: "error" });
    expect(iouImageProcessorOptions).toEqual({ rawImageMoneyFormat: "total-row" });
  });
});
