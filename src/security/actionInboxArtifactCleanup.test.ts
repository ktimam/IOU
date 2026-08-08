import { describe, expect, it, vi } from "vitest";
import {
  finalizeActionInboxArtifactCleanup,
  matchesExactActionInboxDraft,
  type ExactActionInboxEnvelope,
} from "../../scripts/live/actionInboxArtifactCleanup";

const single: ExactActionInboxEnvelope = {
  shape: "single",
  entries: [
    {
      kind: "iou",
      amount: 701234,
      currency: "USD",
      direction: "debt",
      note: "edit run-abc",
    },
  ],
};

describe("exact ActionInbox envelope evidence", () => {
  it("matches every nonce-bearing payload field while allowing unrelated optional fields", () => {
    expect(
      matchesExactActionInboxDraft(
        { ...single.entries[0], type: "Rent", date: "2026-08-08" },
        single,
      ),
    ).toBe(true);
    expect(
      matchesExactActionInboxDraft(
        { ...single.entries[0], note: "prefix edit run-abc suffix" },
        single,
      ),
    ).toBe(false);
    expect(
      matchesExactActionInboxDraft(
        { ...single.entries[0], amount: String(single.entries[0].amount) },
        single,
      ),
    ).toBe(false);
  });

  it("distinguishes an omitted default currency from a concrete currency", () => {
    const noCurrency: ExactActionInboxEnvelope = {
      shape: "single",
      entries: [{ ...single.entries[0], currency: null }],
    };
    const { currency: _currency, ...withoutCurrency } = single.entries[0];
    expect(matchesExactActionInboxDraft(withoutCurrency, noCurrency)).toBe(true);
    expect(matchesExactActionInboxDraft({ ...withoutCurrency, currency: "" }, noCurrency)).toBe(true);
    expect(matchesExactActionInboxDraft(single.entries[0], noCurrency)).toBe(false);
  });

  it("requires exact batch shape, length, order, and values", () => {
    const batch: ExactActionInboxEnvelope = {
      shape: "batch",
      entries: [
        { ...single.entries[0], note: "multi-a run-abc" },
        { ...single.entries[0], amount: 500, note: "multi-b run-abc" },
      ],
    };
    expect(matchesExactActionInboxDraft(batch.entries, batch)).toBe(true);
    expect(matchesExactActionInboxDraft([...batch.entries].reverse(), batch)).toBe(false);
    expect(matchesExactActionInboxDraft(batch.entries[0], batch)).toBe(false);
    expect(matchesExactActionInboxDraft([batch.entries[0]], batch)).toBe(false);
  });

  it("rejects empty or duplicate evidence rather than creating a broad matcher", () => {
    expect(
      matchesExactActionInboxDraft(single.entries[0], {
        shape: "single",
        entries: [{ ...single.entries[0], note: "" }],
      }),
    ).toBe(false);
    expect(
      matchesExactActionInboxDraft([single.entries[0], single.entries[0]], {
        shape: "batch",
        entries: [single.entries[0], single.entries[0]],
      }),
    ).toBe(false);
  });
});

describe("ActionInbox cleanup failure precedence", () => {
  it("fails a passing harness when an exact envelope cannot be cleaned", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cleaner = {
      cleanup: vi.fn().mockResolvedValue({
        matched: 2,
        acknowledged: 0,
        errors: ["ambiguous exact envelopes"],
      }),
    };
    await expect(
      finalizeActionInboxArtifactCleanup(cleaner, false, "test harness"),
    ).rejects.toThrow("ambiguous exact envelopes");
    error.mockRestore();
  });

  it("does not replace the original harness failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cleaner = {
      cleanup: vi.fn().mockRejectedValue(new Error("cleanup crashed")),
    };
    await expect(
      finalizeActionInboxArtifactCleanup(cleaner, true, "test harness"),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("cleanup crashed"));
    error.mockRestore();
  });
});
