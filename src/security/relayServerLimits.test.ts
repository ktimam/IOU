import { EventEmitter } from "node:events";
import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import {
  BodyTooLargeError,
  FixedWindowRateLimiter,
  canInsertMapKey,
  pruneInactivePairings,
  readBoundedBody,
} from "../../scripts/iou-relay/limits";

function requestDouble(headers: Record<string, string> = {}) {
  return Object.assign(new EventEmitter(), { headers, pause: vi.fn() });
}

describe("relay bounded request bodies", () => {
  it("counts UTF-8 bytes exactly, not JavaScript characters", async () => {
    const exact = requestDouble();
    const exactRead = readBoundedBody(exact as never, 4);
    exact.emit("data", Buffer.from("éé", "utf8"));
    exact.emit("end");
    await expect(exactRead).resolves.toBe("éé");

    const over = requestDouble();
    const overRead = readBoundedBody(over as never, 4);
    const rejected = expect(overRead).rejects.toBeInstanceOf(BodyTooLargeError);
    over.emit("data", Buffer.from("ééé", "utf8"));
    over.emit("end");
    await rejected;
  });

  it("pauses the request and removes body listeners immediately on overflow", async () => {
    const req = requestDouble();
    const read = readBoundedBody(req as never, 4);
    const rejected = expect(read).rejects.toBeInstanceOf(BodyTooLargeError);
    req.emit("data", Buffer.from("12345", "utf8"));
    await rejected;
    expect(req.pause).toHaveBeenCalledOnce();
    expect(req.listenerCount("data")).toBe(0);
    expect(req.listenerCount("end")).toBe(0);
  });

  it("rejects an oversized declared Content-Length before attaching readers", async () => {
    const req = requestDouble({ "content-length": "5" });
    await expect(readBoundedBody(req as never, 4)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(req.pause).toHaveBeenCalledOnce();
    expect(req.listenerCount("data")).toBe(0);
    expect(req.listenerCount("end")).toBe(0);
  });
});

describe("relay global capacity helpers", () => {
  it("allows existing namespaces at capacity but refuses a new arbitrary token", () => {
    const namespaces = new Map([["known", []]]);
    expect(canInsertMapKey(namespaces, "known", 1)).toBe(true);
    expect(canInsertMapKey(namespaces, "attacker-token", 1)).toBe(false);
  });

  it("prunes inactive pairings before capacity is evaluated", () => {
    const pairings = new Map([
      ["old", { last_seen_at: 100 }],
      ["live", { last_seen_at: 950 }],
    ]);
    expect(pruneInactivePairings(pairings, 1_000, 500)).toBe(1);
    expect([...pairings.keys()]).toEqual(["live"]);
  });
});

describe("relay mutation rate limiting", () => {
  it("returns a retry interval after the per-client window is exhausted", () => {
    const limiter = new FixedWindowRateLimiter(2, 1_000, 10);
    expect(limiter.consume("client-a", 100).allowed).toBe(true);
    expect(limiter.consume("client-a", 200).allowed).toBe(true);
    const denied = limiter.consume("client-a", 300);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(800);
    expect(limiter.consume("client-a", 1_100).allowed).toBe(true);
  });

  it("bounds the rate-limit client table itself", () => {
    const limiter = new FixedWindowRateLimiter(5, 1_000, 1);
    expect(limiter.consume("client-a", 0).allowed).toBe(true);
    expect(limiter.consume("client-b", 10).allowed).toBe(false);
    expect(limiter.consume("client-b", 1_001).allowed).toBe(true);
  });
});
