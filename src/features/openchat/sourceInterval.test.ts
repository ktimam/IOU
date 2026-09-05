import { describe, expect, it } from "vitest";
import { dateFromSourceInterval, validatedSourceInterval } from "./sourceInterval";

const anchor = new Date("2026-09-05T12:00:00Z");

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
