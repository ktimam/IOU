import { describe, expect, it } from "vitest";
import { readAuthLogoutSignal } from "./authLogoutSignal";

describe("cross-tab sign-out notification", () => {
  it("accepts a bounded nonsecret principal notification in both transports", () => {
    const signal = { version: 1, principal: "aaaaa-aa", nonce: "synthetic-event" };
    expect(readAuthLogoutSignal(signal)).toEqual(signal);
    expect(readAuthLogoutSignal(JSON.stringify(signal))).toEqual(signal);
  });
  it.each([null, {}, "not-json", { version: 2 }, { version: 1, principal: "bad", nonce: "x" },
    { version: 1, principal: "aaaaa-aa", nonce: "" }, { version: 1, principal: "aaaaa-aa", nonce: "x".repeat(129) }])("ignores malformed notification %j", value => {
    expect(readAuthLogoutSignal(value)).toBeUndefined();
  });
});
