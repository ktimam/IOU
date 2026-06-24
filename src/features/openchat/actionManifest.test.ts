import { describe, it, expect } from "vitest";
import { iouActionManifest, renderManifestJson, IOU_EXTRACTION_PROMPT } from "./actionManifest";
import { parseDraft } from "../entries/draft";

describe("iouActionManifest", () => {
  it("declares an output the IOU draft parser accepts", () => {
    // A sample draft shaped exactly per the manifest's outputSchema.
    const sample = {
      kind: "settlement",
      amount: 42.5,
      currency: "USD",
      direction: "credit",
      date: "2026-06-24",
      note: "dinner",
    };
    const r = parseDraft(sample);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.initial.amount_minor).toBe(4250);
      expect(r.value.initial.direction).toBe("credit");
    }
  });

  it("card direction labels cover exactly the parser's directions", () => {
    expect(Object.keys(iouActionManifest.card.directionLabels).sort()).toEqual(["credit", "debt"]);
    // both directions parse
    expect(parseDraft({ amount: 1, currency: "USD", direction: "credit" }).ok).toBe(true);
    expect(parseDraft({ amount: 1, currency: "USD", direction: "debt" }).ok).toBe(true);
  });

  it("forwards to the relay's OpenChat ingestion path with provenance auth", () => {
    expect(iouActionManifest.callback.path).toBe("/v1/openchat/drafts");
    expect(iouActionManifest.callback.auth).toBe("openchat-provenance");
  });

  it("renders valid JSON carrying the extraction prompt", () => {
    const json = renderManifestJson();
    const parsed = JSON.parse(json);
    expect(parsed.id).toBe("iou.entry.import");
    expect(parsed.prompt).toBe(IOU_EXTRACTION_PROMPT);
  });
});
