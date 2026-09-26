import { describe, expect, it } from "vitest";
import { captureLocalImportLaunch, localImportNativeBootstrap, localImportSenderOrigin, localImportSessionNonce } from "./localImportLaunch";

describe("local import launch boundary", () => {
  it.each(["https://oc.app", "http://localhost:5190/", "http://localhost.evil:5190", "http://user@localhost:5190", "null", "http://localhost:5190?allow=1"])("refuses unconfigured/nonlocal exact origin %s", (origin) => {
    expect(localImportSenderOrigin(origin)).toBeUndefined();
  });
  it("accepts only canonical loopback origins for this local prototype", () => {
    expect(localImportSenderOrigin("http://localhost:5190")).toBe("http://localhost:5190");
    expect(localImportSenderOrigin("http://127.0.0.1:5190")).toBe("http://127.0.0.1:5190");
  });
  it("scrubs the nonce and rejects fragments containing any additional data", () => {
    const nonce = "A".repeat(43);
    const replaced: unknown[][] = [];
    const target = { location: { pathname: "/openchat/import", hash: `#sessionNonce=${nonce}` },
      history: { state: null, replaceState: (...args: unknown[]) => replaced.push(args) } } as unknown as Pick<Window, "location" | "history">;
    captureLocalImportLaunch(target);
    expect(localImportSessionNonce()).toBe(nonce);
    expect(localImportNativeBootstrap()).toBe(false);
    expect(replaced[0][2]).toBe("/openchat/import");
    target.location.hash += "&payload=private";
    captureLocalImportLaunch(target);
    expect(localImportSessionNonce()).toBeUndefined();
    expect(localImportNativeBootstrap()).toBe(false);
  });
  it("permits only metadata consent bootstrap on the plain import URL", () => {
    const target = { location: { pathname: "/openchat/import", hash: "", search: "" },
      history: { state: null, replaceState() {} } } as unknown as Pick<Window, "location" | "history">;
    captureLocalImportLaunch(target);
    expect(localImportNativeBootstrap()).toBe(true); expect(localImportSessionNonce()).toBeUndefined();
    target.location.search = "?senderOrigin=http://localhost:5191";
    captureLocalImportLaunch(target); expect(localImportNativeBootstrap()).toBe(false);
    target.location.search = ""; target.location.hash = "#connectionId=anything";
    captureLocalImportLaunch(target); expect(localImportNativeBootstrap()).toBe(false);
    target.location.hash = ""; target.location.pathname = "/";
    captureLocalImportLaunch(target); expect(localImportNativeBootstrap()).toBe(false);
  });
});
