import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the network resolver so we can assert the cache/invalidation behaviour without a replica.
const { getRegisteredInboxCanisterId } = vi.hoisted(() => ({
  getRegisteredInboxCanisterId: vi.fn(),
}));
vi.mock("./registerAiApp", () => ({ getRegisteredInboxCanisterId }));

import {
  parseInboxPlaintext,
  getActionInboxConfig,
  invalidateInboxCache,
} from "./actionInboxClient";

// The v2 envelope plaintext wrapper OpenChat's local_user_index builds around the confirm payload:
//   { context: { chat, messageId, confirmedBy, confirmedAt }, payload: <original confirm-payload JSON> }
// Wrapper-less plaintexts (pre-v2 deposits, non-OpenChat producers) must be tolerated by treating the
// whole document as the payload.
describe("parseInboxPlaintext (v2 envelope wrapper)", () => {
  const payload = { action_id: "iou.add", rows: [{ label: "Amount", value: "$20" }] };
  const context = {
    chat: "group:dfdal-2uaaa-aaaaa-qaama-cai",
    messageId: "123456789012345678",
    confirmedBy: "27eue-hyaaa-aaaaf-aaa4a-cai",
    confirmedAt: 1750000000123,
  };

  it("splits a v2 wrapper into payload + context", () => {
    const out = parseInboxPlaintext(JSON.stringify({ context, payload }));
    expect(out.payload).toEqual(payload);
    expect(out.context).toEqual(context);
  });

  it("supports the channel chat key form", () => {
    const chan = { ...context, chat: "channel:dfdal-2uaaa-aaaaa-qaama-cai:42" };
    const out = parseInboxPlaintext(JSON.stringify({ context: chan, payload }));
    expect(out.context?.chat).toBe("channel:dfdal-2uaaa-aaaaa-qaama-cai:42");
  });

  it("treats a wrapper-less JSON document as the payload (no context)", () => {
    const out = parseInboxPlaintext(JSON.stringify(payload));
    expect(out.payload).toEqual(payload);
    expect(out.context).toBeUndefined();
  });

  it("treats non-object JSON as the payload", () => {
    expect(parseInboxPlaintext('"just a string"')).toEqual({ payload: "just a string" });
    expect(parseInboxPlaintext("[1,2,3]")).toEqual({ payload: [1, 2, 3] });
  });

  it("does not mistake a payload that merely HAS a context field for a wrapper", () => {
    // "payload" key missing → not the wrapper shape, whole doc is the payload.
    const doc = { context: { chat: "group:x", messageId: "1" }, something_else: true };
    const out = parseInboxPlaintext(JSON.stringify(doc));
    expect(out.payload).toEqual(doc);
    expect(out.context).toBeUndefined();
  });

  it("keeps the payload but drops a malformed context", () => {
    const out = parseInboxPlaintext(JSON.stringify({ context: { chat: 42 }, payload }));
    expect(out.payload).toEqual(payload);
    expect(out.context).toBeUndefined();
  });

  it("tolerates missing optional context fields", () => {
    const out = parseInboxPlaintext(
      JSON.stringify({ context: { chat: "group:x", messageId: "7" }, payload }),
    );
    expect(out.context).toEqual({ chat: "group:x", messageId: "7", confirmedBy: "", confirmedAt: 0 });
  });

  it("throws on non-JSON input (caller drops the envelope)", () => {
    expect(() => parseInboxPlaintext("not json")).toThrow();
  });
});

describe("inbox resolver cache + invalidateInboxCache (stale-manifest fix)", () => {
  beforeEach(() => {
    getRegisteredInboxCanisterId.mockReset();
    invalidateInboxCache();
    process.env.VITE_OPENCHAT_HOST = "http://127.0.0.1:8080";
    process.env.VITE_OC_USER_INDEX_CANISTER_ID = "uxrrr-q7777-77774-qaaaq-cai";
    process.env.VITE_IOU_BACKEND_CANISTER_ID = "ll5dv-z7777-77777-aaaca-cai";
  });

  it("memoizes the resolved inbox — repeated calls hit user_index once", async () => {
    getRegisteredInboxCanisterId.mockResolvedValue("lc6ij-px777-77777-aaadq-cai");
    const a = await getActionInboxConfig();
    const b = await getActionInboxConfig();
    expect(a?.canisterId).toBe("lc6ij-px777-77777-aaadq-cai");
    expect(b?.canisterId).toBe("lc6ij-px777-77777-aaadq-cai");
    expect(getRegisteredInboxCanisterId).toHaveBeenCalledTimes(1);
  });

  it("re-queries after invalidateInboxCache — a re-registration takes effect immediately", async () => {
    getRegisteredInboxCanisterId.mockResolvedValueOnce("old-inbox-canister-cai");
    expect((await getActionInboxConfig())?.canisterId).toBe("old-inbox-canister-cai");
    // A re-register moved the routed inbox; without the bust the poll would keep using the old one.
    getRegisteredInboxCanisterId.mockResolvedValueOnce("new-inbox-canister-cai");
    invalidateInboxCache();
    expect((await getActionInboxConfig())?.canisterId).toBe("new-inbox-canister-cai");
    expect(getRegisteredInboxCanisterId).toHaveBeenCalledTimes(2);
  });
});
