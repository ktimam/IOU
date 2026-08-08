import { describe, expect, it, vi } from "vitest";
import {
  finalizeOpenChatArtifactCleanup,
  OPENCHAT_MESSAGE_TEXT_SELECTOR,
  selectExactOpenChatArtifacts,
  type OpenChatArtifactBaseline,
  type OpenChatArtifactCandidate,
} from "../../scripts/live/openChatArtifactCleanup";

const baseline: OpenChatArtifactBaseline = {
  messageIds: ["10", "11"],
  maxMessageIndex: 11,
};

function candidate(
  id: number,
  overrides: Partial<OpenChatArtifactCandidate> = {},
): OpenChatArtifactCandidate {
  return {
    message: { messageId: String(id), messageIndex: id, eventIndex: id + 100 },
    owned: true,
    exactTexts: [],
    cardCount: 0,
    iframeInputValues: [],
    ...overrides,
  };
}

describe("exact OpenChat artifact selection", () => {
  it("uses one capture/evidence selector for both mobile and classic message text", () => {
    expect(OPENCHAT_MESSAGE_TEXT_SELECTOR.split(",").map((value) => value.trim())).toEqual([
      ".message_text",
      ".markdown-wrapper",
    ]);
  });

  it("selects only a fresh sender-owned exact-text message", () => {
    const result = selectExactOpenChatArtifacts(
      baseline,
      [
        candidate(10, { exactTexts: ["run abc"] }),
        candidate(12, { owned: false, exactTexts: ["run abc"] }),
        candidate(13, { exactTexts: ["prefix run abc suffix"] }),
        candidate(14, { exactTexts: [" run   abc "] }),
      ],
      { kind: "text", exactText: "run abc" },
    );
    expect(result.error).toBeUndefined();
    expect(result.matches.map((value) => value.message.messageId)).toEqual(["14"]);
  });

  it("requires every exact nonce-bearing iframe input and may clean duplicate run cards", () => {
    const result = selectExactOpenChatArtifacts(
      baseline,
      [
        candidate(12, { cardCount: 1, iframeInputValues: ["note-a", "note-b"] }),
        candidate(13, { cardCount: 1, iframeInputValues: ["note-a"] }),
        candidate(14, { cardCount: 1, iframeInputValues: ["note-a", "note-b"] }),
      ],
      { kind: "card_inputs", exactInputValues: ["note-a", "note-b"] },
    );
    expect(result.matches.map((value) => value.message.messageId)).toEqual(["12", "14"]);
  });

  it("rejects the retired unbound-card fallback even when several fresh cards exist", () => {
    const result = selectExactOpenChatArtifacts(
      baseline,
      [candidate(12, { cardCount: 1 }), candidate(13, { cardCount: 1 })],
      { kind: "single_fresh_card" } as never,
    );
    expect(result.matches).toEqual([]);
    expect(result.error).toMatch(/unsupported cleanup expectation/);
  });

  it("refuses a lone fresh sender-owned card when no run-specific evidence binds it", () => {
    const result = selectExactOpenChatArtifacts(
      baseline,
      [candidate(12, { cardCount: 1 })],
      // Exercise the retired value defensively: stale compiled harness code must also fail closed.
      { kind: "single_fresh_card" } as never,
    );
    expect(result.matches).toEqual([]);
    expect(result.error).toMatch(/unsupported cleanup expectation/);
  });

  it("does not let an unrelated lone card match exact evidence from this run", () => {
    const result = selectExactOpenChatArtifacts(
      baseline,
      [
        candidate(12, {
          exactTexts: ["another run"],
          cardCount: 1,
          iframeInputValues: ["unrelated-note"],
        }),
      ],
      { kind: "card_inputs", exactInputValues: ["this-run-nonce"] },
    );
    expect(result.matches).toEqual([]);
    expect(result.error).toBeUndefined();
  });

  it("refuses empty exact evidence instead of treating it as a wildcard", () => {
    expect(
      selectExactOpenChatArtifacts(
        baseline,
        [candidate(12, { exactTexts: [""], cardCount: 1, iframeInputValues: [""] })],
        { kind: "text", exactText: "  " },
      ).error,
    ).toMatch(/empty exact-text/);
    expect(
      selectExactOpenChatArtifacts(
        baseline,
        [candidate(12, { cardCount: 1, iframeInputValues: [""] })],
        { kind: "card_inputs", exactInputValues: [] },
      ).error,
    ).toMatch(/empty iframe-input/);
  });
});

describe("cleanup failure precedence", () => {
  it("fails an otherwise successful harness when exact cleanup fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cleaner = {
      cleanup: vi.fn().mockResolvedValue({ deleted: [], errors: ["delete failed"] }),
    };
    await expect(
      finalizeOpenChatArtifactCleanup(cleaner, false, "test harness"),
    ).rejects.toThrow("delete failed");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("delete failed"));
    error.mockRestore();
  });

  it("does not replace an existing harness failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cleaner = {
      cleanup: vi.fn().mockRejectedValue(new Error("cleanup crashed")),
    };
    await expect(
      finalizeOpenChatArtifactCleanup(cleaner, true, "test harness"),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("cleanup crashed"));
    error.mockRestore();
  });
});
