import { describe, expect, it } from "vitest";
import { authSessionScope, SessionGeneration } from "./sessionIsolation";

describe("authenticated session isolation", () => {
  it("assigns a distinct remount scope to anonymous and principal sessions", () => {
    expect(authSessionScope("loading")).toBe("loading");
    expect(authSessionScope("anonymous")).toBe("anonymous");
    expect(authSessionScope("authenticated", "principal-a")).toBe(
      "authenticated:principal-a",
    );
    expect(authSessionScope("authenticated", "principal-b")).not.toBe(
      authSessionScope("authenticated", "principal-a"),
    );
  });

  it("rejects and zeroizes a secret completed after its session was invalidated", () => {
    const guard = new SessionGeneration();
    const ticket = guard.capture();
    const secret = new Uint8Array([7, 8, 9]);
    guard.invalidate();
    expect(() => guard.assertCurrent(ticket, secret)).toThrow(
      /authentication changed/i,
    );
    expect([...secret]).toEqual([0, 0, 0]);
  });

  it("supports React StrictMode cleanup and setup without accepting old work", () => {
    const guard = new SessionGeneration();
    const stale = guard.capture();
    guard.invalidate();
    guard.activate();
    const current = guard.capture();
    expect(current).not.toBe(stale);
    expect(() => guard.assertCurrent(current)).not.toThrow();
    expect(() => guard.assertCurrent(stale)).toThrow(/authentication changed/i);
  });
});
