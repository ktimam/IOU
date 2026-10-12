import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import candidate from "../../../docs/model-prompts/direction-v1-values-row-v2-candidate.json";
import prior from "../../../docs/model-prompts/direction-v1-values-row-candidate.json";
import capture from "./fixtures/gemma-values-r3-synthetic-20261005.json";
import { normalizeRawImageValuesRow } from "./rawImageValuesRow";
import { normalizeRawImageEvidence } from "./rawImageEvidence";
import { processLocalArtifactRequest } from "./localProcessorArtifact";
import { processIouRequest } from "./localProcessorBridge";
import { createLocalProcessorContext } from "./localProcessorContext";
import { iouImageProcessorOptions, readIouModelImageProfiles } from "./modelImageProfiles";

const options = { rawImageMoneyFormat: "total-row", rawImageDetailsFormat: "direction-v1", rawImageValuesRowFormat: "split-six-v2" } as const;
const row = (currency: unknown = "USD", amount: unknown = "123.45 USD") => ({ values: ["Invoice", currency, amount, "27 September 2026", "iou", "You owe"] });
const input = (candidates: unknown[]) => ({ operation: "normalize_raw", modality: "image", candidates, sourceTimestamp: Date.parse("2026-09-27T12:00:00Z") });
const request = (rows: unknown[], context?: unknown) => ({ type: "oc:local-process:request", version: 1, actionId: "iou.entry.import", input: input(rows), ...(context ? { context } : {}) });
const artifact = (rows: unknown[], context?: unknown) => processLocalArtifactRequest(request(rows, context), options);

describe("inactive split-six-v2 corroborated literal-unit grammar", () => {
  it.each([
    ["USD", "123.45", 123.45, "USD"], ["USD", "USD 123.45", 123.45, "USD"], ["USD", "123.45 USD", 123.45, "USD"],
    ["$", "$ 123.45", 123.45, "USD"], ["$", "123.45 $", 123.45, "USD"],
    ["EGP", "EGP 12,900", 12900, "EGP"], ["EGP", "12,900 EGP", 12900, "EGP"],
    ["USD", "0.01 USD", 0.01, "USD"], ["USD", "USD 123.4", 123.4, "USD"],
  ])("accepts whole corroborated %s / %s using unchanged numeric validation", (currency, amount, expected, code) => {
    const raw = row(currency, amount), before = JSON.stringify(raw);
    expect(normalizeRawImageValuesRow(raw, "split-six-v2")).toMatchObject({ amount: expected, currency: code, direction: "debt", printed_date: "27 September 2026" });
    expect(JSON.stringify(raw)).toBe(before);
  });

  it.each([
    ["USD", "$ 123.45"], ["$", "123.45 USD"], ["USD", "123.45 EUR"], ["", "123.45 USD"],
    ["USD", "USD 123.45 USD"], ["USD", "123.45 USD 6.78"], ["USD", "Total 123.45 USD"],
    ["USD", "123.45USD"], ["USD", "USD123.45"], ["USD", "123.45  USD"], ["USD", "USD  123.45"],
    ["USD", "123.45 USD "], ["USD", " USD 123.45"], ["USD", "123.45\tUSD"], ["USD", "123.45\u00a0USD"],
    ["USD", "123.45\nUSD"], ["USD", "123.45 \u202eUSD"], ["USD", "12,34 USD"], ["USD", "123.456 USD"],
    ["USD", "-123.45 USD"], ["USD", "+123.45 USD"], ["USD", "1e2 USD"], ["USD", "0 USD"],
    ["USD", "01 USD"], ["USD", "1. USD"], ["USD", ".5 USD"], ["USD", "90071992547409.92 USD"],
    ["USD", "9".repeat(129) + " USD"], [" USD", " USD 123.45"], ["usd", "123.45 usd"],
    ["USD\n", "123.45 USD\n"], ["US\u200bD", "123.45 US\u200bD"], ["unknown", "123.45 unknown"],
    ["USD", null], [null, "123.45"], ["USD", 123.45], ["USD", { amount: "123.45" }],
  ])("rejects units, amounts or grammar that are not exactly corroborated: %j / %j", (currency, amount) => {
    expect(normalizeRawImageValuesRow(row(currency, amount), "split-six-v2")).toBeUndefined();
    expect(artifact([row(currency, amount)])).toEqual({ kind: "error" });
  });

  it("preserves null-prototype data while rejecting accessors, inherited slots and whole wrappers", () => {
    expect(normalizeRawImageValuesRow(Object.assign(Object.create(null), row()), "split-six-v2")).toBeDefined();
    let reads = 0;
    const getter = Object.defineProperty({}, "values", { enumerable: true, get() { reads++; return row().values; } });
    const slot = row(); Object.defineProperty(slot.values, "2", { enumerable: true, get() { reads++; return "123.45 USD"; } });
    const inherited = Object.create({ values: row().values });
    const hidden = Object.defineProperty(row(), "extra", { value: true });
    const hole = row(); delete hole.values[2];
    const binding = { frameNonce: "a".repeat(48), requestNonce: "b".repeat(48) };
    for (const invalid of [getter, slot, inherited, hidden, hole, { values: [row().values, row().values] }, { values: [...row().values, "extra"] }]) {
      expect(normalizeRawImageValuesRow(invalid, "split-six-v2")).toBeUndefined();
      expect(processIouRequest({ type: "oc:app-process:request", version: 1, actionId: "iou.entry.import", ...binding, input: input([invalid]) }, binding, options)).toEqual({ kind: "error" });
    }
    expect(reads).toBe(0);
  });

  it("keeps v1, defaults and named-form split-money grammar strict", () => {
    expect(normalizeRawImageValuesRow(row())).toBeUndefined();
    expect(normalizeRawImageValuesRow(row(), "split-six-v1")).toBeUndefined();
    const named = { note: "Invoice", currency_text: "USD", amount_text: "123.45 USD", date_text: "27 September 2026", kind: "iou", direction_text: "You owe" };
    expect(normalizeRawImageEvidence(named, "labeled-values", "direction-v1")).toBeUndefined();
    expect(artifact([named])).toEqual({ kind: "error" });
    expect(processLocalArtifactRequest(request([row()]), { ...options, rawImageValuesRowFormat: "split-six-v1" })).toEqual({ kind: "error" });
    expect(iouImageProcessorOptions).toEqual({ rawImageMoneyFormat: "total-row" });
  });

  it("replays the exact retained v1-format failure under v2 without changing its original grade", () => {
    const item = capture.captures.find(item => item.id === "printed-debt-format-failure")!;
    expect(createHash("sha256").update(item.rawText).digest("hex")).toBe(item.rawSha256);
    const parsed = JSON.parse(item.rawText);
    expect(normalizeRawImageValuesRow(parsed[0])).toBeUndefined();
    expect(artifact(parsed)).toEqual({ kind: "candidates", sourceIndexes: [0], candidates: [
      { amount: 123.45, currency: "USD", kind: "iou", direction: "debt", date: "2026-09-27", note: "SYNTHETIC TEST INVOICE" },
    ] });
  });

  it("retains all-or-nothing one-to-one row order and the other six-slot semantics", () => {
    const second = { values: ["Invoice B", "EUR", "EUR 56.78", "2 October 2026", "iou", "Owed to you"] };
    expect(artifact([row(), second])).toMatchObject({ kind: "candidates", sourceIndexes: [0, 1], candidates: [
      { amount: 123.45, currency: "USD", direction: "debt", date: "2026-09-27" },
      { amount: 56.78, currency: "EUR", direction: "credit", date: "2026-10-02" },
    ] });
    expect(artifact([row(), row("EUR", "56.78 USD")])).toEqual({ kind: "error" });
    const range = row(); range.values[3] = "Sun, Jul 19 | Thu, Aug 6"; range.values[5] = null;
    expect(artifact([range])).toMatchObject({ kind: "candidates", sourceIndexes: [0], candidates: [{ date: "2026-07-19", direction: "credit", note: "Invoice | From Sun, Jul 19 to Thu, Aug 6" }] });
    const context = createLocalProcessorContext([{ id: "matched", name: "Invoice", keywords: [], direction: "credit", txn_type: "settlement" }], "USD");
    expect(artifact([row()], context)).toMatchObject({ kind: "candidates", candidates: [{ direction: "credit", kind: "iou", typeId: "matched" }] });
    expect(artifact([row()], { ...context, draftEditorDefaults: "host-v1" })).toMatchObject({ kind: "candidates", candidates: [{ direction: "debt", kind: "iou", typeId: "matched" }] });
  });

  it("changes only the inactive trusted adapter version, not any prompt or active options", () => {
    expect(candidate).toEqual({ ...prior, processorOptions: options });
    const parsed = readIouModelImageProfiles(candidate);
    expect(parsed.processorOptions).toEqual(options); expect(Object.isFrozen(parsed.processorOptions)).toBe(true);
    expect(createHash("sha256").update(candidate.templates["gemma-4-e2b-it-q4"].template).digest("hex")).toBe("bdfca3297c574893ed10d714b583d51a722e4c68db0eae985216c2fcb6ad4ede");
    for (const details of [undefined, "none", "labels-v1", "source-v1"]) expect(() => readIouModelImageProfiles({ ...candidate, processorOptions: { ...options, rawImageDetailsFormat: details } })).toThrow();
  });
});
