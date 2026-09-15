import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseDraft } from "../entries/draft";
import { templateToInitial } from "../templates/templateBase";
import type { TxnTemplate } from "../templates/TemplatesContext";
import { buildConfirmPayload, initToFormState } from "./cardBridge";
import { clearSavedTypeSelection, editCardForm, hydrateSavedTypeForCard, ReadonlyView } from "./OpenChatCardPage";

const DEBT_TYPE: TxnTemplate = {
  id: "account-local-studio",
  name: "Studio hire",
  direction: "debt",
  txn_type: "iou",
};
const CREDIT_TYPE: TxnTemplate = {
  id: "account-local-materials",
  name: "Materials",
  direction: "credit",
  txn_type: "iou",
};

describe("private saved-Type direction in proposed IOU cards", () => {
  it.each([undefined, "credit", "debt"] as const)(
    "uses the account's saved direction, not image inference's %s hint",
    (direction) => {
      const raw = {
        kind: "iou" as const,
        amount: 1912.15,
        currency: "USD",
        date: "2026-07-19",
        note: "Studio hire | From Sun, Jul 19 to Thu, Aug 6",
        ...(direction === undefined ? {} : { direction }),
      };
      const hydrated = hydrateSavedTypeForCard(initToFormState(raw), raw, [DEBT_TYPE]);
      expect(hydrated).toMatchObject({
        templateId: DEBT_TYPE.id,
        direction: "debt",
        amount: "1912.15",
        currency: "USD",
        date: "2026-07-19",
        note: raw.note,
      });
      const markup = renderToStaticMarkup(ReadonlyView({ form: hydrated, templates: [DEBT_TYPE] }));
      expect(markup).toContain("You owe");
      expect(markup).not.toContain("Owed to you");
      const payload = buildConfirmPayload(hydrated);
      expect(payload.direction).toBe("debt");
      const imported = parseDraft(payload, templateToInitial(DEBT_TYPE));
      expect(imported.ok).toBe(true);
      if (imported.ok) expect(imported.value.initial.direction).toBe("debt");
    },
  );

  it("applies either configured direction row-locally without borrowing a sibling's type", () => {
    const templates = [DEBT_TYPE, CREDIT_TYPE];
    const states = ["Studio hire", "Materials", "Groceries"].map((note) => {
      const raw = { note, message: "Studio hire and Materials", direction: "debt" as const };
      return hydrateSavedTypeForCard(initToFormState(raw), raw, templates, { evidence: "row-local" });
    });
    expect(states.map(({ direction }) => direction)).toEqual(["debt", "credit", "debt"]);
    expect(states.map(({ templateId }) => templateId)).toEqual([DEBT_TYPE.id, CREDIT_TYPE.id, undefined]);
  });

  it("uses a configured Owed to you direction even when the image hint says You owe", () => {
    const raw = {
      note: "Materials", kind: "iou" as const, amount: 50, currency: "EGP", direction: "debt" as const,
    };
    const hydrated = hydrateSavedTypeForCard(initToFormState(raw), raw, [CREDIT_TYPE]);
    const payload = buildConfirmPayload(hydrated);
    expect(payload.direction).toBe("credit");
    const imported = parseDraft(payload, templateToInitial(CREDIT_TYPE));
    expect(imported.ok).toBe(true);
    if (imported.ok) expect(imported.value.initial.direction).toBe("credit");
    const markup = renderToStaticMarkup(ReadonlyView({ form: hydrated, templates: [CREDIT_TYPE] }));
    expect(markup).toContain("Owed to you");
    expect(markup).not.toContain("You owe");
  });

  it("preserves a human direction choice made before the private roster arrives, even unchanged credit", () => {
    const raw = { note: "Studio hire", direction: "credit" as const };
    const edited = editCardForm(initToFormState(raw), "direction", "credit", []);
    const hydrated = hydrateSavedTypeForCard(edited, raw, [DEBT_TYPE]);
    expect(hydrated.templateId).toBe(DEBT_TYPE.id);
    expect(hydrated.direction).toBe("credit");
    expect(buildConfirmPayload(hydrated).direction).toBe("credit");
  });

  it("retains manual direction edits through repeated hydration, grant rotation and another type choice", () => {
    const raw = { note: "Studio hire" };
    const initial = hydrateSavedTypeForCard(initToFormState(raw), raw, [DEBT_TYPE]);
    const edited = editCardForm(initial, "direction", "credit", [DEBT_TYPE]);
    expect(hydrateSavedTypeForCard(edited, raw, [DEBT_TYPE])).toBe(edited);
    const rotated = hydrateSavedTypeForCard(clearSavedTypeSelection(edited), raw, [DEBT_TYPE]);
    expect(rotated.direction).toBe("credit");
    const selected = editCardForm(rotated, "templateId", DEBT_TYPE.id, [DEBT_TYPE]);
    expect(selected.direction).toBe("credit");
    expect(buildConfirmPayload(selected).direction).toBe("credit");
  });

  it("applies a manually chosen saved type's direction without replacing extracted values", () => {
    const initial = initToFormState({
      kind: "settlement", amount: 25, currency: "EGP", date: "2026-08-14", note: "Custom note",
    });
    const selected = editCardForm(initial, "templateId", DEBT_TYPE.id, [DEBT_TYPE]);
    expect(selected).toMatchObject({ ...initial, direction: "debt", templateId: DEBT_TYPE.id });
    expect(buildConfirmPayload(selected)).toEqual({
      kind: "settlement", amount: 25, currency: "EGP", date: "2026-08-14", note: "Custom note", direction: "debt",
    });
  });

  it("restores the original direction when an unedited saved-type default is removed", () => {
    const raw = { note: "Studio hire", direction: "credit" as const };
    const initial = initToFormState(raw);
    const hydrated = hydrateSavedTypeForCard(initial, raw, [DEBT_TYPE]);
    expect(hydrated.direction).toBe("debt");
    expect(clearSavedTypeSelection(hydrated)).toEqual(initial);
    const otherAccountType = { ...DEBT_TYPE, name: "Other account", direction: "debt" as const };
    const rotated = hydrateSavedTypeForCard(clearSavedTypeSelection(hydrated), raw, [otherAccountType]);
    expect(rotated.direction).toBe("credit");
    expect(rotated.templateId).toBeUndefined();
  });

  it("keeps an explicit None choice through delayed hydration and private-context refresh", () => {
    const raw = { note: "Studio hire" };
    const hydrated = hydrateSavedTypeForCard(initToFormState(raw), raw, [DEBT_TYPE]);
    const cleared = editCardForm(hydrated, "templateId", undefined, [DEBT_TYPE]);
    const rehydrated = hydrateSavedTypeForCard(clearSavedTypeSelection(cleared), raw, [DEBT_TYPE]);
    expect(rehydrated.templateId).toBeUndefined();
    expect(rehydrated.direction).toBe("credit");
  });

  it("switches unedited defaults between saved types and keeps the pre-type direction for removal", () => {
    const templates = [DEBT_TYPE, CREDIT_TYPE];
    const initial = initToFormState({ direction: "debt" });
    const credit = editCardForm(initial, "templateId", CREDIT_TYPE.id, templates);
    const debt = editCardForm(credit, "templateId", DEBT_TYPE.id, templates);
    expect(credit.direction).toBe("credit");
    expect(debt.direction).toBe("debt");
    expect(clearSavedTypeSelection(debt).direction).toBe("debt");
  });

  it("does not rewrite a confirmed readonly direction when saved defaults change", () => {
    const raw = { note: "Studio hire", direction: "credit" as const };
    const initial = initToFormState(raw);
    const readonly = hydrateSavedTypeForCard(initial, raw, [DEBT_TYPE], { readonly: true });
    expect(readonly.direction).toBe("credit");
    expect(readonly.templateId).toBe(DEBT_TYPE.id);
    expect(readonly.directionBeforeSavedType).toBeUndefined();
    const editable = hydrateSavedTypeForCard(initial, raw, [DEBT_TYPE]);
    expect(clearSavedTypeSelection(editable, { preserveDirection: true }).direction).toBe("debt");
  });

  it("does not apply defaults from ambiguous or unavailable account types", () => {
    const raw = { note: "Studio hire" };
    const initial = initToFormState(raw);
    for (const templates of [[], [DEBT_TYPE, { ...CREDIT_TYPE, name: DEBT_TYPE.name }]]) {
      expect(hydrateSavedTypeForCard(initial, raw, templates)).toEqual(initial);
    }
  });

  it("never accepts host-supplied edit/default markers or leaks private bookkeeping in confirmation", () => {
    const raw = {
      note: "Studio hire", amount: 25, currency: "USD", kind: "iou" as const,
      directionEdited: true as const, savedTypeSelectionEdited: true as const,
      directionBeforeSavedType: "debt" as const, templateId: CREDIT_TYPE.id,
    };
    const initial = initToFormState(raw);
    expect(initial).not.toHaveProperty("directionEdited");
    expect(initial).not.toHaveProperty("savedTypeSelectionEdited");
    expect(initial).not.toHaveProperty("directionBeforeSavedType");
    expect(initial).not.toHaveProperty("templateId");
    const hydrated = hydrateSavedTypeForCard(initial, raw, [DEBT_TYPE]);
    expect(hydrated.direction).toBe("debt");
    const payload = buildConfirmPayload(hydrated);
    for (const key of ["directionEdited", "savedTypeSelectionEdited", "directionBeforeSavedType", "templateId"]) {
      expect(payload).not.toHaveProperty(key);
    }
  });
});
