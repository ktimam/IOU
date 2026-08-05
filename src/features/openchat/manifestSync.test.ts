// Pins static public manifest refresh without any private template argument:
// the sync DECISION (shouldSyncOpenChatManifest), the participation STATE reader
// (readManifestSyncState), and the decision-and-fire seam (maybeSyncManifest) that the callers use.
//
// The connect-only case (claim-token Connect, never the separate "Link to OpenChat")
// must still refresh app metadata and inbox routing.

import { describe, it, expect, vi } from "vitest";
import type { Identity } from "@dfinity/agent";
import {
  shouldSyncOpenChatManifest,
  readManifestSyncState,
  maybeSyncManifest,
} from "./manifestSync";
import { OC_LINKED_KEY, OC_CONNECTED_KEY } from "./ocConfig";

const ME = "aaaaa-aa";
const OTHER = "bbbbb-bb";

const fakeIdentity = (p: string): Identity =>
  ({ getPrincipal: () => ({ toText: () => p }) }) as unknown as Identity;

const fakeLs = (entries: Record<string, string>) => ({
  getItem: (k: string): string | null => (k in entries ? entries[k] : null),
});

describe("shouldSyncOpenChatManifest", () => {
  it("syncs when the user explicitly linked as this principal", () => {
    expect(shouldSyncOpenChatManifest({ myPrincipal: ME, linkedPrincipal: ME, connected: false })).toBe(true);
  });

  it("syncs a CONNECTED user even when they never explicitly Linked (the fresh-start bug)", () => {
    expect(shouldSyncOpenChatManifest({ myPrincipal: ME, linkedPrincipal: null, connected: true })).toBe(true);
  });

  it("does NOT sync a user who is neither linked nor connected", () => {
    expect(shouldSyncOpenChatManifest({ myPrincipal: ME, linkedPrincipal: null, connected: false })).toBe(false);
  });

  it("does NOT sync when the link flag belongs to a DIFFERENT principal (stale flag)", () => {
    expect(shouldSyncOpenChatManifest({ myPrincipal: ME, linkedPrincipal: OTHER, connected: false })).toBe(false);
  });
});

describe("readManifestSyncState", () => {
  it("reports connected when OC_CONNECTED_KEY matches this principal", () => {
    const st = readManifestSyncState(ME, fakeLs({ [OC_CONNECTED_KEY]: ME }));
    expect(st).toEqual({ myPrincipal: ME, linkedPrincipal: null, connected: true });
  });

  it("reports linked from OC_LINKED_KEY", () => {
    const st = readManifestSyncState(ME, fakeLs({ [OC_LINKED_KEY]: ME }));
    expect(st.linkedPrincipal).toBe(ME);
    expect(st.connected).toBe(false);
  });

  it("connected is false when the connect flag belongs to a different principal", () => {
    const st = readManifestSyncState(ME, fakeLs({ [OC_CONNECTED_KEY]: OTHER }));
    expect(st.connected).toBe(false);
  });

  it("neither flag set → not linked, not connected", () => {
    const st = readManifestSyncState(ME, fakeLs({}));
    expect(st).toEqual({ myPrincipal: ME, linkedPrincipal: null, connected: false });
  });
});

describe("maybeSyncManifest (caller wiring)", () => {
  it("CONNECT-only user's refresh invokes a static registration with no private template argument", async () => {
    // Rest params so the mock's calls tuple is typed unknown[] (arg-less vi.fn types it []).
    const register = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
    const res = await maybeSyncManifest(fakeIdentity(ME), register, {
      myPrincipal: ME, linkedPrincipal: null, connected: true,
    });
    expect(res).toBe("synced");
    expect(register).toHaveBeenCalledOnce();
    expect(register.mock.calls[0]).toHaveLength(1);
  });

  it("linked user syncs too", async () => {
    const register = vi.fn(async () => ({ ok: true }));
    const res = await maybeSyncManifest(fakeIdentity(ME), register, {
      myPrincipal: ME, linkedPrincipal: ME, connected: false,
    });
    expect(res).toBe("synced");
    expect(register).toHaveBeenCalledOnce();
  });

  it("does NOT register a user who neither linked nor connected", async () => {
    const register = vi.fn(async () => ({ ok: true }));
    const res = await maybeSyncManifest(fakeIdentity(ME), register, {
      myPrincipal: ME, linkedPrincipal: null, connected: false,
    });
    expect(res).toBe("skipped");
    expect(register).not.toHaveBeenCalled();
  });

  it("a failed register is reported as error, not thrown (never blocks a save/connect)", async () => {
    const failing = vi.fn(async () => ({ ok: false }));
    const throwing = vi.fn(async () => { throw new Error("user_index unreachable"); });
    const st = { myPrincipal: ME, linkedPrincipal: ME, connected: false };
    expect(await maybeSyncManifest(fakeIdentity(ME), failing, st)).toBe("error");
    expect(await maybeSyncManifest(fakeIdentity(ME), throwing, st)).toBe("error");
  });

  it("no identity → skipped (no register attempt)", async () => {
    const register = vi.fn(async () => ({ ok: true }));
    expect(await maybeSyncManifest(undefined, register)).toBe("skipped");
    expect(register).not.toHaveBeenCalled();
  });
});
