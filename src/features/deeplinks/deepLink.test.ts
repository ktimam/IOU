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
