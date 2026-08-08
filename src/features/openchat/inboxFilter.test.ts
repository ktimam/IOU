// visibleInboxFor — the SheetPage wiring that decides which chat cards a sheet shows.
//
// This tests the SheetPage wiring: a verified app-scoped chat handle linked to one sheet must not
// appear on any other sheet, while dismissal/import dedupe uses the app-scoped message handle.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  isCompleteVerifiedOpenChatBatch,
  visibleInboxFor,
  type InboxCard,
  type ImportedEntry,
} from "./inboxFilter";
import { batchSummary, parseDraftBatch } from "../entries/draft";

const CHAT_HANDLE = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI";
const OTHER_CHAT_HANDLE = "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ";

const FC_SHEET = "c819f76d77f260b3"; // the father↔child sheet, the one HE linked that chat to
const HOUSE_SHEET = "1ac9c9c2d4b54061"; // House — where the drafts wrongly appeared
const OTHER_SHEET = "0000000000000000"; // "…etc": any other sheet the father owns

// The father's view: he linked his side of the chat with the child.
const FATHER_LINKS = { [CHAT_HANDLE]: FC_SHEET };

const CHILDS_CARD: InboxCard & { id: string } = {
  id: "1",
  context: { chatHandle: CHAT_HANDLE, messageHandle: "m1" },
  draft: { amount: 10, currency: "USD" },
};

function visible<T extends InboxCard>(
  sheetId: string,
  over: Partial<Parameters<typeof visibleInboxFor<T>>[0]> = {},
) {
  return visibleInboxFor({
    inboxPending: [CHILDS_CARD] as unknown as T[],
    chatLinks: FATHER_LINKS,
    sheetId,
    entries: [] as ImportedEntry[],
    dismissed: new Set<string>(),
    resolveTemplateBase: () => undefined,
    defaultCurrency: "USD",
    ...over,
  });
}

describe("visibleInboxFor — the reported bug, at the call site that caused it", () => {
  it("does not show the child's card on House", () => {
    expect(visible(HOUSE_SHEET)).toHaveLength(0);
  });

  it("does not show it on any OTHER sheet either ('House etc')", () => {
    // The symptom was never one sheet: an unpinned card shows on all of them.
    expect(visible(OTHER_SHEET)).toHaveLength(0);
  });

  it("DOES show it on the sheet that chat is linked to", () => {
    // The other half of the fix, and the one a blunt "hide foreign cards" would break: the fan-out
    // copy is a claim ticket, and the ticket has to be redeemable somewhere.
    expect(visible(FC_SHEET)).toHaveLength(1);
  });

  it("keeps an UNLINKED chat's card visible everywhere, so the user can choose where it lands", () => {
    const stranger = {
      ...CHILDS_CARD,
      context: { chatHandle: OTHER_CHAT_HANDLE, messageHandle: "m9" },
    };
    for (const sheetId of [FC_SHEET, HOUSE_SHEET, OTHER_SHEET]) {
      expect(visible(sheetId, { inboxPending: [stranger] })).toHaveLength(1);
    }
  });

  it("keeps a wrapper-less (pre-v4 local) card visible — it carries no provenance to route by", () => {
    const noContext = { id: "2", draft: { amount: 10, currency: "USD" } };
    expect(visible(HOUSE_SHEET, { inboxPending: [noContext] })).toHaveLength(1);
  });
});

describe("visibleInboxFor — the cross-member layers stay wired", () => {
  it("hides a card ANY member dismissed", () => {
    expect(visible(FC_SHEET, { dismissed: new Set(["m1"]) })).toHaveLength(0);
  });

  it("hides a card ANY member already imported (matched on import_message_id)", () => {
    const entries: ImportedEntry[] = [{ deleted: false, payload: { import_message_id: "m1" } }];
    expect(visible(FC_SHEET, { entries })).toHaveLength(0);
    // Deleting that entry deliberately resurrects the card for whoever did not import it.
    expect(visible(FC_SHEET, { entries: [{ deleted: true, payload: { import_message_id: "m1" } }] })).toHaveLength(1);
  });

  it("collapses a double-confirm race to one card per app-scoped message handle", () => {
    const twin = { ...CHILDS_CARD, id: "2" };
    expect(visible(FC_SHEET, { inboxPending: [CHILDS_CARD, twin] })).toHaveLength(1);
  });
});

describe("visibleInboxFor — the wrapper-less draft_id fallback needs BOTH parse inputs", () => {
  // A pre-v4 wrapper-less local card has no messageId, so duplicate detection falls back to draft_id —
  // which only exists if the draft parses. Both the template resolver and the default currency feed
  // that parse, and dropping either silently turns the fallback off: the card would reappear after a
  // successful import, with nothing failing.
  const CARD = { id: "3", draft: { amount: 10, template: "Reservation" } }; // no currency, no messageId
  const resolveTemplateBase = (raw: unknown) =>
    (raw as { template?: string })?.template === "Reservation"
      ? { currency: "EGP" as const, direction: "credit" as const }
      : undefined;

  function importedEntryFor(defaultCurrency: string, resolver: typeof resolveTemplateBase | (() => undefined)) {
    const id = parseDraftBatch(CARD.draft, resolver, defaultCurrency).drafts[0]?.draftId;
    expect(id, "the fixture itself must parse, or this test proves nothing").toBeDefined();
    return [{ deleted: false, payload: { draft_id: id } }] as ImportedEntry[];
  }

  it("hides the card once its derived draft_id is on the sheet", () => {
    const entries = importedEntryFor("USD", resolveTemplateBase);
    expect(
      visible(HOUSE_SHEET, { inboxPending: [CARD], entries, resolveTemplateBase }),
    ).toHaveLength(0);
  });

  it("derives a DIFFERENT id without the template resolver (so the resolver must be passed through)", () => {
    // The template supplies the currency here, so a dropped resolver changes the hash — the imported
    // entry stops matching and the card comes back.
    const withTemplate = importedEntryFor("USD", resolveTemplateBase);
    expect(
      visible(HOUSE_SHEET, { inboxPending: [CARD], entries: withTemplate, resolveTemplateBase: () => undefined }),
    ).toHaveLength(1);
  });

  it("derives no id at all without the default currency (so it must be passed through)", () => {
    // No currency on the draft, none from a template, none defaulted ⇒ the draft does not parse,
    // there is no draft_id to match, and the card can never self-cancel.
    const entries = importedEntryFor("USD", resolveTemplateBase);
    expect(
      visible(HOUSE_SHEET, {
        inboxPending: [CARD],
        entries,
        resolveTemplateBase: () => undefined,
        defaultCurrency: "",
      }),
    ).toHaveLength(1);
  });
});

describe("visibleInboxFor — exact verified array lifecycle", () => {
  const batch = [
    {
      kind: "iou",
      amount: 350,
      currency: "EGP",
      direction: "credit",
      date: "2026-08-08",
      note: "multi-a exact-run",
      message: "Multi exact-run: two fees",
    },
    {
      kind: "settlement",
      amount: 500,
      currency: "USD",
      direction: "debt",
      date: "2026-08-09",
      note: "multi-b exact-run",
      message: "Multi exact-run: two fees",
    },
  ];
  const card = {
    id: "oc-exact-batch",
    draft: batch,
    context: {
      chatHandle: CHAT_HANDLE,
      messageHandle: "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk",
    },
  };

  it("routes the one array card only to its linked sheet and preserves its two-entry summary", () => {
    const linked = visible(FC_SHEET, { inboxPending: [card] });
    expect(linked).toEqual([card]);
    expect(visible(HOUSE_SHEET, { inboxPending: [card] })).toEqual([]);

    const parsed = parseDraftBatch(linked[0].draft, undefined, "EGP", {
      dateEvidence: "explicit-only",
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.drafts).toHaveLength(2);
    expect(batchSummary(parsed)).toBe(
      "2 entries: IOU 350.00 EGP \u00b7 owed to you \u00b7 2026-08-08 \u00b7 multi-a exact-run " +
      "\u00b7 Settlement 500.00 USD \u00b7 you owe \u00b7 2026-08-09 \u00b7 multi-b exact-run",
    );
  });

  it("never recovers a hidden date from OpenChat message or Note text", () => {
    const parsed = parseDraftBatch(
      [
        {
          ...batch[0],
          date: undefined,
          note: "multi-a exact-run 2023-04-05",
          message: "Multi exact-run 2024-06-07",
        },
      ],
      undefined,
      "EGP",
      { dateEvidence: "explicit-only" },
    );
    expect(parsed.errors).toEqual([]);
    expect(new Date(parsed.drafts[0].initial.ts ?? 0).toISOString().slice(0, 10)).toBe(
      new Date().toISOString().slice(0, 10),
    );
  });

  it("rejects the whole verified array when even one row is consumer-invalid", () => {
    const parsed = parseDraftBatch(
      [batch[0], { ...batch[1], amount: 0 }],
      undefined,
      "EGP",
      { dateEvidence: "explicit-only" },
    );
    expect(parsed.drafts).toHaveLength(1);
    expect(parsed.errors).toHaveLength(1);
    expect(isCompleteVerifiedOpenChatBatch(parsed)).toBe(false);
    expect(
      isCompleteVerifiedOpenChatBatch({ drafts: parsed.drafts, errors: [] }),
    ).toBe(true);
  });

  it("wires the all-or-nothing guard before either SheetPage review mutation", () => {
    const source = readFileSync(resolve(__dirname, "../entries/SheetPage.tsx"), "utf8");
    const parsedAt = source.indexOf("const { drafts, errors } = parseDraftBatch(");
    const guardAt = source.indexOf(
      'if (p.source === "openchat" && !isCompleteVerifiedOpenChatBatch({ drafts, errors }))',
      parsedAt,
    );
    const batchAt = source.indexOf("setBatch({", guardAt);
    const singleAt = source.indexOf("openAdd(", guardAt);

    expect(parsedAt).toBeGreaterThanOrEqual(0);
    expect(guardAt).toBeGreaterThan(parsedAt);
    expect(batchAt).toBeGreaterThan(guardAt);
    expect(singleAt).toBeGreaterThan(guardAt);
    expect(source.slice(guardAt, Math.min(batchAt, singleAt))).toContain("return;");
  });
});
