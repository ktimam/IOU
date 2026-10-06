import { describe, expect, it } from "vitest";
import { localConnectionLabel, localConnectionLabels } from "./localConnectionLabels";

describe("normal app connection labels", () => {
  it("uses the account and sheet names already used by IOU", () => {
    expect(localConnectionLabel(localConnectionLabels(0, "Household", "October")))
      .toBe("Household — October");
  });
  it("uses numbered friendly fallbacks, never account or sheet identifiers", () => {
    expect(localConnectionLabel(localConnectionLabels(1, " ", "")))
      .toBe("Account 2 — Current sheet");
  });
});
