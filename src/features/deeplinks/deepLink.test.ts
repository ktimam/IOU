import { describe, it, expect, vi } from "vitest";
import { deepLinkToPath, handleAppUrl } from "./deepLink";

describe("deepLinkToPath", () => {
  it("maps known hosts to routes", () => {
    expect(deepLinkToPath("iou://sheet/abc123")).toBe("/sheet/abc123");
    expect(deepLinkToPath("iou://pair/xyz")).toBe("/pair/xyz");
    expect(deepLinkToPath("iou://pairs")).toBe("/pairs");
    expect(deepLinkToPath("iou://settings")).toBe("/settings");
    expect(deepLinkToPath("iou://me")).toBe("/me");
  });

  it("preserves the fragment on settings/me so the OpenChat connect deep link scrolls to Connect", () => {
    // Regression (P0-20): iou://settings#openchat-connect must carry the hash through, or the
    // desktop "Open the code page in IOU" button lands on /settings but never focuses the Connect
    // section. Previously the settings case dropped url.hash (only `invite` preserved it).
    expect(deepLinkToPath("iou://settings#openchat-connect")).toBe("/settings#openchat-connect");
    expect(deepLinkToPath("iou://me#openchat-connect")).toBe("/me#openchat-connect");
    // fragment-less still resolves cleanly
    expect(deepLinkToPath("iou://settings")).toBe("/settings");
  });

  it("maps invite links to the accept surface, preserving the fragment", () => {
    expect(
      deepLinkToPath("iou://invite#c=ABCD-1234&s=deadbeef&k=Zm9v"),
    ).toBe("/pair/accept#c=ABCD-1234&s=deadbeef&k=Zm9v");
    // a fragment-less invite still resolves to the accept page (which then
    // reports the link is malformed)
    expect(deepLinkToPath("iou://invite")).toBe("/pair/accept");
  });

  it("encodes path segments", () => {
    expect(deepLinkToPath("iou://sheet/a b")).toBe("/sheet/a%20b");
  });

  it("rejects unknown hosts and bad input (no arbitrary navigation)", () => {
    expect(deepLinkToPath("iou://evil/../admin")).toBe(null);
    expect(deepLinkToPath("iou://sheet")).toBe(null); // missing id
    expect(deepLinkToPath("https://example.com/sheet/abc")).toBe(null); // wrong scheme
    expect(deepLinkToPath("not a url")).toBe(null);
    expect(deepLinkToPath("")).toBe(null);
    // P1 (U29): the OpenChat surfaces are opened via HTTPS URLs, never iou:// deep links, so the
    // `openchat` host is intentionally unmapped (dropped) rather than routed anywhere.
    expect(deepLinkToPath("iou://openchat/link-chat?chat=group:abc")).toBe(null);
  });
});

// U23: the appUrlOpen wiring — navigate exactly when the link maps; NEVER navigate on an
// unknown/malformed link (no fallback route a malicious link could push the user to).
describe("handleAppUrl (native appUrlOpen wiring)", () => {
  it("navigates to the mapped path for a known link", () => {
    const navigate = vi.fn();
    handleAppUrl("iou://sheet/abc123", navigate);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("/sheet/abc123");
    handleAppUrl("iou://invite#c=ABCD-1234&s=deadbeef&k=Zm9v", navigate);
    expect(navigate).toHaveBeenLastCalledWith("/pair/accept#c=ABCD-1234&s=deadbeef&k=Zm9v");
  });

  it("ignores null-mapped links entirely (no navigation)", () => {
    const navigate = vi.fn();
    for (const bad of [
      "iou://evil/../admin",
      "iou://openchat/link-chat?chat=group:abc",
      "https://example.com/sheet/abc",
      "not a url",
      "",
    ]) {
      handleAppUrl(bad, navigate);
    }
    expect(navigate).not.toHaveBeenCalled();
  });
});
