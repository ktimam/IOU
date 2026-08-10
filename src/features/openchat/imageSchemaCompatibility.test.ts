import { describe, expect, it } from "vitest";
import registration from "../../../docs/openchat-registration.json";
import {
  buildIouOutputSchema,
  IOU_MAX_MAJOR_AMOUNT,
  IOU_MIN_MAJOR_AMOUNT,
} from "./actionManifest";
import { buildConfirmPayload, initToFormState } from "./cardBridge";
import { parseDraft } from "../entries/draft";
import { buildManifestWire } from "./registerAiApp";

const EXACT_PUBLIC_ROWS = [
  "amount",
  "currency",
  "kind",
  "direction",
  "date",
  "note",
];

function schemaProperties(schema: unknown): Record<string, Record<string, unknown>> {
  expect(schema).toBeTypeOf("object");
  expect(schema).not.toBeNull();
  const properties = (schema as { properties?: unknown }).properties;
  expect(properties).toBeTypeOf("object");
  expect(properties).not.toBeNull();
  return properties as Record<string, Record<string, unknown>>;
}

function expectImageSafeOptionalFields(schema: unknown): void {
  const properties = schemaProperties(schema);
  expect(properties.amount).toMatchObject({
    type: "number",
    minimum: IOU_MIN_MAJOR_AMOUNT,
    maximum: IOU_MAX_MAJOR_AMOUNT,
  });
  expect(properties.currency).toMatchObject({
    type: "string",
    minLength: 3,
    maxLength: 3,
    format: "ascii-uppercase",
    "x-openchat-require-text-evidence": true,
  });
  expect(properties.date).toMatchObject({
    type: "string",
    format: "date",
    minLength: 10,
    maxLength: 10,
  });
  expect(properties.date).not.toHaveProperty("x-openchat-omit-for-image-only");
  expect(properties.note).toMatchObject({
    type: "string",
    maxLength: 4_096,
    format: "utf8-no-nul",
  });
  expect(properties.message).toMatchObject({
    type: "string",
    minLength: 1,
    maxLength: 200,
    format: "utf8-no-nul",
    "x-openchat-omit-for-image-only": true,
  });
  expect((schema as { required?: unknown }).required).toEqual([
    "amount",
    "kind",
    "direction",
  ]);
}

describe("OpenChat image extraction compatibility", () => {
  it("declares a bounded reviewable image date while still omitting image-only message text", () => {
    expectImageSafeOptionalFields(buildIouOutputSchema([]));
    expectImageSafeOptionalFields(
      (registration as { responseSchema: unknown }).responseSchema,
    );
  });

  it("preserves receipt-2's visible 04 Jul 2026 date through card review and explicit import", () => {
    // Regression evidence: receipt-2.png (SHA-256 71BC0C1D...3A8012) visibly contains
    // `Date: 04 Jul 2026 03:19 PM`. IOU stores the date portion as its canonical YYYY-MM-DD value;
    // model inference/OCR remains an OpenChat responsibility, while this test pins IOU's handoff.
    const card = initToFormState({
      kind: "settlement",
      amount: 9_757,
      currency: "EGP",
      direction: "credit",
      date: "2026-07-04",
      note: "Bill Payments - M9-4A-01",
    });
    expect(card.date).toBe("2026-07-04");

    const confirmed = buildConfirmPayload(card);
    expect(confirmed.date).toBe("2026-07-04");
    const imported = parseDraft(confirmed, undefined, { dateEvidence: "explicit-only" });
    expect(imported.ok).toBe(true);
    if (imported.ok) {
      expect(new Date(imported.value.initial.ts ?? 0).toISOString().slice(0, 10)).toBe(
        "2026-07-04",
      );
    }
  });

  it("registers the same constrained schema and the exact rows the IOU attester recomputes", () => {
    const action = (buildManifestWire("") as unknown as {
      actions: {
        response_schema: string;
        card: { rows: { field: string; label: string }[] };
      }[];
    }).actions[0];

    expectImageSafeOptionalFields(JSON.parse(action.response_schema));
    expect(action.card.rows.map(({ field }) => field)).toEqual(EXACT_PUBLIC_ROWS);
    expect(action.card.rows.map(({ label }) => label)).toEqual([
      "Amount",
      "Currency",
      "Type",
      "Direction",
      "Date",
      "Note",
    ]);
  });

  it("keeps calendar year zero outside the app's accepted draft boundary", () => {
    const parsed = parseDraft({ amount: 25, currency: "EGP", date: "0000-01-01" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors).toContain("date must be YYYY-MM-DD");
  });

  it("keeps the direct draft parser inside the manifest's exact amount range", () => {
    const exact = parseDraft({ amount: IOU_MAX_MAJOR_AMOUNT, currency: "EGP" });
    expect(exact.ok).toBe(true);
    if (exact.ok) {
      expect(exact.value.initial.amount_minor).toBe(Number.MAX_SAFE_INTEGER);
    }
    for (const amount of [IOU_MAX_MAJOR_AMOUNT + 0.01, 1e308]) {
      const parsed = parseDraft({ amount, currency: "EGP" });
      expect(parsed.ok).toBe(false);
    }
  });
});
