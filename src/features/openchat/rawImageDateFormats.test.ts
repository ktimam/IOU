import { describe, expect, it } from "vitest";
import { normalizeRawImageEvidence } from "./rawImageEvidence";
import { postProcessIouCandidate } from "./localExtraction";
import { initToFormState } from "./cardBridge";
import { matchTemplateForDraft } from "../entries/resolveTemplateBase";
import type { TxnTemplate } from "../templates/TemplatesContext";

const evidence = (date_text: unknown) => ({
  note: "Visible heading", currency_text: "£", amount_text: "842.65", date_text, kind: "iou",
});
const normalize = (date: unknown) => normalizeRawImageEvidence(evidence(date), "labeled-values");

describe("opt-in IOU date-value wire grammar (not source accuracy or activation)", () => {
  it.each([" | ", " - ", " – ", " — "])("accepts two complete dates with separator %j without altering digits", (separator) => {
    expect(normalize(`28 Sep 2026${separator}2 Oct 2026`)).toMatchObject({
      amount: 842.65, currency: "GBP", printed_date: "28 Sep 2026", printed_end_date: "2 Oct 2026",
    });
    expect(normalize(`2026-09-28${separator}2026-10-02`)).toMatchObject({ printed_date: "2026-09-28", printed_end_date: "2026-10-02" });
  });

  it.each([
    ["Start: 28 Sep 2026 | End: 2 Oct 2026", "28 Sep 2026", "2 Oct 2026"],
    ["First day: 28 Sep 2026 - Last day: 2 Oct 2026", "28 Sep 2026", "2 Oct 2026"],
    ["البداية: 28 Sep 2026 — النهاية: 2 Oct 2026", "28 Sep 2026", "2 Oct 2026"],
    ["Arrival: Sun, Jul 19 – Departure: Thu, Aug 6", "Sun, Jul 19", "Thu, Aug 6"],
    ["Date: 14 Aug 2026 09:47 PM", "14 Aug 2026 09:47 PM", ""],
  ])("accepts structural labels without a keyword list: %s", (raw, start, end) => {
    expect(normalize(raw)).toMatchObject({ printed_date: start, printed_end_date: end });
    expect(normalizeRawImageEvidence(evidence(raw))).toBeUndefined();
  });

  it.each([
    "Start: Reservation | End: Total Payout", "Reservation - Total Payout", "Start: Sep | End: Oct",
    "Start: 28 | End: 2", "Start: 28 Sep 2026 | End:", "Start: 28 Sep 2026 - ",
    "Start: 28 Sep 2026 | End: 31 Sep 2026", "Start: 2 Oct 2026 | End: 28 Sep 2026",
    "Start: 28 Sep 2026 | End: 09:47 PM", "Start: 28 Sep 2026 | End: 2 Oct 2026 extra",
    "Start: Date: 28 Sep 2026 | End: 2 Oct 2026", "Amount 20: 28 Sep 2026 | End: 2 Oct 2026",
    "28 Sep 2026 | 2 Oct 2026 - 3 Oct 2026", "28 Sep 2026 | 2 Oct 2026 | 3 Oct 2026",
    "28 Sep 2026-2 Oct 2026", "28 Sep 2026|2 Oct 2026", "28 Sep 2026  - 2 Oct 2026",
    " 28 Sep 2026 - 2 Oct 2026", "Start:  28 Sep 2026 | End: 2 Oct 2026", "Start:28 Sep 2026 | End: 2 Oct 2026",
    "Start:\n28 Sep 2026 | End: 2 Oct 2026", "Start:\u202e 28 Sep 2026 | End: 2 Oct 2026",
    "Start: 28 Sep 2026 | End: 2 Oct 2026\n", "x".repeat(33) + ": 28 Sep 2026", "x".repeat(196),
    "Date: 14 Aug 2026 25:00", "Date: 14 Aug 2026 09:60 PM", "Date: 14 Aug 2026 UTC",
    "Start: 30 Feb 2026 | End: 2 Mar 2026", "Start: Mon, 28 Sep 2026 | End: Fri, 2 Oct 2025",
  ])("rejects the entire malformed field without salvaging a date: %j", (raw) => {
    expect(normalize(raw)).toBeUndefined();
  });

  it("retains absence, yearless evidence, strict defaults and unrelated field validation", () => {
    expect(normalize("")).not.toHaveProperty("printed_date");
    const yearless = normalize("Sun, Jul 19 - Thu, Aug 6");
    expect(yearless).toMatchObject({ printed_date: "Sun, Jul 19", printed_end_date: "Thu, Aug 6" });
    expect(yearless).not.toHaveProperty("date");
    expect(normalizeRawImageEvidence(evidence("Sun, Jul 19 - Thu, Aug 6"))).toBeUndefined();
    for (const change of [{ amount_text: "Total: 842.65" }, { currency_text: "" }, { extra: "value" }]) {
      const raw = { ...evidence("Start: 28 Sep 2026 | End: 2 Oct 2026"), ...change };
      const result = normalizeRawImageEvidence(raw, "labeled-values");
      if ("currency_text" in change) expect(result).not.toHaveProperty("currency");
      else expect(result).toBeUndefined();
    }
  });

  it.each([
    ["Reservation", "$", "1,912.15", "Sun, Jul 19 - Thu, Aug 6", "2026-07-19", "From Sun, Jul 19 to Thu, Aug 6", "USD"],
    ["EQUIPMENT HIRE", "£", "842.65", "Start: 28 Sep 2026 | End: 2 Oct 2026", "2026-09-28", "From 28 Sep 2026 to 2 Oct 2026", "GBP"],
  ])("projects complete printed dates into the app's date/note and user-defined type: %s", (note, currency_text, amount_text, date_text, date, range, currency) => {
    const raw = { ...evidence(date_text), note, currency_text, amount_text }, before = JSON.stringify(raw);
    const parsed = normalizeRawImageEvidence(raw, "labeled-values");
    expect(parsed).toBeDefined();
    const candidate = postProcessIouCandidate(parsed!, { modality: "image", sourceTimestamp: Date.UTC(2026, 6, 3), candidateCount: 1 });
    const card = initToFormState(candidate, new Date(Date.UTC(2026, 6, 3)));
    expect(card).toMatchObject({ amount: amount_text.replaceAll(",", ""), currency, date, note: `${note} | ${range}` });
    expect(JSON.stringify(raw)).toBe(before);
    const savedType: TxnTemplate = { id: "local-only", name: "User's custom type", keywords: [note], direction: "debt", txn_type: "iou", currency: "EUR", fee_percent: 0, schedule: [] };
    expect(matchTemplateForDraft([savedType], candidate, { evidence: "row-local", allowImageHeading: true })).toBe(savedType);
    expect(candidate).not.toHaveProperty("direction");
    expect(candidate).not.toHaveProperty("date_text");
  });
});
