import { describe, expect, it, vi } from "vitest";
import * as cardBridge from "./cardBridge";
import {
  checkPackagedResponse,
  DEFAULT_PACKAGED_EXPECTATION,
  parsePackagedExpectation,
  safePackagedExpectation,
} from "../../../scripts/live/packagedTransformersAcceptance";
import fixture from "./fixtures/packaged-worker-date-range-expectation.json";
import printedSingleFixture from "./fixtures/packaged-worker-printed-single-date-expectation.json";
import printedRangeFixture from "./fixtures/packaged-worker-printed-range-expectation.json";
import literalCurrencyFixture from "./fixtures/packaged-worker-literal-currency-range-expectation.json";

const expectation = parsePackagedExpectation(fixture);
const raw = {
  amount: 1912.15,
  kind: "iou",
  interval_start: "Sun, Jul 19",
  interval_end: "Thu, Aug 6",
  note: "Reservation",
};

describe("packaged-worker image acceptance checks (no model or device)", () => {
  it("distinguishes the printed token from the user-approved app mapping at both card boundaries", () => {
    const expected = parsePackagedExpectation(literalCurrencyFixture);
    const completion = Object.fromEntries(Object.entries(expected.raw).filter(([, value]) => value !== null));
    const result = checkPackagedResponse(JSON.stringify(completion), expected);
    expect(result.exact).toBe(true);
    expect(result.observed.currency).toBe("$");
    expect(result.projected.currency).toBe("USD");
    expect(result.projected.confirmedCurrency).toBe("USD");
    expect(safePackagedExpectation(expected)).toMatchObject({ raw: { currency: "$" },
      card: { currency: "USD" }, confirmed: { currency: "USD" } });
    for (const currency of ["USD", "CAD", undefined, null, "$$", " $ "]) {
      expect(checkPackagedResponse(JSON.stringify({ ...completion, currency }), expected).exact).toBe(false);
    }
  });

  it.each(["card", "confirmed"] as const)("rejects currency corruption after symbol normalization at %s", (stage) => {
    const expected = parsePackagedExpectation(literalCurrencyFixture);
    const completion = Object.fromEntries(Object.entries(expected.raw).filter(([, value]) => value !== null));
    expect(checkPackagedResponse(JSON.stringify(completion), expected).exact).toBe(true);
    const originalCard = cardBridge.initToFormState;
    const originalConfirm = cardBridge.buildConfirmPayload;
    const spy = stage === "card"
      ? vi.spyOn(cardBridge, "initToFormState").mockImplementation((...args) => ({ ...originalCard(...args), currency: "CAD" }))
      : vi.spyOn(cardBridge, "buildConfirmPayload").mockImplementation((...args) => ({ ...originalConfirm(...args), currency: "CAD" }));
    try {
      const result = checkPackagedResponse(JSON.stringify(completion), expected);
      expect(result.observed.currency).toBe("$");
      expect(result.currencyAccepted).toBe(false);
      expect(result.exact).toBe(false);
    } finally { spy.mockRestore(); }
  });

  it.each([
    { ...literalCurrencyFixture, card: { date: "2026-07-19" } },
    { ...literalCurrencyFixture, confirmed: { date: "2026-07-19" } },
    { ...literalCurrencyFixture, raw: { amount: 1912.15 } },
    { ...literalCurrencyFixture, raw: { ...literalCurrencyFixture.raw, currency: "x".repeat(17) } },
    { ...literalCurrencyFixture, raw: { ...literalCurrencyFixture.raw, currency: "$\n" } },
    { ...literalCurrencyFixture, card: { ...literalCurrencyFixture.card, currency: "$" } },
  ])("rejects incomplete or invalid literal-to-canonical expectation metadata", (value) => {
    expect(() => parsePackagedExpectation(value)).toThrow("invalid expectation");
  });

  it.each([printedSingleFixture, printedRangeFixture])("checks the complete printed-pair contract through real IOU projection", (value) => {
    const expected = parsePackagedExpectation(value);
    // null entries in expectations constrain absent fields; they are not generated evidence.
    const completion = Object.fromEntries(Object.entries(expected.raw).filter(([, value]) => value !== null));
    const result = checkPackagedResponse(JSON.stringify(completion), expected);
    expect(result.exact).toBe(true);
    expect(result.projected.amount).toBe(expected.raw.amount);
    expect(result.projected.date).toBe(expected.card.date);
    expect(result.projected.confirmedDate).toBe(expected.confirmed.date);
    expect(result.projected.noteMatches).toBe(true);
    expect(result.projected.confirmedNoteMatches).toBe(true);
  });

  it.each([undefined, null, { date: "14 Aug 2026" }, " ", "not a date"])(
    "never accepts a missing or malformed explicit empty single-date end: %s", (printedEnd) => {
      const expected = parsePackagedExpectation(printedSingleFixture);
      const rawValue = { ...expected.raw, printed_end_date: printedEnd };
      expect(checkPackagedResponse(JSON.stringify(rawValue), expected).exact).toBe(false);
    },
  );

  it("does not let unrequested printed evidence silently pass a legacy expectation", () => {
    const result = checkPackagedResponse(JSON.stringify({ ...raw,
      printed_date: "Sun, Jul 19", printed_end_date: "Thu, Aug 6" }), expectation);
    expect(result.exact).toBe(false);
  });

  it.each([
    { ...printedSingleFixture, raw: { ...printedSingleFixture.raw, printed_end_date: null } },
    { ...printedSingleFixture, raw: { ...printedSingleFixture.raw, printed_end_date: undefined } },
    { ...printedSingleFixture, raw: { ...printedSingleFixture.raw, printed_date: "" } },
    { ...printedSingleFixture, raw: { ...printedSingleFixture.raw, printed_date: "x".repeat(97) } },
  ])("rejects incomplete or unbounded printed expectation metadata", (value) => {
    expect(() => parsePackagedExpectation(value)).toThrow("invalid expectation");
  });

  it("keeps the default receipt gate compatible", () => {
    const result = checkPackagedResponse(JSON.stringify(DEFAULT_PACKAGED_EXPECTATION.raw), DEFAULT_PACKAGED_EXPECTATION);
    expect(result.exact).toBe(true);
    expect(result.projected.confirmedDate).toBe("2026-08-14");
  });

  it("checks raw endpoints and real IOU normalization, card, and confirmation", () => {
    const result = checkPackagedResponse(JSON.stringify(raw), expectation);
    expect(result.exact).toBe(true);
    expect(result.observed).toMatchObject({
      amount: 1912.15, interval_start: "Sun, Jul 19", interval_end: "Thu, Aug 6",
      date: null, noteMatches: true,
    });
    expect(result.projected).toEqual({
      amount: 1912.15, currency: null, kind: "iou", date: "2026-07-19", noteMatches: true,
      confirmedAmount: 1912.15, confirmedCurrency: null, confirmedKind: "iou", confirmedDate: "2026-07-19",
      confirmedNoteMatches: true, notePreservedInConfirmation: true,
    });
    expect(JSON.stringify(result)).not.toContain("Reservation");
  });

  it("rejects the malformed object wrapper captured from phone Propose on 2026-09-05", () => {
    // Actual phone output had invalid JSON and guessed USD; never count parser repair as
    // a successful model response or let complete inner fields bypass whole-response validation.
    const captured = '{"{"amount":1912.15,"interval_start":"Sun, Jul 19","interval_end":"Thu, Aug 6","note":"Reservation","kind":"iou","currency":"USD"}}';
    const result = checkPackagedResponse(captured, expectation);
    expect(result.exact).toBe(false);
    expect(result.completeJsonObject).toBe(false);
    expect(result.invalidOrTruncatedOutput).toBe(true);
    expect(result.observed.amount).toBeNull();
  });

  it("does not qualify captured guessed USD even when JSON and the range/date/type/note are correct", () => {
    const valid = '{"amount":1912.15,"interval_start":"Sun, Jul 19","interval_end":"Thu, Aug 6","note":"Reservation","kind":"iou","currency":"USD"}';
    const result = checkPackagedResponse(valid, expectation);
    expect(result.exact).toBe(false);
    expect(result.dateTypeNoteAccepted).toBe(true);
    expect(result.currencyAccepted).toBe(false);
    expect(result.completeJsonObject).toBe(true);
    expect(result.invalidOrTruncatedOutput).toBe(false);
    expect(result.observed).toMatchObject({ amount: 1912.15, currency: "USD", noteMatches: true });
    expect(result.projected).toMatchObject({ date: "2026-07-19", confirmedDate: "2026-07-19",
      currency: "USD", confirmedCurrency: "USD", noteMatches: true, confirmedNoteMatches: true });
  });

  it.each([fixture, printedRangeFixture])("requires a symbol-only source to omit ISO currency without weakening other fields", (value) => {
    const expected = parsePackagedExpectation(value);
    const completion = Object.fromEntries(Object.entries(expected.raw).filter(([, value]) => value !== null));
    expect(expected.raw.currency).toBeNull();
    const valid = checkPackagedResponse(JSON.stringify(completion), expected);
    expect(valid.exact).toBe(true);
    expect(valid.currencyAccepted).toBe(true);
    expect(checkPackagedResponse(JSON.stringify({ ...completion, currency: null }), expected).exact).toBe(true);
    for (const currency of ["USD", "CAD", "AUD", "invalid", "", "$", 0]) {
      const guessed = checkPackagedResponse(JSON.stringify({ ...completion, currency }), expected);
      expect(guessed.exact).toBe(false);
      expect(guessed.currencyAccepted).toBe(false);
    }
    for (const incorrect of [{ amount: 191215 }, { kind: "settlement" }, { note: "Total Total coming" }]) {
      expect(checkPackagedResponse(JSON.stringify({ ...completion, ...incorrect }), expected).exact).toBe(false);
    }
  });

  it("accepts an explicitly evidenced ISO code in a separately labeled synthetic source expectation", () => {
    // This is a distinct synthetic source whose printed currency is known, not the real dollar-only image.
    const synthetic = parsePackagedExpectation({ ...fixture, raw: { ...fixture.raw, currency: "USD" } });
    const result = checkPackagedResponse(JSON.stringify({ ...raw, currency: "USD" }), synthetic);
    expect(result.exact).toBe(true);
    expect(result.currencyAccepted).toBe(true);
  });

  it("rejects the reported labels-as-endpoints instead of treating missing date as success", () => {
    const result = checkPackagedResponse(JSON.stringify({
      ...raw, interval_start: "Reservation", interval_end: "Total Payout",
    }), expectation);
    expect(result.exact).toBe(false);
    expect(result.projected.date).toBeNull();
    expect(result.projected.noteMatches).toBe(false);
  });

  it("checks categories generically without a fixed title", () => {
    const alternative = parsePackagedExpectation({
      ...fixture, raw: { ...fixture.raw, note: "Equipment calibration" },
      card: { date: "2026-07-19", note: "Equipment calibration | From Sun, Jul 19 to Thu, Aug 6" },
      confirmed: { date: "2026-07-19", note: "Equipment calibration | From Sun, Jul 19 to Thu, Aug 6" },
    });
    expect(checkPackagedResponse(JSON.stringify({ ...raw, note: "Equipment calibration" }), alternative).exact).toBe(true);
  });

  it.each([
    JSON.stringify(raw).slice(0, -1),
    `${JSON.stringify(raw)} {"date":"2026-07`,
    `{"first":${JSON.stringify(raw)},"truncated":`,
    `[${JSON.stringify(raw)}]`,
    `Answer: ${JSON.stringify(raw)}`,
    `\`\`\`json\n${JSON.stringify(raw)}\n\`\`\``,
  ])("does not salvage a complete object prefix or nested object from %s", (text) => {
    const result = checkPackagedResponse(text, expectation);
    expect(result.exact).toBe(false);
    expect(result.completeJsonObject).toBe(false);
    expect(result.invalidOrTruncatedOutput).toBe(true);
  });

  it("does not excuse invalid or invented fields as omitted values", () => {
    expect(checkPackagedResponse(JSON.stringify({ ...raw, date: "invented" }), expectation).exact).toBe(false);
    expect(checkPackagedResponse(JSON.stringify({ ...raw, amount: "1912.15 more" }), expectation).exact).toBe(false);
    expect(checkPackagedResponse(JSON.stringify({ ...raw, amount: 19121.5 }), expectation).exact).toBe(false);
    expect(checkPackagedResponse(JSON.stringify({ ...raw, note: "Total Total coming" }), expectation).exact).toBe(false);
  });

  it.each([
    '"amount":999,',
    '"note":"Invented text",',
    '"interval_start":"Aug 7",',
    '"\\u0061mount":999,',
  ])("rejects conflicting duplicate keys even when the last value is correct: %s", (prefix) => {
    const text = `{${prefix}${JSON.stringify(raw).slice(1)}`;
    // Demonstrate the old false green: ordinary JSON.parse silently discards the wrong first value.
    expect(JSON.parse(text)).toEqual(raw);
    const result = checkPackagedResponse(text, expectation);
    expect(result.exact).toBe(false);
    expect(result.completeJsonObject).toBe(false);
  });

  it("rejects a duplicate date whose last null hides an invented date", () => {
    const text = `{\"date\":\"2026-08-07\",\"date\":null,${JSON.stringify(raw).slice(1)}`;
    expect(JSON.parse(text).date).toBeNull();
    expect(checkPackagedResponse(text, expectation).exact).toBe(false);
  });

  it("does not confuse escaped quotes or colon characters in note text with object keys", () => {
    const title = 'A "label": with {braces}';
    const note = `${title} | From Sun, Jul 19 to Thu, Aug 6`;
    const wanted = parsePackagedExpectation({
      ...fixture, raw: { ...fixture.raw, note: title },
      card: { ...fixture.card, note }, confirmed: { ...fixture.confirmed, note },
    });
    expect(checkPackagedResponse(JSON.stringify({ ...raw, note: title }), wanted).exact).toBe(true);
  });

  it("rejects amount corruption during card projection even when raw extraction matches", () => {
    const original = cardBridge.initToFormState;
    const spy = vi.spyOn(cardBridge, "initToFormState").mockImplementation((...args) => ({
      ...original(...args), amount: "19121.5",
    }));
    try {
      const result = checkPackagedResponse(JSON.stringify(raw), expectation);
      expect(result.observed.amount).toBe(1912.15);
      expect(result.projected.amount).toBe(19121.5);
      expect(result.exact).toBe(false);
    } finally { spy.mockRestore(); }
  });

  it.each([
    { currency: "USD" },
    { kind: "settlement" as const },
  ])("rejects currency/type corruption during card projection: %s", (incorrect) => {
    const original = cardBridge.initToFormState;
    const spy = vi.spyOn(cardBridge, "initToFormState").mockImplementation((...args) => ({
      ...original(...args), ...incorrect,
    }));
    try {
      const result = checkPackagedResponse(JSON.stringify(raw), expectation);
      expect(result.exact).toBe(false);
    } finally { spy.mockRestore(); }
  });

  it.each([
    { currency: "USD" },
    { kind: "settlement" as const },
    { kind: undefined },
  ])("rejects currency/type corruption during confirmation: %s", (incorrect) => {
    const original = cardBridge.buildConfirmPayload;
    const spy = vi.spyOn(cardBridge, "buildConfirmPayload").mockImplementation((...args) => ({
      ...original(...args), ...incorrect,
    }));
    try {
      const result = checkPackagedResponse(JSON.stringify(raw), expectation);
      expect(result.exact).toBe(false);
    } finally { spy.mockRestore(); }
  });

  it.each([19121.5, undefined, "1912.15"])("rejects a corrupted/missing/non-numeric confirmation amount: %s", (amount) => {
    const original = cardBridge.buildConfirmPayload;
    const spy = vi.spyOn(cardBridge, "buildConfirmPayload").mockImplementation((...args) => ({
      ...original(...args), amount,
    }));
    try {
      const result = checkPackagedResponse(JSON.stringify(raw), expectation);
      expect(result.observed.amount).toBe(1912.15);
      expect(result.projected.amount).toBe(1912.15);
      expect(result.exact).toBe(false);
    } finally { spy.mockRestore(); }
  });

  it("keeps note text and paths out of report expectations", () => {
    const serialized = JSON.stringify(safePackagedExpectation(expectation));
    expect(serialized).not.toContain("Reservation");
    expect(serialized).not.toContain("From");
    expect(serialized).toContain('"noteChecked":true');
    expect(serialized).not.toMatch(/Downloads|IMG-|imagePath/);
  });

  it("bounds endpoint text in evidence", () => {
    const result = checkPackagedResponse(JSON.stringify({ ...raw, interval_start: "x".repeat(97) }), expectation);
    expect(result.exact).toBe(false);
    expect(result.observed.interval_start).toBeNull();
  });

  it.each([
    { ...fixture, version: 2 },
    { ...fixture, sourceTimestamp: "2026-02-31T12:00:00Z" },
    { ...fixture, raw: { ...fixture.raw, interval_start: "x".repeat(97) } },
    { ...fixture, raw: { ...fixture.raw, imagePath: "private" } },
    { ...fixture, card: { date: "2026-02-31" } },
    { ...fixture, card: {} },
    { ...fixture, confirmed: { date: "2026-07-19", note: "bad\nline" } },
  ])("rejects malformed expectation metadata", (value) => {
    expect(() => parsePackagedExpectation(value)).toThrow("invalid expectation");
  });
});
