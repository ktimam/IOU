import { describe, expect, it } from "vitest";
import { createIouLocalAppPackage } from "./localAppPackage";
import { createLocalProcessorContext, parseLocalProcessorContext } from "./localProcessorContext";

const destination = "http://localhost:3000/openchat/import";
const processor = { sha256: "a".repeat(64), byteLength: 1234 };
const types = [
  { id: "private-credit", name: "Private credit", keywords: ["alpha"], direction: "credit" as const, txn_type: "iou" as const, fee_percent: 50 },
  { id: "private-debt", name: "Private debt", keywords: ["beta"], direction: "debt" as const, txn_type: "settlement" as const },
];

describe("IOU-owned named draft choices", () => {
  it("exports the exact private labels and IDs with only a direction default", () => {
    const context = createLocalProcessorContext(types, "EGP");
    const before = JSON.stringify(context);
    const action = createIouLocalAppPackage(destination, processor, { processorContext: context, recipientLabel: "Synthetic sheet" }).apps[0].actions[0];
    expect(action.draftEditor).toEqual({ version: 1, choices: [{ field: "typeId", label: "Type",
      noneLabel: "None — use reviewed fields only", options: types.map(type => ({ value: type.id, label: type.name,
        assign: [{ field: "typeName", value: type.name }], defaults: [{ field: "direction", value: type.direction }],
      })),
    }] });
    expect(action.processorContext).toEqual({ ...context, draftEditorDefaults: "host-v1" });
    expect(JSON.stringify(context)).toBe(before);
    expect(JSON.stringify(action.draftEditor)).not.toContain("kind");
    expect(JSON.stringify(action.processorContext)).not.toContain("fee");
    expect(action.definition).not.toHaveProperty("draftEditor");
    expect(action.definition.promptTemplate).not.toContain("Private credit");
    expect(action.definition.rules).toContainEqual({ kind: "keyword_map", field: "typeId", mode: "hint", map: [
      { value: "private-credit", keywords: ["Private credit", "alpha"] },
      { value: "private-debt", keywords: ["Private debt", "beta"] },
    ] });
  });
  it("omits editor and context from public exports, and retains empty-roster currency without opt-in", () => {
    const publicAction = createIouLocalAppPackage(destination, processor).apps[0].actions[0];
    expect(publicAction).not.toHaveProperty("draftEditor");
    expect(publicAction).not.toHaveProperty("processorContext");
    const context = { ...createLocalProcessorContext([], "EGP"), draftEditorDefaults: "host-v1" as const };
    const privateAction = createIouLocalAppPackage(destination, processor, { processorContext: context, recipientLabel: "Empty sheet" }).apps[0].actions[0];
    expect(privateAction).not.toHaveProperty("draftEditor");
    expect(privateAction.processorContext).toEqual({ version: 1, types: [], defaultCurrency: "EGP" });
  });
  it("rejects duplicate or hidden Type labels rather than emitting a host-invalid selector", () => {
    for (const name of [types[0].name, "None — use reviewed fields only", "Hidden\u200bname", "Hidden\u0085name"]) {
      const context = createLocalProcessorContext([types[0], { ...types[1], name }], "USD");
      expect(() => createIouLocalAppPackage(destination, processor, { processorContext: context, recipientLabel: "Synthetic sheet" })).toThrow(/unique, visible/);
    }
  });
  it("strictly accepts only the declared host-v1 context extension", () => {
    const context = createLocalProcessorContext(types, "USD");
    expect(context).not.toHaveProperty("draftEditorDefaults");
    const parsed = parseLocalProcessorContext({ ...context, draftEditorDefaults: "host-v1" });
    expect(parsed).toEqual({ ...context, draftEditorDefaults: "host-v1" });
    expect(Object.isFrozen(parsed)).toBe(true);
    for (const invalid of [undefined, null, false, 1, "host-v2", {}, []]) {
      expect(parseLocalProcessorContext({ ...context, draftEditorDefaults: invalid })).toBeUndefined();
    }
    expect(parseLocalProcessorContext({ ...context, draftEditorDefaults: "host-v1", surprise: true })).toBeUndefined();
  });
  it.each([32736, 32750])("validates the final paired context, including its added bytes (base %s)", (targetBytes) => {
    const roster = Array.from({ length: 15 }, (_, i) => ({ id: `type${i}`, name: `Type ${i}`,
      direction: "debt" as const, txn_type: "iou" as const, keywords: Array(32).fill("x".repeat(62)) as string[] }));
    const context = { version: 1 as const, defaultCurrency: "USD", types: roster };
    const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
    let bytes = byteLength(context);
    for (const type of roster) {
      for (let i = 0; i < 32 && bytes < targetBytes; i++) {
        const extra = Math.min(2, targetBytes - bytes);
        type.keywords[i] += "y".repeat(extra);
        bytes += extra;
      }
    }
    expect(byteLength(context)).toBe(targetBytes);
    expect(parseLocalProcessorContext(context)).toBeDefined();
    const withEditor = { ...context, draftEditorDefaults: "host-v1" as const };
    expect(byteLength(withEditor)).toBe(targetBytes + 32);
    const exportPackage = () => createIouLocalAppPackage(destination, processor, { processorContext: context, recipientLabel: "Synthetic sheet" });
    if (targetBytes + 32 > 32768) {
      expect(parseLocalProcessorContext(withEditor)).toBeUndefined();
      expect(exportPackage).toThrow(/context exceeds/);
    } else {
      const exported = exportPackage().apps[0].actions[0].processorContext;
      expect(exported).toEqual(withEditor);
      expect(parseLocalProcessorContext(exported)).toEqual(withEditor);
    }
  });
});
