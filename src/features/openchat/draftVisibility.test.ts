import { describe, expect, it } from "vitest";
import { placeDraftOnSheet } from "./draftVisibility";

const CHAT_HANDLE = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI";
const OTHER_HANDLE = "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ";
const LINKED_SHEET = "c819f76d77f260b3";
const OTHER_SHEET = "1ac9c9c2d4b54061";
const LINKS = { [CHAT_HANDLE]: LINKED_SHEET };

describe("placeDraftOnSheet with app-scoped chat handles", () => {
  it("shows a linked chat only on its exact sheet", () => {
    expect(
      placeDraftOnSheet({
        context: { chatHandle: CHAT_HANDLE },
        chatLinks: LINKS,
        sheetId: LINKED_SHEET,
      }),
    ).toBe("primary");
    expect(
      placeDraftOnSheet({
        context: { chatHandle: CHAT_HANDLE },
        chatLinks: LINKS,
        sheetId: OTHER_SHEET,
      }),
    ).toBe("hidden");
  });

  it("keeps an unlinked handle visible so the user can choose its sheet", () => {
    for (const sheetId of [LINKED_SHEET, OTHER_SHEET]) {
      expect(
        placeDraftOnSheet({
          context: { chatHandle: OTHER_HANDLE },
          chatLinks: LINKS,
          sheetId,
        }),
      ).toBe("primary");
    }
  });

  it("keeps wrapper-less local compatibility drafts visible", () => {
    expect(placeDraftOnSheet({ chatLinks: LINKS, sheetId: OTHER_SHEET })).toBe(
      "primary",
    );
  });

  it("uses one stable app-scoped handle for every recipient perspective", () => {
    const fatherCopy = { chatHandle: CHAT_HANDLE };
    const childCopy = { chatHandle: CHAT_HANDLE };
    expect(
      placeDraftOnSheet({
        context: fatherCopy,
        chatLinks: LINKS,
        sheetId: LINKED_SHEET,
      }),
    ).toBe(
      placeDraftOnSheet({
        context: childCopy,
        chatLinks: LINKS,
        sheetId: LINKED_SHEET,
      }),
    );
  });
});
