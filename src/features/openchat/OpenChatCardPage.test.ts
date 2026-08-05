import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CardFormState } from "./cardBridge";
import { ReadonlyView, TypeFields, templateRefContextForCard } from "./OpenChatCardPage";
import type { TxnTemplate } from "../templates/TemplatesContext";

const TYPE: TxnTemplate = {
  id: "private-reservation-id",
  name: "Reservation",
  direction: "credit",
  txn_type: "iou",
  keywords: ["reservation", "booking"],
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
    expect(markup).toContain('aria-label="Account type"');
    expect(markup).toContain("Reservation");
    expect(markup).toContain('value="private-reservation-id"');
  });

  it("shows the selected type name in readonly card details", () => {
    const markup = renderToStaticMarkup(ReadonlyView({ form: FORM, templates: [TYPE] }));
    expect(markup).toContain("Account type");
    expect(markup).toContain("Reservation");
  });

  it("does not invent or expose a type before the private roster is available", () => {
    const withoutType = { ...FORM, templateId: undefined };
    const editable = renderToStaticMarkup(
      TypeFields({ form: withoutType, onChange: ignoreChange, templates: [] }),
    );
    const readonly = renderToStaticMarkup(ReadonlyView({ form: withoutType, templates: [] }));
    expect(editable).not.toContain("Reservation");
    expect(readonly).not.toContain("Account type");
  });
});
