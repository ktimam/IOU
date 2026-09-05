import { describe, expect, it } from "vitest";
import { MODEL_ACCEPTANCE_CASES } from "./modelAcceptanceCases";
import {
  EXTRACT_BUNDLE,
  buildExtractChat,
  expectedExtractContainer,
  routeExtractCase,
} from "../../../scripts/live/extract-bundle-contract";

describe("test-only Extract bundle contract", () => {
  it("pins the exact immutable text and vision artifacts and their total download", () => {
    expect(EXTRACT_BUNDLE.text.files).toEqual([
      {
        url: "https://huggingface.co/LiquidAI/LFM2-350M-Extract-GGUF/resolve/b8f758b9ff37b0cad9bedfc5223cb71e31aebe9c/LFM2-350M-Extract-Q4_0.gguf",
        sha256: "ba6a76b746a9a13b0830aea67b8aa68f77307d5cca1139abf6dbb96f61408342",
        bytes: 219_307_648,
      },
    ]);
    expect(EXTRACT_BUNDLE.vision.files).toEqual([
      {
        url: "https://huggingface.co/LiquidAI/LFM2.5-VL-450M-Extract-GGUF/resolve/be9e242e7c37db9ddbf9f88d7df939159fdfa186/LFM2.5-VL-450M-Extract-Q4_0.gguf",
        sha256: "e1668972a3fdda59882c2660310661c9b6fa2db603dd1a6d12fe597eeec0f8f0",
        bytes: 219_311_104,
      },
      {
        url: "https://huggingface.co/LiquidAI/LFM2.5-VL-450M-Extract-GGUF/resolve/be9e242e7c37db9ddbf9f88d7df939159fdfa186/mmproj-LFM2.5-VL-450M-Extract-Q8_0.gguf",
        sha256: "5c2610db45990058ce6eacacd5125c28a98d73561b99ea39ff8c22c1fdd5bd45",
        bytes: 102_815_008,
      },
    ]);
    expect(EXTRACT_BUNDLE.sizeBytes).toBe(541_433_760);
    expect(EXTRACT_BUNDLE.license).toBe("LFM Open License v1.0");
  });

  it("routes only the declared deterministic fast path away from an Extract model", () => {
    expect(
      MODEL_ACCEPTANCE_CASES.map((testCase) => [testCase.id, routeExtractCase(testCase)]),
    ).toEqual([
      ["ordinary-text", "text"],
      ["category-date-range-text", "text"],
      ["delimited-multi-entry", "deterministic"],
      ["multi-entry", "text"],
      ["dated-image", "vision"],
      ["portrait-date-image", "vision"],
      ["portrait-date-image-arabic", "vision"],
      ["receipt-photo", "vision"],
      ["category-date-range-image", "vision"],
    ]);
  });

  it("keeps cardinality explicit: single transactions are objects and natural multi is an array", () => {
    expect(
      MODEL_ACCEPTANCE_CASES.map((testCase) => [
        testCase.id,
        expectedExtractContainer(testCase),
      ]),
    ).toEqual([
      ["ordinary-text", "object"],
      ["category-date-range-text", "object"],
      ["delimited-multi-entry", "array"],
      ["multi-entry", "array"],
      ["dated-image", "object"],
      ["portrait-date-image", "object"],
      ["portrait-date-image-arabic", "object"],
      ["receipt-photo", "object"],
      ["category-date-range-image", "object"],
    ]);
  });

  it("builds a schema-first text chat while preserving the exact source as the user turn", () => {
    const testCase = MODEL_ACCEPTANCE_CASES.find((candidate) => candidate.id === "multi-entry")!;
    const chat = buildExtractChat(testCase);

    expect(chat.userPrompt).toBe(testCase.text);
    expect(chat.systemPrompt).toContain("one JSON object for one transaction");
    expect(chat.systemPrompt).toContain("a JSON array for multiple transactions");
    for (const field of ["kind", "amount", "currency", "direction", "date", "note"]) {
      expect(chat.systemPrompt).toContain(`${field}:`);
    }
    expect(chat.systemPrompt).toContain('select from "credit" or "debt"');
    expect(chat.systemPrompt).toContain("Never invent");
  });

  it("builds the vision model's documented YAML-field system prompt without host-date leakage", () => {
    const testCase = MODEL_ACCEPTANCE_CASES.find((candidate) => candidate.id === "dated-image")!;
    const chat = buildExtractChat(testCase);

    expect(chat.userPrompt).toBe("Extract the requested fields from this image.");
    expect(chat.systemPrompt).toContain("Extract the following from the image:");
    expect(chat.systemPrompt).toContain("Respond with only a JSON object");
    expect(chat.systemPrompt).not.toContain("Today is");
    expect(chat.systemPrompt).not.toContain("2026-08-14");
    for (const field of ["kind", "amount", "currency", "direction", "date", "note", "message"]) {
      expect(chat.systemPrompt).toContain(`${field}:`);
    }
  });
});
