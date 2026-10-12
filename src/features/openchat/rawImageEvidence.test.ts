import { describe, expect, it } from "vitest";
import { IOU_MAX_MAJOR_AMOUNT, IOU_MIN_MAJOR_AMOUNT } from "./actionManifest";
import { normalizeRawImageEvidence } from "./rawImageEvidence";

const arrayEvidence = (overrides: Record<string, unknown> = {}) => ({
  heading: "Visible heading", total_text: "$12.50", dates: ["14 Aug 2026"], kind: "iou", ...overrides,
});

describe("unwired exact five-field split-money evidence", () => {
  const shapes = [
    (overrides: Record<string, unknown> = {}) => ({
      heading: "Visible heading", currency_text: "USD", amount_text: "12.50", dates: ["14 Aug 2026"], kind: "iou", ...overrides,
    }),
    (overrides: Record<string, unknown> = {}) => ({
      note: "Visible heading", currency_text: "USD", amount_text: "12.50", date_text: "14 Aug 2026", kind: "iou", ...overrides,
    }),
  ];

  it.each([
    ["EGP", "350.00", 350, "EGP"], ["USD", "1,912.15", 1912.15, "USD"],
    ["$", "1,912.15", 1912.15, "USD"], ["€", "84.70", 84.7, "EUR"],
    ["£", "842.65", 842.65, "GBP"], ["ج.م", "12.50", 12.5, "EGP"], ["", "72.50", 72.5, undefined],
  ])("validates both shapes' complete independent fields: %s / %s", (currency_text, amount_text, amount, currency) => {
    for (const shape of shapes) {
      const raw = shape({ currency_text, amount_text }), before = JSON.stringify(raw);
      expect(normalizeRawImageEvidence(raw)).toEqual({
        amount, ...(currency === undefined ? {} : { currency }), kind: "iou",
        note: "Visible heading", image_heading: "Visible heading", printed_date: "14 Aug 2026", printed_end_date: "",
      });
      expect(JSON.stringify(raw)).toBe(before);
    }
  });

  it.each([
    " ", " USD", "USD ", "USD EUR", "$ USD", "USD/USD", "$$", "dollars", "usd", "ecp", "XYZ",
    "USD\n", "USD\u202e", "U\u0000SD", "\ud800", "X".repeat(17), null, undefined, 1, ["USD"], { currency: "USD" },
  ])("rejects nonliteral, missing or unsafe split currency without defaults: %j", (currency_text) => {
    for (const shape of shapes) expect(normalizeRawImageEvidence(shape({ currency_text }))).toBeUndefined();
  });

  it.each([
    "", " ", "12.50 ", " 12.50", "$12.50", "12.50 USD", "USD12.50", "Total: 12.50", "12.50 and 13.00",
    "0", "0.00", "-1", "+1", ".50", "1.", "1.001", "0.005", "01", "00.50", "1,00", "1,234,56",
    "1.234,56", "1 234.56", "1e3", "Infinity", "NaN", "١٢.٥٠", "１２.５０", "12.50\n", "12.50\u202e",
    "12.50\u2028", "1".repeat(129), null, undefined, 12.5, ["12.50"], { amount: "12.50" },
  ])("never scans or concatenates an invalid amount_text into a valid number: %j", (amount_text) => {
    for (const shape of shapes) expect(normalizeRawImageEvidence(shape({ amount_text }))).toBeUndefined();
  });

  it("shares exact minor-unit bounds with the four-field path, without numeric repair", () => {
    for (const shape of shapes) {
      expect(normalizeRawImageEvidence(shape({ amount_text: "0.01" }))?.amount).toBe(0.01);
      const max = normalizeRawImageEvidence(shape({ amount_text: "90,071,992,547,409.91" }));
      expect(max?.amount).toBe(IOU_MAX_MAJOR_AMOUNT);
      expect(Math.round(max!.amount * 100)).toBe(Number.MAX_SAFE_INTEGER);
      for (const amount_text of ["0.005", "90,071,992,547,409.90", "90,071,992,547,409.92", "90071992547410"])
        expect(normalizeRawImageEvidence(shape({ amount_text }))).toBeUndefined();
    }
  });

  it("retains the original date contracts and emits neither direction nor canonical year", () => {
    const array = normalizeRawImageEvidence(shapes[0]({ dates: ["Sun, Jul 19", "Thu, Aug 6"] }));
    const scalar = normalizeRawImageEvidence(shapes[1]({ date_text: "Sun, Jul 19 | Thu, Aug 6" }));
    expect(array).toEqual(scalar);
    expect(array).toMatchObject({ printed_date: "Sun, Jul 19", printed_end_date: "Thu, Aug 6" });
    for (const key of ["date", "direction", "type", "currency_text", "amount_text", "total_text"])
      expect(array).not.toHaveProperty(key);
    for (const dates of [["14 Aug 2026", "09:47 PM"], ["14 Aug 2026", ""], ["2026-08-10", "2026-08-06"]])
      expect(normalizeRawImageEvidence(shapes[0]({ dates }))).toBeUndefined();
    for (const date_text of ["14 Aug 2026 | ", "14 Aug 2026 | 09:47 PM", "2026-08-10 | 2026-08-06"])
      expect(normalizeRawImageEvidence(shapes[1]({ date_text }))).toBeUndefined();
    expect(normalizeRawImageEvidence(shapes[0]({ heading: "", dates: [], currency_text: "" })))
      .toEqual({ amount: 12.5, kind: "iou" });
    expect(normalizeRawImageEvidence(shapes[1]({ note: "", date_text: "", currency_text: "" })))
      .toEqual({ amount: 12.5, kind: "iou" });
  });

  it("rejects every mixture of split/combined/legacy fields and missing split members", () => {
    for (const shape of shapes) {
      for (const key of ["total_text", "amount", "currency", "printed_date", "direction", "extra"])
        expect(normalizeRawImageEvidence(shape({ [key]: "conflict" }))).toBeUndefined();
      for (const key of Object.keys(shape())) {
        const missing: Record<string, unknown> = shape(); delete missing[key];
        expect(normalizeRawImageEvidence(missing)).toBeUndefined();
      }
    }
    for (const shape of [arrayEvidence, scalarEvidence]) {
      expect(normalizeRawImageEvidence(shape({ amount_text: "12.50" }))).toBeUndefined();
      expect(normalizeRawImageEvidence(shape({ currency_text: "USD" }))).toBeUndefined();
      expect(normalizeRawImageEvidence(shape({ amount_text: "12.50", currency_text: "USD" }))).toBeUndefined();
    }
    expect(normalizeRawImageEvidence(shapes[0]({ date_text: "14 Aug 2026" }))).toBeUndefined();
    expect(normalizeRawImageEvidence(shapes[1]({ heading: "Extra" }))).toBeUndefined();
  });

  it("rejects wrong heading/date pairings even when the split key count is five", () => {
    expect(normalizeRawImageEvidence({ note: "Heading", currency_text: "EGP", amount_text: "350", dates: [], kind: "iou" })).toBeUndefined();
    expect(normalizeRawImageEvidence({ heading: "Heading", currency_text: "EGP", amount_text: "350", date_text: "", kind: "iou" })).toBeUndefined();
  });

  it("preserves safe JSON object ownership and rejects split accessors without calling them", () => {
    let reads = 0;
    for (const shape of shapes) {
      const raw = shape(), safe = Object.freeze(Object.assign(Object.create(null), raw));
      expect(normalizeRawImageEvidence(safe)).toEqual(normalizeRawImageEvidence(raw));
      for (const key of ["currency_text", "amount_text"]) {
        const accessor = Object.defineProperty(shape(), key, { get() { reads++; throw Error("not JSON data"); } });
        const hidden = Object.defineProperty(shape(), key, { enumerable: false });
        expect(normalizeRawImageEvidence(accessor)).toBeUndefined();
        expect(normalizeRawImageEvidence(hidden)).toBeUndefined();
      }
      expect(normalizeRawImageEvidence(Object.assign(shape(), { [Symbol("extra")]: true }))).toBeUndefined();
      expect(normalizeRawImageEvidence(Object.assign(Object.create({ extra: true }), raw))).toBeUndefined();
      expect(normalizeRawImageEvidence({ ...raw, __proto__: { currency_text: "USD" } })).toBeUndefined();
    }
    expect(reads).toBe(0);
  });

  it("requires whole duplicate-rejecting parsing upstream; this adapter does not parse or prove source truth", () => {
    const duplicate = '{"heading":"Visible heading","currency_text":"USD","currency_text":"EUR","amount_text":"12.50","dates":[],"kind":"iou"}';
    expect(normalizeRawImageEvidence(duplicate)).toBeUndefined();
    // JSON.parse has already lost duplicate-key evidence. This deliberate boundary example
    // must not be interpreted as an acceptable alternative to the host's strict whole parser.
    expect(normalizeRawImageEvidence(JSON.parse(duplicate))?.currency).toBe("EUR");
    expect(normalizeRawImageEvidence(shapes[0]({ currency_text: "EUR", heading: "Wrong but well-formed heading" })))
      .toMatchObject({ currency: "EUR", note: "Wrong but well-formed heading" });
  });
});
const scalarEvidence = (overrides: Record<string, unknown> = {}) => ({
  note: "Visible heading", total_text: "$12.50", date_text: "14 Aug 2026", kind: "iou", ...overrides,
});

describe("unwired IOU raw image evidence adapter", () => {
  // These are actual whole-parsed candidate VALUES, not new model executions or pixel truth.
  // First four: qwen-image-v10-production96-Ch1AjX. Last four:
  // broader-four-production96-gemma-PFb3DD. In particular, River's missing currency is
  // preserved as missing, not repaired to the currency visible in the original raster.
  const retained = [
    { raw: { heading: "تمت العملية بنجاح", total_text: "12,900 EGP", dates: ["14 Aug 2026 09:47 PM"], kind: "settlement" },
      amount: 12900, currency: "EGP", heading: "تمت العملية بنجاح", dates: ["14 Aug 2026 09:47 PM", ""] },
    { raw: { heading: "Reservation", total_text: "$1,912.15", dates: ["Sun, Jul 19", "Thu, Aug 6"], kind: "iou" },
      amount: 1912.15, currency: "USD", heading: "Reservation", dates: ["Sun, Jul 19", "Thu, Aug 6"] },
    { raw: { heading: "Your transaction was successful", total_text: "13,500 EGP", dates: ["13 Aug 2026"], kind: "settlement" },
      amount: 13500, currency: "EGP", heading: "Your transaction was successful", dates: ["13 Aug 2026", ""] },
    { raw: { heading: "REPAIR ESTIMATE", total_text: "72.50", dates: [], kind: "iou" },
      amount: 72.5, currency: undefined, heading: "REPAIR ESTIMATE", dates: [] },
    { raw: { note: "RIVER MARKET", total_text: "350.00", date_text: "04 JUL 2026", kind: "iou" },
      amount: 350, currency: undefined, heading: "RIVER MARKET", dates: ["04 JUL 2026", ""] },
    { raw: { note: "Workshop Confirmed", total_text: "1,912.15 USD", date_text: "2026-07-19 | 2026-08-06", kind: "iou" },
      amount: 1912.15, currency: "USD", heading: "Workshop Confirmed", dates: ["2026-07-19", "2026-08-06"] },
    { raw: { note: "PAGO RECIBIDO", total_text: "€84.70", date_text: "2026-09-08", kind: "settlement" },
      amount: 84.7, currency: "EUR", heading: "PAGO RECIBIDO", dates: ["2026-09-08", ""] },
    { raw: { note: "EQUIPMENT HIRE", total_text: "£842.65", date_text: "28 Sep 2026 | 2 Oct 2026", kind: "iou" },
      amount: 842.65, currency: "GBP", heading: "EQUIPMENT HIRE", dates: ["28 Sep 2026", "2 Oct 2026"] },
  ];

  it.each(retained)("converts retained candidate fields without claiming model accuracy: $heading", (row) => {
    const before = JSON.stringify(row.raw);
    expect(normalizeRawImageEvidence(row.raw)).toEqual({
      amount: row.amount, kind: row.raw.kind,
      ...(row.currency === undefined ? {} : { currency: row.currency }),
      note: row.heading, image_heading: row.heading,
      ...(row.dates.length === 0 ? {} : { printed_date: row.dates[0], printed_end_date: row.dates[1] }),
    });
    expect(JSON.stringify(row.raw)).toBe(before);
  });

  it.each([
    ["EGP 350.00", 350, "EGP"], ["  EGP   350.00  ", 350, "EGP"],
    ["1,912.15 USD", 1912.15, "USD"], ["USD1,912.15", 1912.15, "USD"],
    ["€84.70", 84.7, "EUR"], ["84.70€", 84.7, "EUR"], ["ج.م 12.50", 12.5, "EGP"],
    ["E£12.50", 12.5, "EGP"], ["CAD 10", 10, "CAD"], ["0.01", 0.01, undefined],
  ])("parses an entire valid total only: %s", (text, amount, currency) => {
    const result = normalizeRawImageEvidence(arrayEvidence({ total_text: text }));
    expect(result?.amount).toBe(amount);
    expect(result?.currency).toBe(currency);
    if (currency === undefined) expect(result).not.toHaveProperty("currency");
  });

  it.each([
    "", " ", "0", "0.00", "-1", "+1", "(1)", ".50", "1.", "1.001", "0.005",
    "01", "00.10", "1,00", "12,34.50", "1,234,56", "0,123", "1.234,56", "1 234.56",
    "1e3", "Infinity", "NaN", "١٢.٥٠", "１２.５０", "Total: 12.50", "amount 12.50 paid",
    "$12.50 USD", "USD USD 12.50", "USD/EUR 12.50", "$$12.50", "12.50 USD EUR",
    "12.50 and 13.50", "12.50 dollar", "12.50 usd", "12.50 ecp", "12.50 XYZ", "12.50 %",
    "12.50\nUSD", "12.50\tUSD", "12.50\u202eUSD", "12.50\u2028USD", "1".repeat(129),
    "90,071,992,547,409.92", "90071992547410", "999999999999999999999999999999",
  ])("rejects the whole candidate for malformed or unsupported money: %s", (total_text) => {
    expect(normalizeRawImageEvidence(arrayEvidence({ total_text }))).toBeUndefined();
  });

  it("preserves app amount limits and refuses a silent minor-unit rounding change", () => {
    expect(IOU_MIN_MAJOR_AMOUNT).toBe(0.005);
    expect(normalizeRawImageEvidence(arrayEvidence({ total_text: "0.005" }))).toBeUndefined();
    const max = normalizeRawImageEvidence(arrayEvidence({ total_text: "90,071,992,547,409.91" }));
    expect(max?.amount).toBe(IOU_MAX_MAJOR_AMOUNT);
    expect(Math.round(max!.amount * 100)).toBe(Number.MAX_SAFE_INTEGER);
    // This otherwise in-range number cannot round-trip its exact cents through canonical FP64.
    expect(normalizeRawImageEvidence(arrayEvidence({ total_text: "90,071,992,547,409.90" }))).toBeUndefined();
  });

  it.each([
    [], ["Jul 19"], ["Sun, Jul 19", "Thu, Aug 6"], ["Feb 29", "Mar 1"],
    ["2024-02-29"], ["2025-12-29", "2026-01-03"], ["14 آب 2026 09:47 PM"],
  ].map((dates) => ({ dates })))("preserves validated date spelling without inventing a canonical year: $dates", ({ dates }) => {
    const result = normalizeRawImageEvidence(arrayEvidence({ dates }));
    expect(result).toBeDefined();
    expect(result).not.toHaveProperty("date");
    expect(result).not.toHaveProperty("interval_start");
    if (dates.length > 0) {
      expect(result?.printed_date).toBe(dates[0]);
      expect(result?.printed_end_date).toBe(dates[1] ?? "");
    } else expect(result).not.toHaveProperty("printed_date");
  });

  it.each([
    null, undefined, "14 Aug 2026", [""], [" "], ["14 Aug 2026", ""], ["", "15 Aug 2026"],
    ["2026-07-19", "2026-08-06", "2026-08-07"], ["2026-07-19", null], [14],
    ["14 Aug 2026", "09:47 PM"], ["09:47 PM"], ["14 Aug 09:47 PM"],
    ["14 Aug 2026 | 15 Aug 2026"], ["14 Aug 2026 "], [" 14 Aug 2026"],
    ["30 Feb 2026"], ["2026-02-29"], ["Monday, July 19, 2026"], ["13/08/2026"],
    ["2026-08-10", "2026-08-06"], ["Start date", "End date"], ["14 Aug 2026 24:00"],
    ["14 Aug 2026 09:47 PM", "15 Aug 2026"], ["14 Aug 2026\u202e"], ["x".repeat(97)],
  ].map((dates) => ({ dates })))("rejects malformed date evidence without retaining other valid fields: $dates", ({ dates }) => {
    expect(normalizeRawImageEvidence(arrayEvidence({ dates }))).toBeUndefined();
  });

  it.each([
    "14 Aug 2026 | ", " | 15 Aug 2026", "14 Aug 2026 |", "14 Aug 2026|15 Aug 2026",
    "14 Aug 2026  | 15 Aug 2026", "14 Aug 2026 |  15 Aug 2026", "14 Aug 2026 | 09:47 PM",
    "14 Aug 2026 | 15 Aug 2026 | 16 Aug 2026", " ", "14 Aug 2026\n", "x".repeat(196),
  ])("does not repair scalar delimiters, empty ends or date whitespace: %s", (date_text) => {
    expect(normalizeRawImageEvidence(scalarEvidence({ date_text }))).toBeUndefined();
  });

  it("accepts absent scalar evidence but never supplies currency, date, heading, direction or private fields", () => {
    expect(normalizeRawImageEvidence(scalarEvidence({ total_text: "72.50", date_text: "", note: "" })))
      .toEqual({ amount: 72.5, kind: "iou" });
    expect(normalizeRawImageEvidence(arrayEvidence({ heading: "  Heading  ", dates: [] })))
      .toEqual({ amount: 12.5, currency: "USD", kind: "iou", note: "Heading", image_heading: "Heading" });
  });

  it.each([null, undefined, 10, "a\nb", "a\u202eb", "a\ud800b", "a".repeat(201), " ".repeat(801)])(
    "rejects malformed heading evidence as a whole: %j", (heading) => {
      expect(normalizeRawImageEvidence(arrayEvidence({ heading }))).toBeUndefined();
      expect(normalizeRawImageEvidence(scalarEvidence({ note: heading }))).toBeUndefined();
    },
  );

  it.each(["paid", "unpaid", "credit", "debt", "Settlement", "", undefined, null])(
    "does not infer kind or accept undeclared aliases: %j", (kind) => {
      expect(normalizeRawImageEvidence(arrayEvidence({ kind }))).toBeUndefined();
    },
  );

  it("accepts ordinary/null-prototype JSON records without mutating input or inventing fields", () => {
    const ordinary = arrayEvidence();
    const nullPrototype = Object.assign(Object.create(null), ordinary);
    Object.freeze(nullPrototype.dates); Object.freeze(nullPrototype);
    expect(normalizeRawImageEvidence(nullPrototype)).toEqual(normalizeRawImageEvidence(ordinary));
    const result = normalizeRawImageEvidence(ordinary)!;
    for (const key of ["direction", "type", "template_ref", "message", "date", "dates", "total_text", "heading"])
      expect(result).not.toHaveProperty(key);
  });

  it.each(["amount", "currency", "printed_date", "printed_end_date", "interval_start", "date_text", "note", "extra"])(
    "rejects mixed raw/legacy or additional fields: %s", (key) => {
      expect(normalizeRawImageEvidence(arrayEvidence({ [key]: "conflict" }))).toBeUndefined();
    },
  );

  it("rejects missing, inherited, symbolic, nonenumerable and accessor fields without calling getters", () => {
    const missing = arrayEvidence() as Record<string, unknown>; delete missing.kind;
    const inherited = Object.assign(Object.create({ heading: "Inherited" }), { total_text: "1", dates: [], kind: "iou" });
    const hidden = Object.defineProperty(arrayEvidence(), "heading", { enumerable: false });
    const symbolic = Object.assign(arrayEvidence(), { [Symbol("extra")]: 1 });
    let reads = 0;
    const accessor = Object.defineProperty(arrayEvidence(), "heading", { get() { reads++; throw new Error("not data"); } });
    const throwing = new Proxy({}, { getPrototypeOf() { throw new Error("trap"); } });
    for (const value of [missing, inherited, hidden, symbolic, accessor, throwing, null, [], "{}"])
      expect(normalizeRawImageEvidence(value)).toBeUndefined();
    expect(reads).toBe(0);
  });

  it("rejects sparse, decorated or getter-backed date arrays without reading their entries", () => {
    let reads = 0;
    const getter = Object.defineProperty(["14 Aug 2026"], "0", { get() { reads++; return "14 Aug 2026"; } });
    const decorated = Object.assign(["14 Aug 2026"], { extra: true });
    const symbol = Object.assign(["14 Aug 2026"], { [Symbol("extra")]: true });
    for (const dates of [new Array(1), getter, decorated, symbol])
      expect(normalizeRawImageEvidence(arrayEvidence({ dates }))).toBeUndefined();
    expect(reads).toBe(0);
  });

  it("does not correct syntactically valid but source-wrong model claims", () => {
    const result = normalizeRawImageEvidence(arrayEvidence({ heading: "RIVER MARKET SERVICE RECEIPT", total_text: "350.00" }));
    expect(result?.note).toBe("RIVER MARKET SERVICE RECEIPT");
    expect(result).not.toHaveProperty("currency");
    expect(normalizeRawImageEvidence(arrayEvidence({ heading: "Workshop Confirmed", kind: "settlement" }))?.kind)
      .toBe("settlement");
  });
});

describe("opt-in raw image source details", () => {
  const details = {
    direction_text: " You owe ",
    description_text: "  Test stationery  ",
    type_texts: ["TEST ONLY", "  "],
  };

  it("maps only complete app display labels and keeps description and Type evidence separate", () => {
    const raw = { ...arrayEvidence(), ...details };
    const before = JSON.stringify(raw);
    expect(normalizeRawImageEvidence(raw, "strict", "source-v1")).toEqual({
      amount: 12.5,
      currency: "USD",
      kind: "iou",
      printed_date: "14 Aug 2026",
      printed_end_date: "",
      note: "  Test stationery  ",
      image_heading: "Visible heading",
      direction: "debt",
      image_type_texts: ["TEST ONLY", "  "],
    });
    expect(JSON.stringify(raw)).toBe(before);

    expect(
      normalizeRawImageEvidence(
        {
          ...scalarEvidence(),
          ...details,
          direction_text: "oWeD To YoU",
          description_text: "Description",
          type_texts: [],
        },
        "strict",
        "source-v1",
      ),
    ).toMatchObject({
      direction: "credit",
      note: "Description",
      image_heading: "Visible heading",
      image_type_texts: [],
    });

    for (const raw of [
      {
        heading: "Visible heading",
        currency_text: "USD",
        amount_text: "12.50",
        dates: ["14 Aug 2026"],
        kind: "iou",
        ...details,
      },
      {
        note: "Visible heading",
        currency_text: "USD",
        amount_text: "12.50",
        date_text: "14 Aug 2026",
        kind: "iou",
        ...details,
      },
    ]) {
      expect(
        normalizeRawImageEvidence(raw, "strict", "source-v1"),
      ).toMatchObject({
        amount: 12.5,
        currency: "USD",
        direction: "debt",
        note: "  Test stationery  ",
        image_type_texts: ["TEST ONLY", "  "],
      });
    }
  });

  it("treats blank detail strings as absent while preserving the heading fallback", () => {
    expect(
      normalizeRawImageEvidence(
        {
          ...arrayEvidence({ heading: "Heading" }),
          direction_text: "   ",
          description_text: "  ",
          type_texts: [],
        },
        "strict",
        "source-v1",
      ),
    ).toEqual({
      amount: 12.5,
      currency: "USD",
      kind: "iou",
      printed_date: "14 Aug 2026",
      printed_end_date: "",
      note: "Heading",
      image_heading: "Heading",
      image_type_texts: [],
    });
  });

  it("accepts the exact source-detail boundaries without trimming retained text", () => {
    expect(
      normalizeRawImageEvidence(
        {
          ...arrayEvidence(),
          ...details,
          direction_text: `You owe${" ".repeat(57)}`,
          description_text: "d".repeat(800),
        },
        "strict",
        "source-v1",
      ),
    ).toMatchObject({
      direction: "debt",
      note: "d".repeat(800),
    });
    expect(
      normalizeRawImageEvidence(
        {
          ...arrayEvidence(),
          ...details,
          direction_text: `You owe${" ".repeat(58)}`,
        },
        "strict",
        "source-v1",
      ),
    ).toBeUndefined();
  });

  it("keeps legacy shapes exact and requires every source-v1 field", () => {
    expect(
      normalizeRawImageEvidence({ ...arrayEvidence(), ...details }),
    ).toBeUndefined();
    expect(
      normalizeRawImageEvidence(arrayEvidence(), "strict", "source-v1"),
    ).toBeUndefined();
    for (const key of [
      "direction_text",
      "description_text",
      "type_texts",
    ] as const) {
      const partial: Record<string, unknown> = {
        ...arrayEvidence(),
        ...details,
      };
      delete partial[key];
      expect(
        normalizeRawImageEvidence(partial, "strict", "source-v1"),
      ).toBeUndefined();
    }
    expect(
      normalizeRawImageEvidence(
        { ...arrayEvidence(), ...details, extra: true },
        "strict",
        "source-v1",
      ),
    ).toBeUndefined();
    expect(
      normalizeRawImageEvidence(
        { ...arrayEvidence(), ...details },
        "strict",
        "invalid" as "source-v1",
      ),
    ).toBeUndefined();
  });

  it.each([
    "credit",
    "debt",
    "you owe me",
    "Owed to you.",
    "x".repeat(65),
    "You\nowe",
    "You\u202e owe",
    1,
    null,
  ])(
    "rejects unknown, partial or unsafe direction text: %j",
    (direction_text) => {
      expect(
        normalizeRawImageEvidence(
          { ...arrayEvidence(), ...details, direction_text },
          "strict",
          "source-v1",
        ),
      ).toBeUndefined();
    },
  );

  it.each(["line\nbreak", "bidi\u202edescription", "x".repeat(801), null, 1])(
    "rejects malformed description text: %j",
    (description_text) => {
      expect(
        normalizeRawImageEvidence(
          { ...arrayEvidence(), ...details, description_text },
          "strict",
          "source-v1",
        ),
      ).toBeUndefined();
    },
  );

  it("rejects detail accessors and malformed Type arrays without invoking getters", () => {
    let reads = 0;
    for (const key of [
      "direction_text",
      "description_text",
      "type_texts",
    ] as const) {
      const raw = { ...arrayEvidence(), ...details };
      Object.defineProperty(raw, key, {
        get() {
          reads++;
          throw new Error("not data");
        },
      });
      expect(
        normalizeRawImageEvidence(raw, "strict", "source-v1"),
      ).toBeUndefined();
    }
    expect(
      normalizeRawImageEvidence(
        { ...arrayEvidence(), ...details, type_texts: new Array(1) },
        "strict",
        "source-v1",
      ),
    ).toBeUndefined();
    expect(reads).toBe(0);
  });

  describe("dormant labels-v1 contract", () => {
    const labels = { direction_text: " You owe ", type_texts: ["TEST ONLY", "  "] };

    it("preserves the accepted heading note, printed range, direction and separate Type labels", () => {
      const raw = { ...arrayEvidence({ heading: "Reservation", dates: ["Sun, Jul 19", "Thu, Aug 6"] }), ...labels };
      const before = JSON.stringify(raw);
      expect(normalizeRawImageEvidence(raw, "strict", "labels-v1")).toEqual({
        amount: 12.5,
        currency: "USD",
        kind: "iou",
        printed_date: "Sun, Jul 19",
        printed_end_date: "Thu, Aug 6",
        note: "Reservation",
        image_heading: "Reservation",
        direction: "debt",
        image_type_texts: ["TEST ONLY", "  "],
      });
      expect(JSON.stringify(raw)).toBe(before);
    });

    it("is an exact two-field opt-in distinct from legacy and source-v1", () => {
      const complete = { ...arrayEvidence(), ...labels };
      expect(normalizeRawImageEvidence(complete)).toBeUndefined();
      expect(normalizeRawImageEvidence(complete, "strict", "source-v1")).toBeUndefined();
      expect(normalizeRawImageEvidence(arrayEvidence(), "strict", "labels-v1")).toBeUndefined();
      for (const key of ["direction_text", "type_texts"] as const) {
        const partial: Record<string, unknown> = { ...complete };
        delete partial[key];
        expect(normalizeRawImageEvidence(partial, "strict", "labels-v1")).toBeUndefined();
      }
      expect(normalizeRawImageEvidence({ ...complete, description_text: "Not in labels-v1" }, "strict", "labels-v1"))
        .toBeUndefined();
      expect(normalizeRawImageEvidence({ ...complete, extra: true }, "strict", "labels-v1")).toBeUndefined();
    });

    it("allows an explicitly blank direction but rejects unknown or unsafe labels", () => {
      expect(normalizeRawImageEvidence({ ...arrayEvidence(), ...labels, direction_text: "  " }, "strict", "labels-v1"))
        .toEqual({ amount: 12.5, currency: "USD", kind: "iou", printed_date: "14 Aug 2026", printed_end_date: "",
          note: "Visible heading", image_heading: "Visible heading", image_type_texts: ["TEST ONLY", "  "] });
      for (const direction_text of ["credit", "you owe me", "Owed to you.", "You\nowe", null])
        expect(normalizeRawImageEvidence({ ...arrayEvidence(), ...labels, direction_text }, "strict", "labels-v1"))
          .toBeUndefined();
    });

    it("reuses dense-array and own-data-property protections without reading accessors", () => {
      let reads = 0;
      const accessor = Object.defineProperty({ ...arrayEvidence(), ...labels }, "direction_text", {
        get() { reads++; return "You owe"; },
      });
      const itemAccessor = Object.defineProperty(["TEST ONLY"], "0", {
        get() { reads++; return "TEST ONLY"; },
      });
      const safe = Object.assign(Object.create(null), { ...arrayEvidence(), ...labels });
      expect(normalizeRawImageEvidence(safe, "strict", "labels-v1"))
        .toEqual(normalizeRawImageEvidence({ ...arrayEvidence(), ...labels }, "strict", "labels-v1"));
      expect(normalizeRawImageEvidence(Object.assign(Object.create({}), { ...arrayEvidence(), ...labels }), "strict", "labels-v1"))
        .toBeUndefined();
      expect(normalizeRawImageEvidence(accessor, "strict", "labels-v1")).toBeUndefined();
      expect(normalizeRawImageEvidence({ ...arrayEvidence(), ...labels, type_texts: itemAccessor }, "strict", "labels-v1"))
        .toBeUndefined();
      expect(normalizeRawImageEvidence({ ...arrayEvidence(), ...labels, type_texts: new Array(1) }, "strict", "labels-v1"))
        .toBeUndefined();
      expect(reads).toBe(0);
    });
  });
});
