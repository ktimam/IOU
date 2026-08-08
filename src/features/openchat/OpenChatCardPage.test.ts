import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildConfirmPayload, type CardFormState } from "./cardBridge";
import {
  hydrateSavedTypeForCard,
  ReadonlyView,
  TypeFields,
  templateRefContextForCard,
} from "./OpenChatCardPage";
import type { TxnTemplate } from "../templates/TemplatesContext";
import { encryptTemplateRef } from "./templateRef";
import * as openChatCardPage from "./OpenChatCardPage";
import type { CardTransportSession } from "./cardPrivateContext";

const TYPE: TxnTemplate = {
  id: "private-reservation-id",
  name: "Reservation",
  direction: "credit",
  txn_type: "iou",
  keywords: ["reservation", "booking"],
};

const COLLIDING_TYPE: TxnTemplate = {
  ...TYPE,
  id: "private-travel-id",
  name: "Travel",
  keywords: ["booking"],
};

const FOREIGN_TYPE: TxnTemplate = {
  ...TYPE,
  id: "private-allowance-id",
  name: "Allowance",
  keywords: ["allowance"],
};

const RENT_TYPE: TxnTemplate = {
  ...TYPE,
  id: "private-rent-id",
  name: "Rent",
  keywords: ["rent"],
};

const ALLOWANCE_TYPE: TxnTemplate = {
  ...TYPE,
  id: "private-allowance-id",
  name: "Allowance",
  keywords: ["allowance"],
};

const FORM: CardFormState = {
  kind: "iou",
  amount: "1000",
  currency: "EGP",
  direction: "credit",
  note: "deposit",
  date: "",
  templateId: TYPE.id,
};

const ignoreChange = <K extends keyof CardFormState>(
  _key: K,
  _value: CardFormState[K],
): void => undefined;

describe("OpenChat IOU card account type visibility", () => {
  it("collects only in response to the host's one-click challenge and owns no submit buttons", () => {
    const source = readFileSync(resolve(__dirname, "OpenChatCardPage.tsx"), "utf8");
    expect(source).toContain("parseCollectConfirm(event.data, frameNonce)");
    expect(source).toContain("buildCollectedConfirm(");
    expect(source).not.toContain('onClick={onConfirm}');
    expect(source).not.toContain('onClick={onConfirmAll}');
    expect(source).not.toContain('onClick={onCancel}');
    // The private saved-Type value is protected before it crosses the bridge; host rows never
    // receive the id/name and the collected payload carries only the encrypted opaque reference.
    expect(source).toContain("encryptedTypeRef(");
    expect(source).toContain("templateRefContextForCard(");
  });

  it("binds encrypted type references only to safe authoritative card coordinates", () => {
    const context = templateRefContextForCard(
      {
        sheetId: "000000000000002a",
        contextVersion: 1,
        appSubject: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
        chatHandle: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI",
        messageHandle: "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM",
        appId: 23,
        appRevision: 5n,
        actionId: "iou.entry.import",
      },
      2,
    );
    expect(context).toEqual({
      sheetId: "000000000000002a",
      contextVersion: 1,
      appSubject: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
      chatHandle: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI",
      messageHandle: "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM",
      appId: 23,
      appRevision: 5n,
      actionId: "iou.entry.import",
      entryIndex: 2,
    });
    expect(context).not.toHaveProperty("chatKey");
    expect(context).not.toHaveProperty("messageId");
    expect(context).not.toHaveProperty("confirmedBy");
  });

  it("shows decrypted saved type names in the editable card selector", () => {
    const markup = renderToStaticMarkup(
      TypeFields({ form: FORM, onChange: ignoreChange, templates: [TYPE] }),
    );
    expect(markup).toContain('aria-label="Saved type"');
    expect(markup).toContain("Reservation");
    expect(markup).toContain('value="private-reservation-id"');
  });

  it("shows the selected type name in readonly card details", () => {
    const markup = renderToStaticMarkup(ReadonlyView({ form: FORM, templates: [TYPE] }));
    expect(markup).toContain("Saved type");
    expect(markup).toContain("Reservation");
  });

  it("does not invent or expose a type before the private roster is available", () => {
    const withoutType = { ...FORM, templateId: undefined };
    const editable = renderToStaticMarkup(
      TypeFields({ form: withoutType, onChange: ignoreChange, templates: [] }),
    );
    const readonly = renderToStaticMarkup(ReadonlyView({ form: withoutType, templates: [] }));
    expect(editable).not.toContain("Reservation");
    expect(readonly).not.toContain("Saved type");
  });

  it("labels the public IOU/Settlement choice as Type", () => {
    const editable = renderToStaticMarkup(
      TypeFields({ form: FORM, onChange: ignoreChange, templates: [TYPE] }),
    );
    const readonly = renderToStaticMarkup(ReadonlyView({ form: FORM, templates: [TYPE] }));
    expect(editable).toContain('aria-label="Type"');
    expect(readonly).toContain("Type");
    expect(readonly).toContain("IOU");
  });

  it("renders the extracted Date as an editable card field", () => {
    const DateField = (openChatCardPage as unknown as {
      DateField?: (props: {
        form: CardFormState;
        onChange: typeof ignoreChange;
      }) => React.ReactNode;
    }).DateField;
    expect(DateField).toBeTypeOf("function");
    const markup = renderToStaticMarkup(
      DateField!({ form: { ...FORM, date: "2026-08-08" }, onChange: ignoreChange }),
    );
    expect(markup).toContain('aria-label="Date"');
    expect(markup).toContain('type="date"');
    expect(markup).toContain('value="2026-08-08"');
  });

  it("hydrates and renders one exact saved-type match from the linked roster", async () => {
    const hydrated = hydrateSavedTypeForCard(
      { ...FORM, templateId: undefined },
      { message: "hotel booking deposit", note: "booking deposit" },
      [TYPE],
    );
    expect(hydrated.templateId).toBe(TYPE.id);

    const markup = renderToStaticMarkup(
      TypeFields({ form: hydrated, onChange: ignoreChange, templates: [TYPE] }),
    );
    expect(markup).toContain("Saved type");
    expect(markup).toContain("Reservation");

    const context = templateRefContextForCard(
      {
        sheetId: "000000000000002a",
        contextVersion: 1,
        appSubject: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
        chatHandle: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI",
        messageHandle: "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM",
        appId: 23,
        appRevision: 5n,
        actionId: "iou.entry.import",
      },
      0,
    );
    const reference = await encryptTemplateRef(
      hydrated.templateId!,
      new Uint8Array(32).fill(7),
      context,
    );
    const payload = buildConfirmPayload(hydrated, reference);
    expect(payload.template_ref).toBe(reference);
    expect(JSON.stringify(payload)).not.toContain(TYPE.id);
    expect(JSON.stringify(payload)).not.toContain(TYPE.name);
    expect(payload).not.toHaveProperty("template");
    expect(payload).not.toHaveProperty("templateId");
  });

  it("never lets a dropped sibling's full message select the surviving OpenChat row's saved Type", () => {
    const hydrated = hydrateSavedTypeForCard(
      { ...FORM, templateId: undefined },
      { message: "rent 100 and an invalid sibling row", note: "groceries" },
      [RENT_TYPE],
    );
    expect(hydrated.templateId).toBeUndefined();
  });

  it("keeps a colliding saved-type match on None", () => {
    const hydrated = hydrateSavedTypeForCard(
      { ...FORM, templateId: undefined },
      { message: "hotel booking deposit" },
      [TYPE, COLLIDING_TYPE],
    );
    expect(hydrated.templateId).toBeUndefined();
    const markup = renderToStaticMarkup(
      TypeFields({
        form: hydrated,
        onChange: ignoreChange,
        templates: [TYPE, COLLIDING_TYPE],
      }),
    );
    expect(markup).toMatch(/<option value="" selected="">None<\/option>/);
  });

  it("matches multi-entry saved Types from each row's note, never the shared source message", () => {
    const hydrateRow = hydrateSavedTypeForCard as unknown as (
      state: CardFormState,
      raw: unknown,
      templates: TxnTemplate[],
      options: { evidence: "row-local" },
    ) => CardFormState;
    const sharedMessage = "rent 100 and allowance 50";
    const templates = [RENT_TYPE, ALLOWANCE_TYPE];

    const rent = hydrateRow(
      { ...FORM, templateId: undefined },
      { message: sharedMessage, note: "rent" },
      templates,
      { evidence: "row-local" },
    );
    const groceries = hydrateRow(
      { ...FORM, templateId: undefined },
      { message: sharedMessage, note: "groceries" },
      templates,
      { evidence: "row-local" },
    );
    const allowance = hydrateRow(
      { ...FORM, templateId: undefined },
      { message: sharedMessage, note: "allowance" },
      templates,
      { evidence: "row-local" },
    );

    expect(rent.templateId).toBe(RENT_TYPE.id);
    expect(groceries.templateId).toBeUndefined();
    expect(allowance.templateId).toBe(ALLOWANCE_TYPE.id);
  });

  it("keeps only the colliding multi-entry row on None", () => {
    const hydrateRow = hydrateSavedTypeForCard as unknown as (
      state: CardFormState,
      raw: unknown,
      templates: TxnTemplate[],
      options: { evidence: "row-local" },
    ) => CardFormState;
    const sharedMessage = "booking deposit and allowance";

    const colliding = hydrateRow(
      { ...FORM, templateId: undefined },
      { message: sharedMessage, note: "booking deposit" },
      [TYPE, COLLIDING_TYPE, ALLOWANCE_TYPE],
      { evidence: "row-local" },
    );
    const allowance = hydrateRow(
      { ...FORM, templateId: undefined },
      { message: sharedMessage, note: "allowance" },
      [TYPE, COLLIDING_TYPE, ALLOWANCE_TYPE],
      { evidence: "row-local" },
    );

    expect(colliding.templateId).toBeUndefined();
    expect(allowance.templateId).toBe(ALLOWANCE_TYPE.id);
  });

  it("clears a foreign or unavailable saved type instead of carrying it into this roster", () => {
    const hydrated = hydrateSavedTypeForCard(
      { ...FORM, templateId: FOREIGN_TYPE.id },
      { message: "allowance payment" },
      [TYPE],
    );
    expect(hydrated.templateId).toBeUndefined();
    const markup = renderToStaticMarkup(
      TypeFields({ form: hydrated, onChange: ignoreChange, templates: [TYPE] }),
    );
    expect(markup).not.toContain(FOREIGN_TYPE.id);
    expect(markup).not.toContain(FOREIGN_TYPE.name);
    expect(markup).toMatch(/<option value="" selected="">None<\/option>/);
  });

  it("clears private selections before a different sheet roster can reuse the same local id", () => {
    const clearSavedTypeSelection = (openChatCardPage as unknown as {
      clearSavedTypeSelection?: (state: CardFormState) => CardFormState;
    }).clearSavedTypeSelection;
    expect(clearSavedTypeSelection).toBeTypeOf("function");

    const sameIdOnAnotherSheet: TxnTemplate = {
      ...TYPE,
      id: TYPE.id,
      name: "Other sheet private Type",
      keywords: ["allowance"],
    };
    const cleared = clearSavedTypeSelection!(FORM);
    const hydrated = hydrateSavedTypeForCard(
      cleared,
      { message: "groceries" },
      [sameIdOnAnotherSheet],
    );

    expect(cleared.templateId).toBeUndefined();
    expect(hydrated.templateId).toBeUndefined();
    expect(buildConfirmPayload(hydrated)).not.toHaveProperty("template_ref");
    const markup = renderToStaticMarkup(
      TypeFields({ form: hydrated, onChange: ignoreChange, templates: [sameIdOnAnotherSheet] }),
    );
    expect(markup).toMatch(/<option value="" selected="">None<\/option>/);
    expect(markup).toContain("Other sheet private Type</option>");
  });

  it("clears every multi-row private selection when a grant or document nonce resets", () => {
    const clearSavedTypeSelection = (openChatCardPage as unknown as {
      clearSavedTypeSelection?: (state: CardFormState) => CardFormState;
    }).clearSavedTypeSelection;
    expect(clearSavedTypeSelection).toBeTypeOf("function");
    const cleared = [
      { ...FORM, templateId: TYPE.id },
      { ...FORM, amount: "200", templateId: FOREIGN_TYPE.id },
    ].map((state) => clearSavedTypeSelection!(state));
    expect(cleared.map((state) => state.templateId)).toEqual([undefined, undefined]);
  });

  it("rejects a late private-context result after capability, session, or nonce rotation", () => {
    const privateLoadMatchesCurrent = (openChatCardPage as unknown as {
      privateLoadMatchesCurrent?: (
        capturedNonce: string,
        capturedSession: CardTransportSession,
        capturedCapability: string,
        currentNonce: string | null,
        currentSession: CardTransportSession | undefined,
        currentCapability: string | undefined,
      ) => boolean;
    }).privateLoadMatchesCurrent;
    expect(privateLoadMatchesCurrent).toBeTypeOf("function");

    const sessionA = {} as CardTransportSession;
    const sessionB = {} as CardTransportSession;
    expect(privateLoadMatchesCurrent!("nonce-a", sessionA, "grant-a", "nonce-a", sessionA, "grant-a"))
      .toBe(true);
    expect(privateLoadMatchesCurrent!("nonce-a", sessionA, "grant-a", "nonce-b", sessionA, "grant-a"))
      .toBe(false);
    expect(privateLoadMatchesCurrent!("nonce-a", sessionA, "grant-a", "nonce-a", sessionB, "grant-a"))
      .toBe(false);
    expect(privateLoadMatchesCurrent!("nonce-a", sessionA, "grant-a", "nonce-a", sessionA, "grant-b"))
      .toBe(false);
  });
});
