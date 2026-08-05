import { describe, expect, it } from "vitest";
import { scopedStorageKey } from "./scopedStorage";

describe("scopedStorageKey", () => {
  it("separates principals within one browser profile", () => {
    expect(scopedStorageKey("prefs", "principal-a", "deployment-1")).not.toBe(
      scopedStorageKey("prefs", "principal-b", "deployment-1"),
    );
  });

  it("separates deployments for the same principal", () => {
    expect(scopedStorageKey("prefs", "principal-a", "deployment-1")).not.toBe(
      scopedStorageKey("prefs", "principal-a", "deployment-2"),
    );
  });

  it("is stable for restarts of the same profile, principal and deployment", () => {
    expect(scopedStorageKey("prefs", "principal-a", "deployment-1")).toBe(
      scopedStorageKey("prefs", "principal-a", "deployment-1"),
    );
  });
});
