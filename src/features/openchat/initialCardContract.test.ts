import { describe, expect, it } from "vitest";
import fixtures from "./fixtures/initial-card-content-v1.json";
import { iouActionManifest } from "./actionManifest";
import { processIouRequest } from "./localProcessorBridge";
import { buildConfirmPayload, initToFormState } from "./cardBridge";

// The same exact initial content is consumed by Rust's authenticated card attester tests.
// scripts/live/verify-initial-card-contract.ts additionally checks OpenChat's real generic builder
// against these bytes. Testing only the eventual editable-card payload misses initial refusals.
describe("initial IOU card contract shared with the Rust attester", () => {
  it.each(fixtures)("pins actual local processing before card projection: $name", (fixture) => {
    const binding = { frameNonce: "a".repeat(48), requestNonce: "b".repeat(48) };
    const result = processIouRequest({ type: "oc:app-process:request", version: 1, ...binding,
      actionId: iouActionManifest.id, input: fixture.input }, binding);
    expect(result.kind).toBe("candidates");
    if (result.kind !== "candidates") throw new Error("expected app candidates");
    const payload = JSON.parse(new TextDecoder().decode(new Uint8Array(fixture.content.confirm_payload)));
    expect(result.candidates).toEqual([payload]);
    expect(fixture.content.action_id).toBe(iouActionManifest.id);
    expect(fixture.content.rows).toEqual(iouActionManifest.card.fields
      .map(({ key, label }) => ({ label, value: payload[key] === undefined ? "" : String(payload[key]) }))
      .filter(({ value }) => value.length > 0));

    if (payload.interval_start !== undefined) {
      expect(payload.interval_end).toBeTypeOf("string");
      const form = initToFormState(payload, new Date("2026-09-05T00:00:00Z"));
      expect(form.note).toContain(`From ${payload.interval_start} to ${payload.interval_end}`);
      const finalPayload = buildConfirmPayload(form);
      expect(finalPayload).not.toHaveProperty("interval_start");
      expect(finalPayload).not.toHaveProperty("interval_end");
    }
  });

  it("retains a canonical non-interval image date at initial attestation", () => {
    const fixture = fixtures.find(({ name }) => name === "image-visible-date-normalization")!;
    const payload = JSON.parse(new TextDecoder().decode(new Uint8Array(fixture.content.confirm_payload)));
    expect(payload).toMatchObject({ amount: 12900, date: "2026-08-14" });
    expect(payload).not.toHaveProperty("interval_start");
    expect(fixture.content.rows).toContainEqual({ label: "Date", value: "2026-08-14" });
  });

  it("derives the anchored image interval date before initial attestation", () => {
    const fixture = fixtures.find(({ name }) => name === "image-visible-interval-evidence")!;
    const payload = JSON.parse(new TextDecoder().decode(new Uint8Array(fixture.content.confirm_payload)));
    expect(fixture.input.sourceTimestamp).toBe(Date.UTC(2026, 8, 5));
    expect(payload).toMatchObject({ date: "2026-07-19", interval_start: "Sun, Jul 19", interval_end: "Thu, Aug 6" });
    expect(fixture.content.rows).toContainEqual({ label: "Date", value: "2026-07-19" });
  });

  it("preserves the phone's decimal image amount in the exact initial attestation payload and row", () => {
    const fixture = fixtures.find(({ name }) => name === "phone-decimal-image-complete-interval")!;
    const payload = JSON.parse(new TextDecoder().decode(new Uint8Array(fixture.content.confirm_payload)));
    expect(payload).toMatchObject({ amount: 1912.15, currency: "USD", date: "2026-07-19" });
    expect(fixture.content.rows).toContainEqual({ label: "Amount", value: "1912.15" });
    expect(fixture.content.rows).toContainEqual({ label: "Date", value: "2026-07-19" });
  });

  it.each([
    ["Reservation", "Total Payout"],
    ["Equipment calibration", "Overall balance"],
  ])("rejects a captured label pair before it reaches the initial payload: %s / %s", (start, end) => {
    const binding = { frameNonce: "a".repeat(48), requestNonce: "b".repeat(48) };
    const candidate = { amount: 26400, currency: "EGP", kind: "iou", direction: "credit",
      note: start, interval_start: start, interval_end: end } as const;
    const result = processIouRequest({ type: "oc:app-process:request", version: 1, ...binding,
      actionId: iouActionManifest.id, input: { operation: "normalize", modality: "image",
        sourceTimestamp: Date.UTC(2026, 8, 5), candidates: [candidate] } }, binding);
    expect(result.kind).toBe("candidates");
    if (result.kind !== "candidates") throw new Error("expected preserved non-interval candidate");
    expect(result.candidates).toEqual([{ amount: 26400, currency: "EGP", kind: "iou",
      direction: "credit", note: start }]);
    // Normalization and legacy/direct card rendering must both avoid manufacturing a range.
    for (const input of [candidate, result.candidates[0]]) {
      const form = initToFormState(input, new Date("2026-09-05T00:00:00Z"));
      expect(form.note).toBe(start);
      expect(form.date).toBe("");
      const finalPayload = buildConfirmPayload(form);
      expect(finalPayload).not.toHaveProperty("interval_start");
      expect(finalPayload).not.toHaveProperty("interval_end");
      expect(finalPayload.note).not.toContain(`From ${start} to ${end}`);
    }
  });
});
