import { afterEach, describe, expect, it, vi } from "vitest";
import { localImportNavigationUrl, openLocalImportNavigation } from "./LocalImportNavigation";

afterEach(() => vi.unstubAllGlobals());
describe("framed import navigation", () => {
  it.each(["/pairs", "/settings", "/pair/0000000000000001", "/sheet/0123456789abcdef"])("opens only the normal same-origin route %s", path => {
    expect(localImportNavigationUrl(path, "http://localhost:3000")).toBe("http://localhost:3000" + path);
  });
  it.each(["https://other.example/", "//other.example/", "/\\other.example/", "javascript:alert(1)", "pairs"])("rejects nonlocal destination %s", path => {
    expect(() => localImportNavigationUrl(path, "http://localhost:3000")).toThrow("Invalid IOU navigation");
  });
  it("uses a new no-opener, no-referrer window without passing credentials", () => {
    const open = vi.fn(); vi.stubGlobal("window", { location: { origin: "http://localhost:3000" }, open });
    openLocalImportNavigation("/settings");
    expect(open).toHaveBeenCalledExactlyOnceWith("http://localhost:3000/settings", "_blank", "noopener,noreferrer");
  });
});
