import { describe, expect, it, vi } from "vitest";
import * as cardBridge from "./cardBridge";
import {
  checkPackagedResponse,
  DEFAULT_PACKAGED_EXPECTATION,
  parsePackagedExpectation,
  safePackagedExpectation,
} from "../../../scripts/live/packagedTransformersAcceptance";
import fixture from "./fixtures/packaged-worker-date-range-expectation.json";

const expectation = parsePackagedExpectation(fixture);
const raw = {
  amount: 1912.15,
  kind: "iou",
  interval_start: "Sun, Jul 19",
  interval_end: "Thu, Aug 6",
  note: "Reservation",
};

describe("packaged-worker image acceptance checks (no model or device)", () => {
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
      amount: 1912.15, date: "2026-07-19", noteMatches: true,
      confirmedAmount: 1912.15, confirmedDate: "2026-07-19",
      confirmedNoteMatches: true, notePreservedInConfirmation: true,
    });
    expect(JSON.stringify(result)).not.toContain("Reservation");
  });

  it("rejects the malformed object wrapper captured from phone Propose on 2026-09-05", () => {
    // Actual phone output had correct field values but invalid JSON; never count parser repair as
    // a successful model response or let complete inner fields bypass whole-response validation.
    const captured = '{"{"amount":1912.15,"interval_start":"Sun, Jul 19","interval_end":"Thu, Aug 6","note":"Reservation","kind":"iou","currency":"USD"}}';
    const expected = parsePackagedExpectation({ ...fixture, raw: { ...fixture.raw, currency: "USD" } });
    const result = checkPackagedResponse(captured, expected);
    expect(result.exact).toBe(false);
    expect(result.completeJsonObject).toBe(false);
    expect(result.invalidOrTruncatedOutput).toBe(true);
    expect(result.observed.amount).toBeNull();
  });

  it("accepts the same captured phone fields when emitted as one valid complete object", () => {
    const valid = '{"amount":1912.15,"interval_start":"Sun, Jul 19","interval_end":"Thu, Aug 6","note":"Reservation","kind":"iou","currency":"USD"}';
    const expected = parsePackagedExpectation({ ...fixture, raw: { ...fixture.raw, currency: "USD" } });
    const result = checkPackagedResponse(valid, expected);
    expect(result.exact).toBe(true);
    expect(result.completeJsonObject).toBe(true);
    expect(result.invalidOrTruncatedOutput).toBe(false);
    expect(result.observed).toMatchObject({ amount: 1912.15, currency: "USD", noteMatches: true });
    expect(result.projected).toMatchObject({ date: "2026-07-19", confirmedDate: "2026-07-19",
      noteMatches: true, confirmedNoteMatches: true });
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
