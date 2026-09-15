import { describe, expect, it } from "vitest";
import { dateFromPrintedDate, dateFromSourceInterval, validatedSourceInterval } from "./sourceInterval";

const anchor = new Date("2026-09-05T12:00:00Z");

describe("single printed date with a bounded clock suffix", () => {
  it.each([
    ["14 Aug 2026 09:47 PM", "2026-08-14"],
    ["February 29, 2024 12:00 AM", "2024-02-29"],
    ["2025-12-31 23:59:59", "2025-12-31"],
    ["1 January 2027 0:00", "2027-01-01"],
    ["Fri, Aug 14 2026 9:47:05 pm", "2026-08-14"],
    ["2024-02-29 12:00:00 PM", "2024-02-29"],
    ["14 آب 2026 09:47 PM", "2026-08-14"],
    ["١٤ أغسطس ٢٠٢٦ 21:47", "2026-08-14"],
  ])("keeps the explicit calendar day, without timezone conversion, from %s", (value, expected) => {
    expect(dateFromPrintedDate(value)).toBe(expected);
  });

  it.each([
    "14 Aug 2026 00:47 PM", "14 Aug 2026 13:47 PM", "14 Aug 2026 24:00",
    "14 Aug 2026 09:60 PM", "14 Aug 2026 09:47:60 PM", "14 Aug 2026 23:60",
    "14 Aug 2026 09:7 PM", "14 Aug 2026 09:47:5 PM", "14 Aug 2026 009:47 PM",
    "14 Aug 2026 09 PM", "14 Aug 2026 09:47PM", "14 Aug 2026 09:47 XM",
    "14 Aug 2026 09:47 PM UTC", "14 Aug 2026 09:47 +03:00", "2026-08-14T21:47:00Z",
    "14 Aug 2026 09:47:00.123 PM", "14 Aug 2026 at 09:47 PM",
    "14 Aug 2026 09:47 PM extra", "14 Aug 2026 09:47 PM 10:00 PM",
    "14 Aug 09:47 PM", "Fri, Aug 14 09:47 PM", "30 Feb 2026 09:47 PM",
    "Mon, Aug 14 2026 09:47 PM", "14/08/2026 09:47 PM",
    "14 Aug 2026\n09:47 PM", "14 Aug 2026 09:47\tPM", "14 Aug 2026 09:47 PM\u202e",
    `${" ".repeat(97)}14 Aug 2026 09:47 PM`,
  ])("rejects invalid clocks, unsupported suffixes and invalid or incomplete dates: %s", (value) => {
    expect(dateFromPrintedDate(value)).toBeUndefined();
  });

  it("does not silently extend interval endpoint syntax", () => {
    expect(validatedSourceInterval("14 Aug 2026 09:47 PM", "15 Aug 2026", anchor)).toBeUndefined();
    expect(validatedSourceInterval("14 Aug 2026", "15 Aug 2026 09:47 PM", anchor)).toBeUndefined();
  });
});

describe("IOU source interval evidence", () => {
  it.each([
    ["Reservation", "Total Payout"],
    ["Start date", "End date"],
    ["2026-07-19", "Total Payout"],
    ["Sun, Jul 19", undefined],
    [undefined, "Thu, Aug 6"],
    ["07/04/2026", "08/06/2026"],
    ["Sun, Jul 32", "Thu, Aug 6"],
    ["Feb 30", "Mar 1"],
    ["2026-02-29", "2026-03-01"],
    ["2026-08-10", "2026-08-06"],
    ["Monday, July 19, 2026", "August 6, 2026"],
    ["Sun, Jul 19\u202e", "Thu, Aug 6"],
    [{ value: "2026-07-19" }, "2026-08-06"],
  ])("rejects non-date, incomplete or impossible pair %s / %s", (start, end) => {
    expect(validatedSourceInterval(start, end, anchor)).toBeUndefined();
  });

  it("retains complete copied endpoints and uniquely anchors their printed weekdays", () => {
    expect(validatedSourceInterval("Sun, Jul 19", "Thu, Aug 6", anchor)).toEqual({
      start: "Sun, Jul 19", end: "Thu, Aug 6", date: "2026-07-19",
    });
  });

  it.each([
    ["Sun, Jul. 19", "Thu, Aug. 6", "2026-07-19"],
    ["19 July 2026", "6 August 2026", "2026-07-19"],
    ["July 19,2026", "August 6,2026", "2026-07-19"],
    ["2025-12-29", "2026-01-03", "2025-12-29"],
    ["July 19", "August 6 2024", "2024-07-19"],
    ["December 29", "January 3 2025", "2024-12-29"],
    ["December 29 2024", "January 3", "2024-12-29"],
    ["July 19 2024", "August 6", "2024-07-19"],
  ])("derives a justified canonical start from %s / %s", (start, end, date) => {
    expect(validatedSourceInterval(start, end, anchor)).toEqual({ start, end, date });
  });

  it.each([
    ["Jul 19", "Aug 6"],
    ["Mon, Jul 19", "Thu, Aug 6"],
    ["Feb 29", "Mar 1"],
  ])("retains date-like source text without inventing a year for %s / %s", (start, end) => {
    expect(validatedSourceInterval(start, end, anchor)).toEqual({ start, end });
    expect(dateFromSourceInterval(start, end, anchor)).toBeUndefined();
  });

  it("does not depend on a valid current calendar when the source provides its year", () => {
    expect(dateFromSourceInterval("2024-02-29", "2024-03-01", new Date(NaN))).toBe("2024-02-29");
    expect(dateFromSourceInterval("Sun, Jul 19", "Thu, Aug 6", new Date(NaN))).toBeUndefined();
  });
});
