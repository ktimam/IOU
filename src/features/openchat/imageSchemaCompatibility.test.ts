import { describe, expect, it } from "vitest";
import registration from "../../../docs/openchat-registration.json";
import {
  buildIouOutputSchema,
  IOU_DATE_ALIASES,
  IOU_MAX_MAJOR_AMOUNT,
  IOU_MIN_MAJOR_AMOUNT,
} from "./actionManifest";
import { buildConfirmPayload, initToFormState } from "./cardBridge";
import { parseDraft } from "../entries/draft";
import { buildManifestWire } from "./registerAiApp";
import { postProcessIouCandidate } from "./localExtraction";
import { IOU_IMAGE_HEADING_MAX_CODEPOINTS } from "./imageHeading";

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
    minLength: 1,
    maxLength: 16,
    format: "utf8-no-nul",
    "x-openchat-require-text-evidence": true,
  });
  // Symbols are bounded transport data; only IOU resolves them to a code. Host regex/default
  // currency behavior would undo the app-owned normalization contract.
  expect(properties.currency).not.toHaveProperty("pattern");
  expect(properties.currency).not.toHaveProperty("default");
  expect(properties.currency).not.toHaveProperty("x-openchat-default-for-image-only");
  expect(properties.direction).toMatchObject({
    type: "string",
    enum: ["credit", "debt"],
    default: "debt",
    "x-openchat-default-for-image-only": "credit",
  });
  expect(properties.date).toMatchObject({
    type: "string",
    format: "utf8-no-nul",
    minLength: 1,
    maxLength: 96,
  });
  expect(properties.date).not.toHaveProperty("x-openchat-normalize-date");
  expect(properties.date).not.toHaveProperty("x-openchat-date-from-text");
  expect(properties.date).not.toHaveProperty("x-openchat-omit-for-image-only");
  expect(properties.date).not.toHaveProperty("x-openchat-property-aliases");
  for (const alias of IOU_DATE_ALIASES) {
    expect(properties[alias]).toMatchObject({ type: "string", minLength: 1, maxLength: 96, format: "utf8-no-nul" });
  }
  expect(properties.printed_date).toMatchObject({ type: "string", minLength: 1, maxLength: 96, format: "utf8-no-nul" });
  expect(properties.printed_end_date).toMatchObject({ type: "string", minLength: 0, maxLength: 96, format: "utf8-no-nul" });
  for (const field of ["printed_date", "printed_end_date"]) {
    expect(properties[field]).not.toHaveProperty("x-openchat-normalize-date");
    expect(properties[field]).not.toHaveProperty("x-openchat-date-from-text");
    expect(properties[field]).not.toHaveProperty("x-openchat-property-aliases");
  }
  expect(properties.note).toMatchObject({
    type: "string",
    maxLength: 4_096,
    format: "utf8-no-nul",
  });
  expect(properties.image_heading).toEqual({
    type: "string",
    minLength: 1,
    maxLength: IOU_IMAGE_HEADING_MAX_CODEPOINTS,
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
  it("transports a separate optional image heading without making it a public row or confirmed field", () => {
    const schema = buildIouOutputSchema([]);
    expect(schema.required).not.toContain("image_heading");
    const normalized = postProcessIouCandidate({
      kind: "iou", amount: 48.75, currency: "CAD", direction: "debt",
      note: "Parts for the workshop", image_heading: "  Amber equipment  ",
    }, { modality: "image" });
    expect(normalized).toMatchObject({ note: "Parts for the workshop", image_heading: "Amber equipment" });
    const confirmed = buildConfirmPayload(initToFormState(normalized));
    expect(confirmed.note).toBe("Parts for the workshop");
    expect(confirmed).not.toHaveProperty("image_heading");
    const imported = parseDraft(confirmed, undefined, { dateEvidence: "explicit-only" });
    expect(imported.ok).toBe(true);
    if (imported.ok) expect(imported.value.initial).not.toHaveProperty("image_heading");
  });

  it("declares bounded literal currency and printed dates while still omitting image-only message text", () => {
    expectImageSafeOptionalFields(buildIouOutputSchema([]));
    expectImageSafeOptionalFields(
      (registration as { responseSchema: unknown }).responseSchema,
    );
  });

  it.each([["$", "USD"], ["EGP", "EGP"]])(
    "normalizes literal %s and a complete printed date inside IOU before card/import: %s", (token, code) => {
      const normalized = postProcessIouCandidate({ amount: 12900, currency: token, kind: "settlement",
        direction: "credit", printed_date: "14 Aug 2026", printed_end_date: "", note: "Visible heading" },
      { modality: "image", sourceTimestamp: "2026-09-08T12:00:00.000Z" });
      expect(normalized).toMatchObject({ amount: 12900, currency: code, date: "2026-08-14" });
      expect(normalized).not.toHaveProperty("printed_date");
      expect(normalized).not.toHaveProperty("printed_end_date");
      const card = initToFormState(normalized);
      const confirmed = buildConfirmPayload(card);
      expect(confirmed).toMatchObject({ amount: 12900, currency: code, direction: "credit", date: "2026-08-14" });
      const imported = parseDraft(confirmed, undefined, { dateEvidence: "explicit-only" });
      expect(imported.ok).toBe(true);
      if (imported.ok) {
        expect(imported.value.initial.currency).toBe(code);
        expect(imported.value.initial.amount_minor).toBe(1290000);
        expect(new Date(imported.value.initial.ts ?? 0).toISOString().slice(0, 10)).toBe("2026-08-14");
      }
    },
  );

  it.each(["ecp", "USD or CAD", "USD\n", "$$", { code: "USD" }])(
    "does not turn transported malformed currency evidence into a confirmation currency: %j", (currency) => {
      const normalized = postProcessIouCandidate({ amount: 25, currency }, { modality: "image" });
      expect(normalized).not.toHaveProperty("currency");
      expect(buildConfirmPayload(initToFormState(normalized))).not.toHaveProperty("currency");
    },
  );

  it.each([undefined, null, { date: "14 Aug 2026" }, "not a date"])(
    "rejects a missing or malformed printed end without losing the valid currency: %j", (printed_end_date) => {
      const normalized = postProcessIouCandidate({ amount: 25, currency: "$",
        printed_date: "14 Aug 2026", printed_end_date }, { modality: "image" });
      expect(normalized.currency).toBe("USD");
      expect(normalized).not.toHaveProperty("date");
      const confirmed = buildConfirmPayload(initToFormState(normalized));
      expect(confirmed.currency).toBe("USD");
      expect(confirmed).not.toHaveProperty("date");
    },
  );

  it("preserves receipt-2's visible 04 Jul 2026 date through card review and explicit import", () => {
    // Regression evidence: receipt-2.png (SHA-256 71BC0C1D...3A8012) visibly contains
    // `Date: 04 Jul 2026 03:19 PM`. IOU stores the date portion as its canonical YYYY-MM-DD value;
    // OpenChat transports the visible string; IOU normalizes it before card review and import.
    const card = initToFormState(postProcessIouCandidate({
      kind: "settlement",
      amount: 9_757,
      currency: "EGP",
      direction: "credit",
      date: "04 Jul 2026 03:19 PM",
      note: "Bill Payments - M9-4A-01",
    }, { modality: "image" }));
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
