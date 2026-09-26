import { describe, expect, it } from "vitest";
import { applyLocalImportType, prepareLocalImportReview } from "./localImportReview";
import type { LocalImportDraft } from "./localImportHandoff";
import type { TxnTemplate } from "../templates/TemplatesContext";

const id = "A".repeat(43);
const row: LocalImportDraft = { kind: "iou", amount: 100, currency: "USD", direction: "credit", date: "2026-09-26", note: "Reviewed note" };
const type: TxnTemplate = { id: "private-one", name: "User-defined Type", direction: "debt", txn_type: "iou", fee_percent: 10, schedule: [{ offset_days: 2, percent: 100 }] };

describe("IOU local import review", () => {
  it("changes visible type/direction only on explicit account-local Type selection", () => {
    expect(applyLocalImportType(row, type.id, [type])).toMatchObject({ kind: "iou", direction: "debt" });
    expect(row.direction).toBe("credit");
    expect(() => applyLocalImportType(row, "foreign", [type])).toThrow();
    expect(() => applyLocalImportType(row, type.id, [type, type])).toThrow();
  });
  it("includes net, fees and complete schedule in immutable final storage preview", () => {
    const payloads = prepareLocalImportReview({ rows: [applyLocalImportType(row, type.id, [type])], selectedTypeIds: [type.id], templates: [type], importId: id });
    expect(payloads[0]).toMatchObject({ amount_minor: 9000, direction: "debt", note: row.note,
      fee: { percent: 10, gross_amount_minor: 10000 }, schedule: [{ due_ts: Date.UTC(2026, 8, 28), percent: 100 }] });
    expect(Object.isFrozen(payloads)).toBe(true); expect(Object.isFrozen(payloads[0].fee)).toBe(true);
    expect(Object.isFrozen(payloads[0].schedule?.[0])).toBe(true);
  });
  it("never guesses a missing date, accepts a foreign Type, or loses an invalid row", () => {
    const { date: _date, ...noDate } = row;
    expect(() => prepareLocalImportReview({ rows: [noDate], selectedTypeIds: [""], templates: [], importId: id })).toThrow(/date/);
    expect(() => prepareLocalImportReview({ rows: [row], selectedTypeIds: ["foreign"], templates: [type], importId: id })).toThrow(/Type/);
    expect(() => prepareLocalImportReview({ rows: [row, { ...row, amount: -1 }], selectedTypeIds: ["", ""], templates: [], importId: id })).toThrow();
  });
  it("requires an explicit choice before discarding a mismatched proposed Type", () => {
    const proposed = { ...row, typeId: "other-account", typeName: "Unavailable Type" };
    expect(() => prepareLocalImportReview({ rows: [proposed], selectedTypeIds: [null], templates: [type], importId: id })).toThrow(/explicitly select None/);
    expect(prepareLocalImportReview({ rows: [proposed], selectedTypeIds: [""], templates: [type], importId: id })[0]).not.toHaveProperty("fee");
    expect(prepareLocalImportReview({ rows: [proposed], selectedTypeIds: [type.id], templates: [type], importId: id })[0]).toHaveProperty("fee.percent", 10);
  });
});
