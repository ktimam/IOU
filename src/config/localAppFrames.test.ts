import { describe, expect, it } from "vitest";
import { isLocalAppFrameRoute, resolveLocalAppFrameOrigins } from "./localAppFrames";

const local = { isDevelopment: true, dfxNetwork: "local" };
describe("scoped local app framing", () => {
  it("allows only explicitly configured exact loopback origins", () => {
    const origins = ["http://localhost:5190", "http://localhost:5192", "http://localhost:5193"];
    expect(resolveLocalAppFrameOrigins(JSON.stringify(origins), local)).toEqual(origins);
    expect(resolveLocalAppFrameOrigins(undefined, local)).toEqual([]);
  });
  it.each(["http://localhost:*", "*", "null", "https://other.example", "http://localhost:5190/", "http://localhost:5190/path", "http://user@localhost:5190", "http://localhost:80", "http://localhost:65536", "http://localhost:5190; frame-ancestors *"])("rejects a broad or ambiguous origin %s", origin => {
    expect(() => resolveLocalAppFrameOrigins(JSON.stringify([origin]), local)).toThrow();
  });
  it("ignores the setting entirely outside local development", () => {
    expect(resolveLocalAppFrameOrigins("invalid", { ...local, isDevelopment: false })).toEqual([]);
    expect(resolveLocalAppFrameOrigins("invalid", { ...local, dfxNetwork: "ic" })).toEqual([]);
  });
  it("does not change framing for sign-in, sheets, assets or arbitrary routes", () => {
    for (const route of ["/", "/signin", "/sheet/example", "/src/main.tsx", "/openchat/import?origin=attacker", "/openchat/connect/"]) expect(isLocalAppFrameRoute(route)).toBe(false);
    expect(isLocalAppFrameRoute("/openchat/import")).toBe(true);
    expect(isLocalAppFrameRoute("/openchat/connect")).toBe(true);
    expect(isLocalAppFrameRoute("/openchat/connect.html")).toBe(true);
    for (const route of ["/openchat/connect.html/", "/openchat/connect.html?code=bad", "/openchat/connect.html/../sheet/example"]) {
      expect(isLocalAppFrameRoute(route)).toBe(false);
    }
  });
});
