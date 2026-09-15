import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { EntryDraft } from "../entries/draft";
import type { Direction } from "../entries/types";
import type { TxnTemplate } from "../templates/TemplatesContext";
import fixture from "./fixtures/recorded-shared-image-proposals-20260909.json";
import { iouActionManifest } from "./actionManifest";
import { buildConfirmPayload, buildMultiConfirmPayload, initEntries, initToFormState } from "./cardBridge";
import { processIouRequest } from "./localProcessorBridge";
import { clearSavedTypeSelection, editCardForm, hydrateSavedTypeForCard } from "./OpenChatCardPage";

// IOU-only replay of immutable ACTUAL recorded single-image model completions. Synthetic private
// rosters are supplied after extraction; no model sees a private name or keyword. This does not run
// inference or the OpenChat parser, hydrate an authenticated iframe, encrypt template references,
// post/import an entry, or qualify a prompt/GPU/APK/phone. Multi-row tests below are constructed
// controls, not evidence that either model correctly extracted a multi-transaction image.
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const recordedIds = [
  "gemma-proof-real-arabic-transfer",
  "qwen-proof-real-arabic-transfer",
  "gemma-proof-real-payout-range",
  "qwen-proof-real-payout-range",
  "gemma-proof-real-english-transfer",
] as const;

function recorded(id: typeof recordedIds[number]) {
  const capture = fixture.captures.find(item => item.id === id);
  if (!capture) throw new Error(`Missing recorded completion: ${id}`);
  const source = fixture.sources.find(item => item.id === capture.sourceId);
  if (!source) throw new Error(`Missing independent source: ${capture.sourceId}`);
  expect(sha(capture.raw)).toBe(capture.rawSha256);
  expect(capture.expected.sourceValuesAccepted).toBe(true);
  let text = capture.raw;
  if (capture.wrapper !== "object") {
    // Decode only the fixture's exact known fence. This is not an alternative host parser.
    expect(capture.wrapper).toBe("json-fence");
    expect(text.startsWith("```json\n") && text.endsWith("\n```")).toBe(true);
    text = text.slice("```json\n".length, -"\n```".length);
  }
  const value = JSON.parse(text) as Record<string, unknown>;
  expect(value.note).toBe(source.raw.note);
  const binding = { frameNonce: "a".repeat(48), requestNonce: "b".repeat(48) };
  const result = processIouRequest({ type: "oc:app-process:request", version: 1, ...binding,
    actionId: iouActionManifest.id, input: { operation: "normalize", modality: "image",
      sourceTimestamp: Date.parse(source.sourceTimestamp), candidates: [value] } }, binding);
  if (result.kind !== "candidates" || result.candidates.length !== 1) {
    throw new Error("Expected one app-normalized recorded candidate");
  }
  const candidate = result.candidates[0];
  const initial = initToFormState(candidate, new Date(source.sourceTimestamp));
  return { capture, source, candidate, initial };
}

function privateType(keyword: string, direction: Direction): TxnTemplate {
  return {
    id: `synthetic-private-${direction}`,
    // Deliberately unrelated to the screenshot heading: the private keyword supplies the match.
    name: direction === "debt" ? "Violet ledger bucket" : "Copper ledger bucket",
    keywords: [keyword],
    direction,
    txn_type: "iou",
  };
}

describe("recorded image completions through IOU private saved types and confirmation", () => {
  it("keeps the frozen fixture, prior accuracy failures and both model identities intact", () => {
    expect(sha(JSON.stringify(fixture))).toBe("5b7f00d1b121b4c57729e0118573aa04753a709d674e70ee12ff039c8938eb07");
    expect(fixture.captures.filter(item => !item.expected.sourceValuesAccepted)).toHaveLength(5);
    expect(new Set(recordedIds.map(id => {
      const capture = fixture.captures.find(item => item.id === id)!;
      return fixture.runs.find(run => run.id === capture.runId)!.modelId;
    }))).toEqual(new Set(["gemma-4-e2b-it-q4", "qwen3-vl-2b-instruct-q4"]));
  });

  for (const direction of ["debt", "credit"] as const) {
    it.each(recordedIds)(`applies arbitrary private ${direction} type after recorded extraction: %s`, id => {
      const { capture, source, candidate, initial } = recorded(id);
      const template = privateType(source.raw.note, direction);
      expect(capture.raw).not.toContain(template.id);
      expect(capture.raw).not.toContain(template.name);
      expect(initial.templateId).toBeUndefined();
      const hydrated = hydrateSavedTypeForCard(initial, candidate, [template]);
      expect(hydrated).toEqual({ ...initial, templateId: template.id,
        directionBeforeSavedType: initial.direction, direction });
      const confirmed = buildConfirmPayload(hydrated);
      expect(confirmed).toEqual({ ...source.card, direction });
      // This preserves recorded amount, currency, public IOU/Settlement kind, date, heading and
      // app-appended complete interval. Private txn_type/defaults do not rewrite those fields.
      for (const key of ["templateId", "template", "directionBeforeSavedType", "directionEdited", "template_ref"]) {
        expect(confirmed).not.toHaveProperty(key);
      }
      expect(JSON.stringify(confirmed)).not.toContain(template.name);
      expect(JSON.stringify(confirmed)).not.toContain(template.id);
      expect(sha(capture.raw)).toBe(capture.rawSha256);
    });
  }

  it("does not select a type for absent, nonmatching or ambiguous private rosters", () => {
    const { source, candidate, initial } = recorded("qwen-proof-real-payout-range");
    const debt = privateType(source.raw.note, "debt");
    const credit = privateType(source.raw.note, "credit");
    const unrelated = privateType("Unrelated synthetic purpose", "debt");
    for (const templates of [[], [unrelated], [debt, credit]]) {
      expect(hydrateSavedTypeForCard(initial, candidate, templates)).toEqual(initial);
      expect(buildConfirmPayload(initial)).not.toHaveProperty("template_ref");
    }
  });

  it.each(["before", "after"] as const)("preserves explicit user edits made %s roster hydration", timing => {
    const { source, candidate, initial } = recorded("qwen-proof-real-payout-range");
    const template = privateType(source.raw.note, "debt");
    let state = timing === "after" ? hydrateSavedTypeForCard(initial, candidate, [template]) : initial;
    state = editCardForm(state, "direction", "credit", [template]);
    state = editCardForm(state, "amount", "1900.25", [template]);
    state = editCardForm(state, "note", `${initial.note} | Reviewed by user`, [template]);
    const edited = { ...state };
    state = hydrateSavedTypeForCard(clearSavedTypeSelection(state), candidate, [template]);
    expect(state.templateId).toBe(template.id);
    expect(state.direction).toBe("credit");
    expect(state.amount).toBe(edited.amount);
    expect(state.note).toBe(edited.note);
    expect(buildConfirmPayload(state)).toEqual({ ...source.card, direction: "credit",
      amount: 1900.25, note: `${source.card.note} | Reviewed by user` });
    // These edits are intentional user overrides, not corrected model evidence or a new oracle.
    expect(source.card.amount).toBe(1912.15);
  });
});

describe("constructed multi-candidate saved-type controls (NOT model outputs)", () => {
  const templates: TxnTemplate[] = [
    { id: "synthetic-north", name: "North account category", keywords: ["Violet cable"], direction: "debt", txn_type: "iou" },
    { id: "synthetic-south", name: "South account category", keywords: ["Copper lantern"], direction: "credit", txn_type: "iou" },
  ];
  const sharedMessage = "Violet cable 75 EGP; Copper lantern 75 EGP; Saffron notebook 75 EGP";
  const rows: EntryDraft[] = ["Violet cable", "Copper lantern", "Saffron notebook"].map(note => ({
    kind: "iou", amount: 75, currency: "EGP", direction: "debt", date: "2026-09-10", note, message: sharedMessage,
  }));

  it("uses each row's own note, not a sibling keyword repeated in shared message", () => {
    const states = initEntries({ entries: rows });
    if (!states) throw new Error("Expected multi-card state");
    const hydrated = states.map((state, index) => hydrateSavedTypeForCard(state, rows[index], templates, { evidence: "row-local" }));
    expect(hydrated.map(state => state.templateId)).toEqual(["synthetic-north", "synthetic-south", undefined]);
    expect(hydrated.map(state => state.direction)).toEqual(["debt", "credit", "debt"]);
    const confirmed = buildMultiConfirmPayload(hydrated);
    expect(confirmed).toEqual(rows.map((row, index) => ({ ...row, direction: index === 1 ? "credit" : "debt" })));
    expect(confirmed).toHaveLength(3); // Equal monetary values remain distinct rows.
    for (const row of confirmed) expect(row).not.toHaveProperty("templateId");
  });

  it("keeps a filtered one-row array row-local and ambiguous row notes unselected", () => {
    const survivors = initEntries({ entries: [rows[2]] });
    if (!survivors) throw new Error("Expected one-row multi-card state");
    const survivor = hydrateSavedTypeForCard(survivors[0], rows[2], templates, { evidence: "row-local" });
    expect(survivor.templateId).toBeUndefined();
    const ambiguous = { ...rows[0], note: "Violet cable and Copper lantern" };
    const state = initToFormState(ambiguous);
    expect(hydrateSavedTypeForCard(state, ambiguous, templates, { evidence: "row-local" })).toEqual(state);
  });
});
