import { describe, expect, it } from "vitest";
import registration from "../../../docs/openchat-registration.json";
import {
  buildIouOutputSchema,
  IOU_MAX_MAJOR_AMOUNT,
  IOU_MIN_MAJOR_AMOUNT,
} from "./actionManifest";
import { parseDraft } from "../entries/draft";
import { buildManifestWire } from "./registerAiApp";

const EXACT_PUBLIC_ROWS = [
  "amount",
  "currency",
  "kind",
  "direction",
  "date",
  "note",
  "message",
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
  });
  expect(properties.date).toMatchObject({
    type: "string",
    format: "date",
    minLength: 10,
    maxLength: 10,
  });
  expect(properties.note).toMatchObject({
    type: "string",
    maxLength: 4_096,
    format: "utf8-no-nul",
  });
  expect(properties.message).toMatchObject({
    type: "string",
    maxLength: 200,
    format: "utf8-no-nul",
  });
}

describe("OpenChat image extraction compatibility", () => {
  it("declares enough bounded schema metadata to remove malformed optional vision output", () => {
    expectImageSafeOptionalFields(buildIouOutputSchema([]));
    expectImageSafeOptionalFields(
      (registration as { responseSchema: unknown }).responseSchema,
    );
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
      "Message",
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
