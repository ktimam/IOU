import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TxnTemplate } from "../templates/TemplatesContext";
import { iouActionManifest } from "./actionManifest";
import { buildConfirmPayload, initToFormState } from "./cardBridge";
import { processIouRequest } from "./localProcessorBridge";
import { clearSavedTypeSelection, editCardForm, hydrateSavedTypeForCard, ReadonlyView } from "./OpenChatCardPage";

// Retained real model outputs, not new inference or browser/private-grant qualification.
const bytes = readFileSync(new URL("../../../test/fixtures/openchat/model-acceptance/gemma-v15-app-replay.json", import.meta.url));
const fixture = JSON.parse(bytes.toString("utf8")) as {
  cases: { imageId: string; sourceTimestamp: string; raw: string;
    expectedAppForm: { kind: string; amount: string; currency: string; date: string; note: string } }[];
};
const binding = { frameNonce: "a".repeat(48), requestNonce: "b".repeat(48) };

describe("captured image -> IOU processor -> saved-Type card direction", () => {
  it("uses the original eight recorded answers unchanged", () => {
    expect(createHash("sha256").update(bytes).digest("hex"))
      .toBe("14f9ad07b2b66b75accaf424e22ba5f3bb8f8ae6cd9ecbe09ef573f3455dcae1");
    expect(fixture.cases).toHaveLength(8);
  });

  for (const row of fixture.cases) {
    it.each(["credit", "debt"] as const)(`${row.imageId}: private %s default preserves all source fields`, (direction) => {
      const candidates = JSON.parse(row.raw) as Record<string, unknown>[];
      const rawBefore = JSON.stringify(candidates);
      const result = processIouRequest({ type: "oc:app-process:request", version: 1, ...binding, actionId: iouActionManifest.id,
        input: { operation: "normalize_raw", modality: "image", candidates, sourceTimestamp: Date.parse(row.sourceTimestamp) },
      }, binding);
      expect(result.kind).toBe("candidates");
      if (result.kind !== "candidates") throw new Error("Expected one normalized captured image");
      expect(result.sourceIndexes).toEqual([0]);
      expect(result.candidates).toHaveLength(1);
      // Reproduce the public canonical schema default. Private saved-Type direction must win.
      const raw = { ...result.candidates[0], direction: "credit" as const };
      const savedType: TxnTemplate = { id: "private-type-fixture", name: "User-defined document category",
        keywords: [String(candidates[0].note)], direction, txn_type: "iou", currency: "JPY" };
      const initial = initToFormState(raw, new Date(row.sourceTimestamp));
      const hydrated = hydrateSavedTypeForCard(initial, raw, [savedType], { evidence: "row-local" });
      expect(hydrated).toMatchObject({ ...row.expectedAppForm, direction, templateId: savedType.id });
      const markup = renderToStaticMarkup(ReadonlyView({ form: hydrated, templates: [savedType] }));
      expect(markup).toContain(direction === "debt" ? "You owe" : "Owed to you");
      expect(markup).not.toContain(direction === "debt" ? "Owed to you" : "You owe");
      const confirmation = buildConfirmPayload(hydrated);
      expect(confirmation).toMatchObject({ direction, amount: Number(row.expectedAppForm.amount), note: row.expectedAppForm.note });
      if (row.expectedAppForm.currency) expect(confirmation.currency).toBe(row.expectedAppForm.currency);
      else expect(confirmation).not.toHaveProperty("currency");
      if (row.expectedAppForm.date) expect(confirmation.date).toBe(row.expectedAppForm.date);
      else expect(confirmation).not.toHaveProperty("date");
      for (const key of ["templateId", "directionBeforeSavedType", "image_heading", "printed_date", "date_text", "sourceIndexes"])
        expect(confirmation).not.toHaveProperty(key);
      // A private grant refresh rehydrates the same values, while deliberate edits survive it.
      expect(hydrateSavedTypeForCard(clearSavedTypeSelection(hydrated), raw, [savedType], { evidence: "row-local" })).toEqual(hydrated);
      const editedDirection = direction === "debt" ? "credit" : "debt";
      const edited = editCardForm(hydrated, "direction", editedDirection, [savedType]);
      const rehydrated = hydrateSavedTypeForCard(clearSavedTypeSelection(edited), raw, [savedType], { evidence: "row-local" });
      expect(rehydrated).toMatchObject({ ...row.expectedAppForm, direction: editedDirection });
      expect(JSON.stringify(candidates)).toBe(rawBefore);
    });
  }
});
