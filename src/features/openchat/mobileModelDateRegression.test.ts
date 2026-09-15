import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  IOU_IMAGE_EXTRACTION_PROMPT,
  iouActionManifest,
} from "./actionManifest";
import {
  MODEL_ACCEPTANCE_CASES,
  scoreModelAcceptanceCase,
  type ModelAcceptanceCase,
  type ModelAcceptanceObservation,
} from "./modelAcceptanceCases";

type MobileDateContract = Readonly<{
  description: string;
  source: Readonly<{
    mediaType: "image/jpeg";
    encodedWidth: number;
    encodedHeight: number;
    visibleOperation: string;
    visibleAmount: string;
    visibleCurrency: string;
    visibleDate: string;
  }>;
  expected: Readonly<{
    kind: "settlement";
    amount: number;
    currency: string;
    direction: "credit";
    date: string;
  }>;
  reportedWrongDate: string;
}>;

const fixture = JSON.parse(
  readFileSync(
    resolve(
      __dirname,
      "../../../test/fixtures/openchat/model-acceptance/mobile-date-contract.json",
    ),
    "utf8",
  ),
) as MobileDateContract;

const acceptanceCase: ModelAcceptanceCase = {
  // This source-only contract does not join the real-model matrix: it deliberately persists no
  // source pixels. Its fixed visible fields exercise the same exact scorer and prompt declaration.
  id: "dated-image",
  modality: "image",
  expected: [
    {
      ...fixture.expected,
      noteIncludes: [],
      noteAllowedWords: [],
    },
  ],
  expectedInferCalls: 1,
  warmLatencyMs: 120_000,
};

function observation(date: string): ModelAcceptanceObservation {
  const extracted = { ...fixture.expected, date, note: "" };
  return {
    resultKind: "ready",
    extracted: [extracted],
    cardRows: [
      { label: "Amount", value: String(extracted.amount) },
      { label: "Currency", value: extracted.currency },
      { label: "Type", value: extracted.kind },
      { label: "Direction", value: extracted.direction },
      { label: "Date", value: extracted.date },
      { label: "Note", value: "" },
    ],
    confirmPayload: extracted,
    inferCalls: 1,
    actionMs: 1,
  };
}

describe("mobile portrait model date regression", () => {
  it("pins only privacy-safe visible evidence and the exact expected value", () => {
    expect(fixture).toMatchObject({
      source: {
        mediaType: "image/jpeg",
        encodedWidth: 809,
        encodedHeight: 1280,
        visibleOperation: "transaction was successful",
        visibleAmount: "13,500",
        visibleCurrency: "EGP",
        visibleDate: "13 Aug 2026 11:59 AM",
      },
      expected: {
        kind: "settlement",
        amount: 13_500,
        currency: "EGP",
        direction: "credit",
        date: "2026-08-13",
      },
      reportedWrongDate: "2026-07-14",
    });
    const serialized = JSON.stringify(fixture).toLowerCase();
    expect(serialized).not.toMatch(/@|account|iban|reference|sender|receiver/);
  });

  it("keeps concrete calendar examples out of the unified image-model prompt", () => {
    const prompt = IOU_IMAGE_EXTRACTION_PROMPT;
    expect(prompt).not.toMatch(/\b(?:19|20)\d{2}-\d{2}-\d{2}\b/);
    expect(prompt).not.toMatch(
      /\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{4}\b/i,
    );
    expect(prompt).toMatch(
      /keep its weekday[^.]*month[^.]*day number[^.]*printed year exactly as shown/i,
    );
    expect(prompt).toMatch(/never invent a year or an endpoint/i);
    expect(prompt).toContain('Both date fields are strings, never nested objects or null');
    expect(prompt).toContain('If no date is visible, omit both fields');
  });

  it("runs a distinct portrait August image through the real-model matrix", () => {
    const realCase = MODEL_ACCEPTANCE_CASES.find(
      (candidate) => candidate.id === "portrait-date-image",
    );
    expect(realCase).toMatchObject({
      modality: "image",
      imageFixture: {
        path: "test/fixtures/openchat/model-acceptance/portrait-transfer-14-aug.png",
        width: 909,
        height: 1600,
      },
      expected: [
        {
          amount: 12_900,
          currency: "EGP",
          kind: "settlement",
          date: "2026-08-14",
        },
      ],
      expectedInferCalls: 1,
    });
    const arabicLabelCase = MODEL_ACCEPTANCE_CASES.find(
      (candidate) => candidate.id === "portrait-date-image-arabic",
    );
    expect(arabicLabelCase).toMatchObject({
      modality: "image",
      imageFixture: {
        path: "test/fixtures/openchat/model-acceptance/portrait-transfer-14-aug-arabic.png",
        sha256:
          "90f2e0a8f6cdf05a51624ef7bfdade0ff0a6d7f4ecc066d3749904d421e028d7",
        bytes: 62_985,
        width: 909,
        height: 1_600,
      },
      expected: [
        {
          amount: 12_900,
          currency: "EGP",
          kind: "settlement",
          date: "2026-08-14",
          noteIncludes: [],
          noteAllowedWords: [],
        },
      ],
      expectedInferCalls: 1,
    });
    const arabicSource = readFileSync(
      resolve(
        __dirname,
        "../../../test/fixtures/openchat/model-acceptance/portrait-transfer-14-aug-arabic.svg",
      ),
      "utf8",
    );
    expect(arabicSource).toContain("التاريخ:");
    expect(arabicSource).toContain("14 Aug 2026 09:47 PM");
    expect(arabicSource).not.toMatch(/@|iban|account number|bank to trust/i);
    // The original fixture accidentally made this an easy center-detail case. The real failing
    // receipt puts a small value at the far left of a row whose Arabic label is at the far right,
    // about 81% down the portrait image. The one full-image pass must inspect that complete row.
    expect(arabicSource).toContain(
      '<text x="815" y="1288" text-anchor="end" direction="rtl"',
    );
    expect(arabicSource).toContain(
      '<text x="80" y="1288" font-size="28">14 Aug 2026 09:47 PM</text>',
    );
    const dateRowRatio = 1288 / 1600;
    expect(dateRowRatio).toBeGreaterThan(0.8);
    expect(dateRowRatio).toBeLessThan(0.86);
  });

  it("binds financial fields and a generic source-grounded category to one full-image model pass", () => {
    const schema = iouActionManifest.outputSchema as {
      "x-openchat-image-prompt-template"?: {
        version: number;
        template: string;
        includeRuleGuidance: boolean;
      };
      "x-openchat-image-focused-passes"?: unknown;
    };
    expect(schema["x-openchat-image-prompt-template"]).toEqual({
      version: 1,
      template: IOU_IMAGE_EXTRACTION_PROMPT,
      includeRuleGuidance: false,
    });
    expect(schema).not.toHaveProperty("x-openchat-image-focused-passes");
    expect(schema).not.toHaveProperty("x-openchat-image-note-composition");
    for (const field of [
      "amount",
      "currency",
      "kind",
      "printed_date",
      "printed_end_date",
      "note",
    ]) {
      expect(IOU_IMAGE_EXTRACTION_PROMPT).toContain(`"${field}"`);
    }
    expect(IOU_IMAGE_EXTRACTION_PROMPT).toMatch(
      /"note":[^.]*uppermost prominent standalone heading/i,
    );
    expect(IOU_IMAGE_EXTRACTION_PROMPT).toMatch(
      /copy the complete visible transaction date/i,
    );
    expect(IOU_IMAGE_EXTRACTION_PROMPT).toMatch(
      /keep its weekday[^.]*month[^.]*day number/i,
    );
    expect(IOU_IMAGE_EXTRACTION_PROMPT).toContain('include BOTH "printed_date" and "printed_end_date"');
    expect(IOU_IMAGE_EXTRACTION_PROMPT).toContain('A single date has an empty ending date');
    expect(IOU_IMAGE_EXTRACTION_PROMPT).toContain('Never use any other date field');
    expect(IOU_IMAGE_EXTRACTION_PROMPT).not.toMatch(/reservation|booking|check-in|check out|total payout|total coming/i);
  });

  it("accepts the visible August date and rejects the reported July result", () => {
    expect(
      scoreModelAcceptanceCase(acceptanceCase, observation(fixture.expected.date), {
        enforceLatency: false,
      }),
    ).toEqual({ pass: true, reasons: [] });
    expect(
      scoreModelAcceptanceCase(
        acceptanceCase,
        observation(fixture.reportedWrongDate),
        { enforceLatency: false },
      ).reasons,
    ).toContain(
      "entry 1 date expected 2026-08-13, observed 2026-07-14",
    );
  });
});
