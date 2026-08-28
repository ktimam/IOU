import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  IOU_IMAGE_DATE_EXTRACTION_PROMPT,
  IOU_IMAGE_EXTRACTION_PROMPT,
  iouActionManifest,
} from "./actionManifest";
import {
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
  expectedInferCalls: 2,
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
    inferCalls: 2,
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

  it("keeps concrete calendar examples out of every image-model prompt", () => {
    for (const prompt of [
      IOU_IMAGE_EXTRACTION_PROMPT,
      IOU_IMAGE_DATE_EXTRACTION_PROMPT,
    ]) {
      expect(prompt).not.toMatch(/\b(?:19|20)\d{2}-\d{2}-\d{2}\b/);
      expect(prompt).not.toMatch(
        /\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{4}\b/i,
      );
    }
    expect(IOU_IMAGE_DATE_EXTRACTION_PROMPT).toContain(
      "compare the output year, month, and day",
    );
    expect(IOU_IMAGE_DATE_EXTRACTION_PROMPT).toContain(
      "filename, metadata, and date from the instructions",
    );
  });

  it("binds date to a disjoint model-only focused pass", () => {
    const pipeline = iouActionManifest.outputSchema[
      "x-openchat-image-focused-passes"
    ] as {
      primaryFields: string[];
      primaryMaxTokens: number;
      passes: { fields: string[]; maxTokens: number; template: string }[];
    };
    expect(pipeline.primaryFields).toEqual([
      "amount",
      "currency",
      "kind",
      "note",
    ]);
    expect(pipeline.passes).toEqual([
      expect.objectContaining({
        fields: ["date"],
        maxTokens: 24,
        template: IOU_IMAGE_DATE_EXTRACTION_PROMPT,
      }),
    ]);
    expect(pipeline.primaryFields).not.toContain("date");
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
