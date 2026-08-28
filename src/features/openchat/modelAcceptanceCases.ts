export type ModelAcceptanceModality = "text" | "image";

export type ModelAcceptanceExpectedEntry = Readonly<{
  kind: "iou" | "settlement";
  amount: number;
  currency: string;
  direction: "credit" | "debt";
  date?: string;
  noteIncludes: readonly string[];
  /** Every alphanumeric note token must be source-grounded in this allowlist. */
  noteAllowedWords: readonly string[];
}>;

export type ModelAcceptanceCase = Readonly<{
  id:
    | "ordinary-text"
    | "reservation-date-type"
    | "delimited-multi-entry"
    | "multi-entry"
    | "dated-image"
    | "receipt-photo";
  modality: ModelAcceptanceModality;
  text?: string;
  /** Fixed privacy-safe raster fixture. Path is repository-relative and its bytes are SHA-pinned. */
  imageFixture?: Readonly<{
    path: string;
    sha256: string;
    bytes: number;
    width: number;
    height: number;
  }>;
  /** Optional wall-clock anchor used only while runAiAction builds its prompt. */
  promptNowIso?: string;
  expected: readonly ModelAcceptanceExpectedEntry[];
  /** Exact production-inference count. Deterministic source fast paths must stay model-free. */
  expectedInferCalls: 0 | 1 | 2;
  /** Maximum warm end-to-end runAiAction duration on the qualification workstation. */
  warmLatencyMs: number;
}>;

export type ModelAcceptanceObservation = {
  resultKind: string;
  extracted: Record<string, unknown>[];
  cardRows: { label: string; value: string }[];
  confirmPayload: unknown;
  inferCalls: number;
  actionMs: number;
};

export type ModelAcceptanceScore = Readonly<{
  pass: boolean;
  reasons: string[];
}>;

/**
 * End-to-end qualification inputs for both deterministic source handling and real model inference.
 * `delimited-multi-entry` pins the bounded fast path; `multi-entry` is deliberately outside every
 * declared source parser so a listed model must also demonstrate natural-language cardinality.
 */
export const MODEL_ACCEPTANCE_CASES: readonly ModelAcceptanceCase[] = [
  {
    id: "ordinary-text",
    modality: "text",
    text: "You owe me 425 EGP for groceries.",
    expected: [
      {
        kind: "iou",
        amount: 425,
        currency: "EGP",
        direction: "credit",
        noteIncludes: ["groceries"],
        noteAllowedWords: ["groceries", "grocery"],
      },
    ],
    expectedInferCalls: 1,
    warmLatencyMs: 25_000,
  },
  {
    id: "reservation-date-type",
    modality: "text",
    text: "reservation 3-8 august 7777 gbp",
    // Freeze only the prompt's `Today is ...` context so this exact user regression remains stable.
    promptNowIso: "2026-08-14T12:00:00+03:00",
    expected: [
      {
        kind: "iou",
        amount: 7777,
        currency: "GBP",
        direction: "debt",
        date: "2026-08-03",
        noteIncludes: ["reservation"],
        noteAllowedWords: ["reservation", "3", "8", "august", "7777", "gbp"],
      },
    ],
    expectedInferCalls: 1,
    warmLatencyMs: 25_000,
  },
  {
    id: "delimited-multi-entry",
    modality: "text",
    text: "Outstanding items owed to you: taxi 310 EGP; lunch 145 EGP; tickets 620 EGP.",
    expected: [
      {
        kind: "iou",
        amount: 310,
        currency: "EGP",
        direction: "credit",
        noteIncludes: ["taxi"],
        noteAllowedWords: ["taxi"],
      },
      {
        kind: "iou",
        amount: 145,
        currency: "EGP",
        direction: "credit",
        noteIncludes: ["lunch"],
        noteAllowedWords: ["lunch"],
      },
      {
        kind: "iou",
        amount: 620,
        currency: "EGP",
        direction: "credit",
        noteIncludes: ["tickets"],
        noteAllowedWords: ["tickets"],
      },
    ],
    expectedInferCalls: 0,
    warmLatencyMs: 500,
  },
  {
    id: "multi-entry",
    modality: "text",
    text: "You owe me 310 EGP for taxi. You also owe me 145 EGP for lunch. You also owe me 620 EGP for tickets.",
    expected: [
      {
        kind: "iou",
        amount: 310,
        currency: "EGP",
        direction: "credit",
        noteIncludes: ["taxi"],
        noteAllowedWords: ["taxi"],
      },
      {
        kind: "iou",
        amount: 145,
        currency: "EGP",
        direction: "credit",
        noteIncludes: ["lunch"],
        noteAllowedWords: ["lunch"],
      },
      {
        kind: "iou",
        amount: 620,
        currency: "EGP",
        direction: "credit",
        noteIncludes: ["tickets"],
        noteAllowedWords: ["tickets"],
      },
    ],
    expectedInferCalls: 1,
    warmLatencyMs: 35_000,
  },
  {
    id: "dated-image",
    modality: "image",
    imageFixture: {
      path: "test/fixtures/openchat/model-acceptance/iou-request-date.png",
      sha256:
        "0b2b3aa6092361abf14e58eed8429ec0e6ebdc7cd342b9fc79d91ed2ce78b449",
      bytes: 33_204,
      width: 900,
      height: 700,
    },
    expected: [
      {
        kind: "iou",
        amount: 350,
        currency: "EGP",
        direction: "credit",
        date: "2026-07-04",
        noteIncludes: ["cleaning"],
        // Some capable vision models preserve the adjacent visible relationship phrase in the
        // note. That is redundant, but it is source-grounded rather than invented; direction is
        // still scored independently and must be exactly `credit`.
        noteAllowedWords: ["cleaning", "fee", "owed", "to", "you"],
      },
    ],
    // Production image extraction is model-only but split into disjoint core + focused-date passes.
    expectedInferCalls: 2,
    warmLatencyMs: 45_000,
  },
  {
    id: "receipt-photo",
    modality: "image",
    imageFixture: {
      path: "test/fixtures/openchat/model-acceptance/receipt-photo.png",
      sha256:
        "dd473ba928f5f4ab015b7803b65825dec5ccfd4941a544b6d66fbc0a78e3c479",
      bytes: 156_669,
      width: 1_200,
      height: 900,
    },
    expected: [
      {
        kind: "iou",
        amount: 350,
        currency: "EGP",
        direction: "credit",
        date: "2026-07-04",
        noteIncludes: ["cleaning"],
        noteAllowedWords: ["cleaning", "service"],
      },
    ],
    expectedInferCalls: 2,
    warmLatencyMs: 45_000,
  },
] as const;

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizedText(value: unknown): string {
  return typeof value === "string"
    ? value.trim().toLocaleLowerCase("en-US")
    : "";
}

function wordTokens(value: string): string[] {
  return value.match(/[\p{L}\p{N}]+/gu) ?? [];
}

function expectedResultKind(
  testCase: ModelAcceptanceCase,
): "ready" | "ready_multi" {
  return testCase.expected.length === 1 ? "ready" : "ready_multi";
}

function scoreCardRows(
  testCase: ModelAcceptanceCase,
  observation: ModelAcceptanceObservation,
  reasons: string[],
): void {
  if (testCase.expected.length === 1) {
    const expected = testCase.expected[0];
    const rows = new Map(
      observation.cardRows.map((row) => [row.label, row.value]),
    );
    const exactRows: [string, string | undefined][] = [
      ["Amount", String(expected.amount)],
      ["Currency", expected.currency],
      ["Type", expected.kind],
      ["Direction", expected.direction],
      ["Date", expected.date],
    ];
    for (const [label, value] of exactRows) {
      const actual = rows.get(label);
      if (value === undefined ? actual !== undefined : actual !== value) {
        reasons.push(
          `card row ${label} expected ${value ?? "absent"}, observed ${actual ?? "absent"}`,
        );
      }
    }
    const note = normalizedText(rows.get("Note"));
    if (
      !expected.noteIncludes.every((part) =>
        note.includes(part.toLocaleLowerCase("en-US")),
      )
    ) {
      reasons.push(
        `card row Note did not contain ${expected.noteIncludes.join(", ")}`,
      );
    }
    return;
  }

  if (observation.cardRows.length !== testCase.expected.length) {
    reasons.push(
      `multi-entry card expected ${testCase.expected.length} rows, observed ${observation.cardRows.length}`,
    );
    return;
  }
  for (let index = 0; index < testCase.expected.length; index += 1) {
    const row = observation.cardRows[index];
    const expected = testCase.expected[index];
    const value = normalizedText(row?.value);
    if (row?.label !== `Entry ${index + 1}`) {
      reasons.push(
        `multi-entry card row ${index + 1} had label ${row?.label ?? "absent"}`,
      );
    }
    for (const part of [
      String(expected.amount),
      expected.currency,
      expected.kind,
      expected.direction,
      ...expected.noteIncludes,
    ]) {
      if (!value.includes(part.toLocaleLowerCase("en-US"))) {
        reasons.push(`multi-entry card row ${index + 1} omitted ${part}`);
      }
    }
  }
}

export function scoreModelAcceptanceCase(
  testCase: ModelAcceptanceCase,
  observation: ModelAcceptanceObservation,
  options: Readonly<{ enforceLatency?: boolean }> = {},
): ModelAcceptanceScore {
  const reasons: string[] = [];
  const wantedKind = expectedResultKind(testCase);
  if (observation.resultKind !== wantedKind) {
    reasons.push(`expected ${wantedKind}, observed ${observation.resultKind}`);
  }
  if (observation.inferCalls !== testCase.expectedInferCalls) {
    reasons.push(
      `expected ${testCase.expectedInferCalls} inference call${testCase.expectedInferCalls === 1 ? "" : "s"}, observed ${observation.inferCalls}`,
    );
  }
  if (observation.extracted.length !== testCase.expected.length) {
    reasons.push(
      `expected ${testCase.expected.length} extracted entry, observed ${observation.extracted.length}`,
    );
  }

  const count = Math.min(
    observation.extracted.length,
    testCase.expected.length,
  );
  for (let index = 0; index < count; index += 1) {
    const actual = observation.extracted[index];
    const expected = testCase.expected[index];
    for (const key of ["kind", "amount", "currency", "direction"] as const) {
      if (actual[key] !== expected[key]) {
        reasons.push(
          `entry ${index + 1} ${key} expected ${String(expected[key])}, observed ${String(actual[key])}`,
        );
      }
    }
    if (expected.date === undefined) {
      if (actual.date !== undefined) {
        reasons.push(`entry ${index + 1} invented date ${String(actual.date)}`);
      }
    } else if (actual.date !== expected.date) {
      reasons.push(
        `entry ${index + 1} date expected ${expected.date}, observed ${String(actual.date)}`,
      );
    }
    const note = normalizedText(actual.note);
    if (
      !expected.noteIncludes.every((part) =>
        note.includes(part.toLocaleLowerCase("en-US")),
      )
    ) {
      reasons.push(
        `entry ${index + 1} note did not contain ${expected.noteIncludes.join(", ")}`,
      );
    }
    const allowedWords = new Set(
      expected.noteAllowedWords.map((word) => word.toLocaleLowerCase("en-US")),
    );
    const inventedNoteWords = wordTokens(note).filter(
      (word) => !allowedWords.has(word),
    );
    if (inventedNoteWords.length > 0) {
      reasons.push(
        `entry ${index + 1} note invented ${[...new Set(inventedNoteWords)].join(", ")}`,
      );
    }
    if (testCase.modality === "text") {
      if (actual.message !== testCase.text) {
        reasons.push(
          `entry ${index + 1} did not preserve the exact source message`,
        );
      }
    } else if (actual.message !== undefined) {
      reasons.push(
        `entry ${index + 1} invented a message for image-only input`,
      );
    }
  }

  if (
    observation.resultKind === "ready" ||
    observation.resultKind === "ready_multi"
  ) {
    const expectedPayload =
      observation.resultKind === "ready_multi"
        ? observation.extracted
        : observation.extracted[0];
    if (!sameJson(observation.confirmPayload, expectedPayload)) {
      reasons.push("confirm payload does not match the extracted result");
    }
  }
  scoreCardRows(testCase, observation, reasons);

  if (
    options.enforceLatency !== false &&
    observation.actionMs > testCase.warmLatencyMs
  ) {
    reasons.push(
      `warm action took ${Math.round(observation.actionMs)} ms (limit ${testCase.warmLatencyMs} ms)`,
    );
  }
  return { pass: reasons.length === 0, reasons };
}
