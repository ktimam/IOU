import { describe, it, expect } from "vitest";
import { deepLinkToPath } from "./deepLink";

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
  });
});
