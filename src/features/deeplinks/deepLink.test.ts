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

  it("prefills the join code from path or query, uppercased", () => {
    expect(deepLinkToPath("iou://join/abcd-1234")).toBe("/pair/new?join=ABCD-1234");
    expect(deepLinkToPath("iou://join?code=abcd-1234")).toBe("/pair/new?join=ABCD-1234");
    expect(deepLinkToPath("iou://join")).toBe("/pair/new");
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
