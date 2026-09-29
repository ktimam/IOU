import { describe, expect, it } from "vitest";
import { applyLocalImportType, editLocalImportDirection, initializeLocalImportReviewRow, prepareLocalImportReview } from "./localImportReview";
import type { LocalImportDraft } from "./localImportHandoff";
import type { TxnTemplate } from "../templates/TemplatesContext";

const id = "A".repeat(43);
const row: LocalImportDraft = { kind: "iou", amount: 100, currency: "USD", direction: "credit", date: "2026-09-26", note: "Reviewed note" };
const type: TxnTemplate = { id: "private-one", name: "User-defined Type", direction: "debt", txn_type: "iou", fee_percent: 10, schedule: [{ offset_days: 2, percent: 100 }] };

describe("IOU local import review", () => {
  it("changes visible type/direction only on explicit account-local Type selection", () => {
    const state = initializeLocalImportReviewRow(row, [type]);
    expect(applyLocalImportType(state, type.id, [type]).row).toMatchObject({ kind: "iou", direction: "debt" });
    expect(row.direction).toBe("credit");
    expect(() => applyLocalImportType(state, "foreign", [type])).toThrow();
    expect(() => applyLocalImportType(state, type.id, [type, type])).toThrow();
  });
  it("includes net, fees and complete schedule in immutable final storage preview", () => {
    const selected = applyLocalImportType(initializeLocalImportReviewRow(row, [type]), type.id, [type]);
    const payloads = prepareLocalImportReview({ rows: [selected.row], selectedTypeIds: [selected.selectedTypeId], templates: [type], importId: id });
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
  it("does not invent a pre-Type direction when clearing an initially matched incoming Type", () => {
    const incoming = { ...row, direction: "debt" as const, typeId: type.id, typeName: type.name };
    const state = initializeLocalImportReviewRow(incoming, [type]);
    expect(state.selectedTypeId).toBe(type.id);
    expect(state).not.toHaveProperty("directionBeforeType");
    const cleared = applyLocalImportType(state, "", [type]);
    expect(cleared.selectedTypeId).toBe("");
    expect(cleared.row.direction).toBe("debt");
    expect(cleared.row).toEqual(incoming);
  });
  it("restores the known receiver baseline after Type A, Type B and None", () => {
    const other = { ...type, id: "private-two", name: "Another Type", direction: "credit" as const };
    const templates = [type, other];
    let state = initializeLocalImportReviewRow(row, templates);
    state = applyLocalImportType(state, type.id, templates);
    expect(state).toMatchObject({ row: { direction: "debt" }, directionBeforeType: "credit" });
    state = applyLocalImportType(state, other.id, templates);
    expect(state).toMatchObject({ row: { direction: "credit" }, directionBeforeType: "credit" });
    state = applyLocalImportType(state, "", templates);
    expect(state.row.direction).toBe("credit");
    expect(state).not.toHaveProperty("directionBeforeType");
  });
  it.each(["before", "after"])("preserves a manual direction edited %s Type selection", (when) => {
    let state = initializeLocalImportReviewRow(row, [type]);
    if (when === "after") state = applyLocalImportType(state, type.id, [type]);
    state = editLocalImportDirection(state, "credit");
    expect(state).toMatchObject({ directionEdited: true, row: { direction: "credit" } });
    expect(state).not.toHaveProperty("directionBeforeType");
    state = applyLocalImportType(state, type.id, [type]);
    expect(state.row.direction).toBe("credit");
    state = applyLocalImportType(state, "", [type]);
    expect(state.row.direction).toBe("credit");
    state = applyLocalImportType(state, type.id, [type]);
    const reviewed = prepareLocalImportReview({ rows: [state.row], selectedTypeIds: [state.selectedTypeId], templates: [type], importId: id });
    expect(reviewed[0]).toMatchObject({ direction: "credit", fee: { percent: 10 } });
    for (const value of [state.row, reviewed[0]]) {
      expect(value).not.toHaveProperty("directionEdited");
      expect(value).not.toHaveProperty("directionBeforeType");
      expect(value).not.toHaveProperty("selectedTypeId");
    }
  });
  it("keeps edits row-local and resets history on fresh draft initialization", () => {
    const first = editLocalImportDirection(applyLocalImportType(initializeLocalImportReviewRow(row, [type]), type.id, [type]), "credit");
    const second = applyLocalImportType(initializeLocalImportReviewRow(row, [type]), type.id, [type]);
    expect(first.row.direction).toBe("credit");
    expect(second.row.direction).toBe("debt");
    expect(applyLocalImportType(second, "", [type]).row.direction).toBe("credit");
    const fresh = initializeLocalImportReviewRow({ ...first.row }, [type]);
    expect(fresh).not.toHaveProperty("directionEdited");
    expect(fresh).not.toHaveProperty("directionBeforeType");
    expect(applyLocalImportType(fresh, type.id, [type]).row.direction).toBe("debt");
  });
  it.each(["missing", "renamed", "duplicate"])("does not hydrate foreign defaults from a %s proposed Type", (reason) => {
    const incoming = { ...row, typeId: type.id, typeName: type.name };
    const roster = reason === "missing" ? [] : reason === "renamed" ? [{ ...type, name: "Renamed" }] : [type, type];
    const state = initializeLocalImportReviewRow(incoming, roster);
    expect(state.selectedTypeId).toBeNull();
    expect(state.row).toEqual(incoming);
    expect(state).not.toHaveProperty("directionBeforeType");
    expect(() => prepareLocalImportReview({ rows: [state.row], selectedTypeIds: [state.selectedTypeId], templates: roster, importId: id })).toThrow(/explicitly select None/);
    const cleared = applyLocalImportType(state, "", roster);
    const reviewed = prepareLocalImportReview({ rows: [cleared.row], selectedTypeIds: [cleared.selectedTypeId], templates: roster, importId: id });
    expect(reviewed[0]).toMatchObject({ direction: "credit" });
    expect(reviewed[0]).not.toHaveProperty("fee");
  });
});
