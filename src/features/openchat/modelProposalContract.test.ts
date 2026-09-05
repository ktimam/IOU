import { describe, expect, it } from "vitest";
import fixtures from "./fixtures/model-proposal-contract-v1.json";
import expectedFixture from "./fixtures/packaged-worker-date-range-expectation.json";
import { checkPackagedResponse, parsePackagedExpectation } from "../../../scripts/live/packagedTransformersAcceptance";

describe("recorded phone proposal integration fixture contract", () => {
  it("keeps every observed failure and the valid counterpart in the desktop/emulator gate", () => {
    expect(fixtures.version).toBe(1);
    expect(fixtures.cases.map(({ id }) => id)).toEqual([
      "phone-malformed-wrapper", "phone-nested-endpoints", "phone-source-label-as-key", "phone-complete-valid-output",
    ]);
    expect(fixtures.cases.filter(({ strictAccepted }) => strictAccepted)).toHaveLength(1);
  });

  it.each(fixtures.cases)("strict raw checker agrees with the full pipeline fixture: $id", (fixture) => {
    const expected = parsePackagedExpectation({ ...expectedFixture,
      raw: { ...expectedFixture.raw, currency: "USD" } });
    expect(fixture.raw.length).toBeLessThan(1024);
    expect(checkPackagedResponse(fixture.raw, expected).exact).toBe(fixture.strictAccepted);
  });

  it("does not equate host-ready with a complete model result", () => {
    const nested = fixtures.cases.find(({ id }) => id === "phone-nested-endpoints")!;
    expect(nested.hostKind).toBe("ready");
    expect(nested.strictAccepted).toBe(false);
    expect(nested.projectedDate).toBeNull();
    const valid = fixtures.cases.find(({ id }) => id === "phone-complete-valid-output")!;
    expect(valid.hostKind).toBe("ready");
    expect(valid.strictAccepted).toBe(true);
    expect(valid.projectedDate).toBe("2026-07-19");
  });
});
