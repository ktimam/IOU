import { describe, expect, it } from "vitest";
import { iouActionManifest } from "./actionManifest";
import { postProcessIouCandidate } from "./localExtraction";
import { buildConfirmPayload, initToFormState } from "./cardBridge";

describe("image currency tokens stay app-owned through card preparation", () => {
  it("transports a bounded literal symbol instead of asking the generic host to interpret it", () => {
    const schema = (iouActionManifest.outputSchema.properties as Record<string, unknown>).currency;
    expect(schema).toMatchObject({ type: "string", minLength: 1, maxLength: 16, format: "utf8-no-nul" });
  });

  it.each([["$", "USD"], ["EGP", "EGP"], ["€", "EUR"]])(
    "maps %s to %s before the editable card and confirmation payload", (token, expected) => {
      const candidate = postProcessIouCandidate({ amount: 42, currency: token,
        printed_date: "14 Aug 2026", printed_end_date: "", note: "Visible heading" }, { modality: "image" });
      expect(candidate).toEqual({ amount: 42, currency: expected, date: "2026-08-14", note: "Visible heading" });
      const form = initToFormState(candidate);
      expect(form.currency).toBe(expected);
      expect(buildConfirmPayload(form).currency).toBe(expected);
    },
  );

  it.each(["cp", "ecp", "tcp", "C$", "USD or CAD", "$$", "usd", "USD\n", { code: "USD" }])(
    "does not pass malformed or unrecognized image evidence into a currency field: %j", (token) => {
      const candidate = postProcessIouCandidate({ amount: 42, currency: token }, { modality: "image" });
      expect(candidate).not.toHaveProperty("currency");
      expect(initToFormState(candidate).currency).toBe("");
      expect(buildConfirmPayload(initToFormState(candidate))).not.toHaveProperty("currency");
    },
  );

  it("does not synthesize a model currency when no token was supplied", () => {
    expect(postProcessIouCandidate({ amount: 42 }, { modality: "image" })).toEqual({ amount: 42 });
  });

  it("leaves the established text extraction path unchanged", () => {
    expect(postProcessIouCandidate({ amount: 42, currency: "USD" }, { modality: "text" }))
      .toMatchObject({ amount: 42, currency: "USD" });
  });
});
