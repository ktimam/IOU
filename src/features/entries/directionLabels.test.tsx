import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { DIRECTION_LABELS } from "./directionLabels";
import { EntryForm } from "./EntryForm";
import { TemplatesManager } from "../templates/TemplatesManager";
import type { PairTemplatesApi } from "../templates/PairTemplatesContext";
import type { Direction } from "./types";

vi.mock("../settings/usePreferences", () => ({
  usePreferences: () => ({ prefs: { defaultCurrency: "EGP" } }),
}));
vi.mock("../templates/TemplatesContext", () => ({
  useTemplates: () => ({
    templates: [{ id: "legacy", name: "Legacy preset", direction: "credit", txn_type: "iou" }],
    removeTemplate: vi.fn(), loading: false, error: null,
  }),
}));

function pairFixture(): PairTemplatesApi {
  const shared = [
    { id: "mine", name: "My preset", direction: "credit" as const, txn_type: "iou" as const, rev: 1, updatedAt: 1 },
    { id: "partner", name: "Partner preset", direction: "debt" as const, txn_type: "iou" as const, rev: 1, updatedAt: 1 },
  ];
  return {
    shared, merged: shared, myIds: new Set(["mine"]), dismissed: new Set(), loading: false, error: null,
    upsertMyTemplate: vi.fn(), removeMyTemplate: vi.fn(), dismissCard: vi.fn(), reload: vi.fn(),
  };
}

describe("website direction wording", () => {
  it("keeps display copy separate from the two stored direction enums", () => {
    expect(DIRECTION_LABELS).toEqual({ credit: "Owed to you", debt: "You owe" });
  });

  it("renders the saved-type editor with exact wording and unchanged option values", () => {
    const pair = pairFixture();
    const before = JSON.stringify(pair.shared);
    const html = renderToStaticMarkup(<TemplatesManager pair={pair} />);
    expect(html).toContain('<option value="credit" selected="">Owed to you</option>');
    expect(html).toContain('<option value="debt">You owe</option>');
    expect(html).toContain('<strong>My preset</strong> <span class="muted small">Owed to you · IOU</span>');
    expect(html).toContain('<strong>Partner preset</strong> <span class="muted small">You owe · IOU</span>');
    expect(html).toContain('<strong>Legacy preset</strong> <span class="muted small">Owed to you · IOU</span>');
    expect(html).not.toMatch(/Credit|Debit|Incoming|Outgoing/);
    expect(JSON.stringify(pair.shared)).toBe(before);
    expect(pair.upsertMyTemplate).not.toHaveBeenCalled();
  });

  it.each(["credit", "debt"] as const)("renders the entry form's %s selection without changing its meaning", (direction: Direction) => {
    const initial = { direction, ts: Date.UTC(2026, 8, 8), currency: "EGP", amount_minor: 1290000 };
    const before = JSON.stringify(initial);
    const html = renderToStaticMarkup(<EntryForm
      myPrincipal="test-author" partnerPrincipal="test-partner" initial={initial}
      onCancel={() => {}} onSubmit={async () => {}}
    />);
    const fieldset = html.match(/<fieldset><legend>Direction<\/legend>(.*?)<\/fieldset>/)?.[1];
    expect(fieldset).toBeDefined();
    expect(fieldset).toContain("Owed to you");
    expect(fieldset).toContain("You owe");
    expect(fieldset).toContain(`<input type="radio" checked=""/>${DIRECTION_LABELS[direction]}`);
    expect(html).not.toMatch(/Credit|Debit|Incoming|Outgoing/);
    expect(JSON.stringify(initial)).toBe(before);
  });

  it("uses the same labels after viewer orientation in the sheet list, not the stored author's enum", () => {
    // The full encrypted sheet loader is outside this wording check. Preserve its existing
    // orientation call and assert this display surface consumes the shared labels.
    const source = readFileSync(new URL("./SheetPage.tsx", import.meta.url), "utf8");
    expect(source).toContain("const dir = orientDirection(e.payload.direction, mine)");
    expect(source).toContain("{DIRECTION_LABELS[dir]}");
    expect(source).not.toContain('dir === "credit" ? "Credit" : "Debit"');
  });
});
