import type { ModelAcceptanceCase } from "../../src/features/openchat/modelAcceptanceCases";

export type ExtractArtifact = Readonly<{
  url: string;
  sha256: string;
  bytes: number;
}>;

export type ExtractModel = Readonly<{
  id: string;
  name: string;
  description: string;
  modalities: readonly ("text" | "image")[];
  runtime: "llama-cpp";
  files: readonly ExtractArtifact[];
  sizeBytes: number;
  license: "LFM Open License v1.0";
  licenseUrl: "https://www.liquid.ai/lfm-license";
}>;

const TEXT_EXTRACT: ExtractModel = {
  id: "lfm2-350m-extract-q4-acceptance-only",
  name: "LFM2 350M Extract Q4_0 (acceptance only)",
  description: "Test-only schema extraction model for text inputs.",
  modalities: ["text"],
  runtime: "llama-cpp",
  files: [
    {
      url: "https://huggingface.co/LiquidAI/LFM2-350M-Extract-GGUF/resolve/b8f758b9ff37b0cad9bedfc5223cb71e31aebe9c/LFM2-350M-Extract-Q4_0.gguf",
      sha256: "ba6a76b746a9a13b0830aea67b8aa68f77307d5cca1139abf6dbb96f61408342",
      bytes: 219_307_648,
    },
  ],
  sizeBytes: 219_307_648,
  license: "LFM Open License v1.0",
  licenseUrl: "https://www.liquid.ai/lfm-license",
};

const VISION_EXTRACT: ExtractModel = {
  id: "lfm2.5-vl-450m-extract-q4-acceptance-only",
  name: "LFM2.5-VL 450M Extract Q4_0 (acceptance only)",
  description: "Test-only schema extraction model for single-image inputs.",
  modalities: ["text", "image"],
  runtime: "llama-cpp",
  files: [
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
  ],
  sizeBytes: 322_126_112,
  license: "LFM Open License v1.0",
  licenseUrl: "https://www.liquid.ai/lfm-license",
};

export const EXTRACT_BUNDLE = {
  id: "lfm-extract-text-vision-bundle-acceptance-only",
  text: TEXT_EXTRACT,
  vision: VISION_EXTRACT,
  sizeBytes: TEXT_EXTRACT.sizeBytes + VISION_EXTRACT.sizeBytes,
  license: "LFM Open License v1.0" as const,
  licenseUrl: "https://www.liquid.ai/lfm-license" as const,
};

export type ExtractRoute = "deterministic" | "text" | "vision";

export function routeExtractCase(testCase: ModelAcceptanceCase): ExtractRoute {
  if (testCase.expectedInferCalls === 0) return "deterministic";
  return testCase.modality === "image" ? "vision" : "text";
}

export function expectedExtractContainer(testCase: ModelAcceptanceCase): "object" | "array" {
  return testCase.expected.length === 1 ? "object" : "array";
}

function schemaLines(includeImageEvidence: boolean): string {
  return [
    'kind: Transaction type; select from "iou" for an unpaid or future obligation or "settlement" only when money already moved.',
    "amount: Transaction amount in major currency units as a JSON number, never a string.",
    "currency: Three-letter ISO currency code supported by the source.",
    'direction: Relationship from the sender viewpoint; select from "credit" or "debt". "Owed to you", "you owe me", or "owe me" is credit. "I owe you", "we owe", or bare sender shorthand is debt.',
    "date: Source transaction or due date in YYYY-MM-DD. For a range use its start. Omit when absent.",
    "note: Short purpose copied only from source words; exclude status, amount, currency, date, time, reference, receipt instructions, and schema words.",
    ...(includeImageEvidence
      ? [
          'message: If an exact visible relationship phrase determines direction, copy only that phrase; otherwise omit this field.',
        ]
      : []),
  ].join("\n");
}

function textSystemPrompt(testCase: ModelAcceptanceCase): string {
  const anchor =
    testCase.promptNowIso === undefined
      ? ""
      : `\nReference date for resolving a source date with no year: ${testCase.promptNowIso.slice(0, 10)}. Use it only to infer the missing year; never return the reference date itself.`;
  return `Extract every distinct money transaction from the user's text.

Return only strict JSON and no prose or markdown. Return one JSON object for one transaction, and a JSON array for multiple transactions in source order. Never merge, duplicate, or omit a distinct transaction.

Use this field schema:
${schemaLines(false)}

When a source describes requested, scheduled, due, or unpaid money without an explicit relationship phrase, use kind "iou" and direction "debt".${anchor}

Include only source-supported fields. Never invent a value or copy field descriptions into values. Use greedy deterministic extraction.`;
}

function visionSystemPrompt(): string {
  return `Extract the following from the image:

${schemaLines(true)}

Respond with only a JSON object. Do not include any text outside the JSON. The image contains one ledger transaction: do not emit an array or split line items, subtotal, total, time, reference, or repeated displays into extra transactions. Include only image-supported fields. Never invent a value. Use greedy deterministic extraction.`;
}

export type ExtractChat = Readonly<{
  systemPrompt: string;
  userPrompt: string;
}>;

export function buildExtractChat(testCase: ModelAcceptanceCase): ExtractChat {
  if (testCase.modality === "image") {
    return {
      systemPrompt: visionSystemPrompt(),
      userPrompt: "Extract the requested fields from this image.",
    };
  }
  if (testCase.text === undefined) throw new Error(`${testCase.id} has no text source`);
  return { systemPrompt: textSystemPrompt(testCase), userPrompt: testCase.text };
}
