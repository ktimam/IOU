import type { Identity } from "@dfinity/agent";
import type { AuthClientLoginOptions } from "@dfinity/auth-client";
import { Principal } from "@dfinity/principal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthSession, delegationExpiresAt, REQUESTED_DELEGATION_TTL } from "./authSession";

const USER = "aaaaa-aa";
const OTHER = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const NOW = 1_800_000_000_000;
function identity(principal = USER, expirations?: bigint[]): Identity {
  return {
    getPrincipal: () => Principal.fromText(principal),
    ...(expirations ? { getDelegation: () => ({ delegations: expirations.map(expiration => ({ delegation: { expiration } })) }) } : {}),
  } as Identity;
}
const expires = (milliseconds: number) => BigInt(milliseconds) * 1_000_000n;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function flush() { for (let index = 0; index < 12; index++) await Promise.resolve(); }
function fixture(current = identity(USER, [expires(NOW + 3_600_000)])) {
  let login: AuthClientLoginOptions | undefined;
  const client = {
    isAuthenticated: vi.fn(async () => true),
    getIdentity: vi.fn(() => current),
    login: vi.fn(async (options: AuthClientLoginOptions) => { login = options; }),
    logout: vi.fn(async () => {}),
  };
  const options = {
    createClient: vi.fn(async () => client),
    onState: vi.fn(),
    restoreDevIdentity: vi.fn<() => Identity | null>(() => null),
    createDevIdentity: vi.fn(() => identity(OTHER)),
    forgetDevIdentity: vi.fn(),
    clearMemory: vi.fn(),
    clearDevice: vi.fn(async (_principal: string) => {}),
  };
  const session = new AuthSession(options);
  return { session, client, options, succeed: () => (login!.onSuccess as () => void)() };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

describe("remembered authentication", () => {
  it("restores the SDK session with idle logout disabled and stays signed in beyond ten minutes", async () => {
    const { session, client, options } = fixture();
    await session.restore();
    expect(options.createClient).toHaveBeenCalledWith({ idleOptions: { disableIdle: true } });
    expect(session.state).toMatchObject({ kind: "authenticated", principal: USER });
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(session.state.kind).toBe("authenticated");
    expect(client.login).not.toHaveBeenCalled();
    expect(client.logout).not.toHaveBeenCalled();
    expect(options.clearDevice).not.toHaveBeenCalled();
    session.suspend();
  });

  it("preserves SDK persistence across an app close/restart without a login or device erase", async () => {
    const { session, client, options } = fixture();
    await session.restore();
    session.suspend();
    const restarted = new AuthSession(options);
    await restarted.restore();
    expect(restarted.state).toMatchObject({ kind: "authenticated", principal: USER });
    expect(options.createClient).toHaveBeenCalledTimes(2);
    expect(client.login).not.toHaveBeenCalled();
    expect(client.logout).not.toHaveBeenCalled();
    expect(options.clearDevice).not.toHaveBeenCalled();
    restarted.suspend();
  });

  it("expires at the shortest actually granted delegation, retaining the protected device cache", async () => {
    const { session, client, options } = fixture(identity(USER, [expires(NOW + 60_000), expires(NOW + 1_000)]));
    await session.restore();
    await vi.advanceTimersByTimeAsync(999);
    expect(session.state.kind).toBe("authenticated");
    await vi.advanceTimersByTimeAsync(1);
    expect(session.state.kind).toBe("anonymous");
    expect(client.logout).toHaveBeenCalledOnce();
    expect(options.clearMemory).toHaveBeenCalled();
    expect(options.clearDevice).not.toHaveBeenCalled();
    expect(client.login).not.toHaveBeenCalled();
  });

  it("rechecks expiry when a suspended browser resumes, without waiting for a throttled timer", async () => {
    const { session, options } = fixture();
    await session.restore();
    vi.setSystemTime(NOW + 3_600_001);
    session.checkExpiry();
    expect(session.state.kind).toBe("anonymous");
    expect(options.clearDevice).not.toHaveBeenCalled();
    await flush();
  });

  it("schedules delegations longer than the browser's maximum timer delay without premature expiry", async () => {
    const lifetime = 30 * 24 * 60 * 60_000;
    const { session, client } = fixture(identity(USER, [expires(NOW + lifetime)]));
    await session.restore();
    await vi.advanceTimersByTimeAsync(2_147_483_647);
    expect(session.state.kind).toBe("authenticated");
    expect(client.logout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(lifetime - 2_147_483_647);
    expect(session.state.kind).toBe("anonymous");
  });

  it("rejects an already-expired restored delegation even if the SDK check raced its expiry", async () => {
    const { session, options, client } = fixture(identity(USER, [expires(NOW)]));
    await session.restore();
    await flush();
    expect(session.state.kind).toBe("anonymous");
    expect(options.onState.mock.calls.some(([state]) => state.kind === "authenticated")).toBe(false);
    expect(client.logout).toHaveBeenCalledOnce();
    expect(options.clearDevice).not.toHaveBeenCalled();
  });

  it("does not automatically start login or key recovery for an absent SDK session", async () => {
    const { session, client, options } = fixture();
    client.isAuthenticated.mockResolvedValue(false);
    await session.restore();
    expect(session.state.kind).toBe("anonymous");
    expect(client.login).not.toHaveBeenCalled();
    expect(client.logout).not.toHaveBeenCalled();
    expect(options.clearDevice).not.toHaveBeenCalled();
  });

  it("explicit sign-out immediately locks the UI and clears both SDK persistence and this principal's vault", async () => {
    const { session, client, options } = fixture();
    await session.restore();
    const cleanup = deferred<void>();
    options.clearDevice.mockReturnValueOnce(cleanup.promise);
    const result = session.signOut();
    expect(session.state.kind).toBe("anonymous");
    await flush();
    expect(client.logout).toHaveBeenCalledOnce();
    expect(options.clearDevice).toHaveBeenCalledExactlyOnceWith(USER);
    expect(options.forgetDevIdentity).toHaveBeenCalledOnce();
    cleanup.resolve();
    await result;
  });

  it("still erases SDK auth and stays locked when vault cleanup fails, reporting the failure", async () => {
    const { session, client, options } = fixture();
    await session.restore();
    options.clearDevice.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(session.signOut()).rejects.toThrow("storage unavailable");
    expect(client.logout).toHaveBeenCalledOnce();
    expect(session.state.kind).toBe("anonymous");
  });

  it("does not restore stale authentication after a concurrent sign-out", async () => {
    const { session, client, options } = fixture();
    const check = deferred<boolean>();
    client.isAuthenticated.mockReturnValueOnce(check.promise);
    const restored = session.restore();
    await flush();
    await session.signOut();
    check.resolve(true);
    await restored;
    expect(session.state.kind).toBe("anonymous");
    expect(options.onState.mock.calls.some(([state]) => state.kind === "authenticated")).toBe(false);
  });

  it("erases a late II success after sign-out, instead of restoring auth or accepting a second popup", async () => {
    const { session, client, options, succeed } = fixture();
    client.isAuthenticated.mockResolvedValue(false);
    await session.restore();
    const login = session.signIn({ identityProvider: "https://identity.example", maxTimeToLive: REQUESTED_DELEGATION_TTL });
    const rejected = expect(login).rejects.toThrow("cancelled");
    await flush();
    await session.signOut();
    expect(session.signIn({})).toBe(login);
    succeed();
    await rejected;
    expect(client.login).toHaveBeenCalledOnce();
    expect(client.logout).toHaveBeenCalledTimes(2);
    expect(session.state.kind).toBe("anonymous");
    expect(options.onState.mock.calls.some(([state]) => state.kind === "authenticated")).toBe(false);
  });

  it("uses a fresh SDK client after explicit sign-out so the next session key is persisted", async () => {
    const { session, client, options, succeed } = fixture();
    await session.restore();
    await session.signOut();
    const login = session.signIn({});
    await flush();
    expect(options.createClient).toHaveBeenCalledTimes(2);
    succeed();
    await login;
    expect(session.state.kind).toBe("authenticated");
    expect(client.login).toHaveBeenCalledOnce();
    session.suspend();
  });

  it("drops a late restore after unmount and permits the StrictMode replacement restore", async () => {
    const { session, client, options } = fixture();
    const check = deferred<boolean>();
    client.isAuthenticated.mockReturnValueOnce(check.promise);
    const first = session.restore();
    await flush();
    session.suspend();
    await session.restore();
    const calls = options.onState.mock.calls.length;
    check.resolve(true);
    await first;
    expect(options.onState).toHaveBeenCalledTimes(calls);
    expect(session.state.kind).toBe("authenticated");
    session.suspend();
  });

  it("invalidates in-memory keys when switching accounts but does not erase another device cache", async () => {
    const { session, options } = fixture();
    await session.restore();
    options.clearMemory.mockClear();
    session.signInDev();
    expect(session.state).toMatchObject({ kind: "authenticated", principal: OTHER });
    expect(options.clearMemory).toHaveBeenCalledOnce();
    expect(options.clearDevice).not.toHaveBeenCalled();
    session.suspend();
  });

  it("fails closed on SDK storage errors", async () => {
    const { session, options } = fixture();
    options.createClient.mockRejectedValueOnce(new Error("IndexedDB unavailable"));
    await session.restore();
    expect(session.state.kind).toBe("anonymous");
    expect(options.clearMemory).toHaveBeenCalled();
  });

  it("purges matching device storage before checking a fresh SDK client after cross-tab logout", async () => {
    const { session, client, options } = fixture();
    await session.restore();
    options.clearMemory.mockClear();
    client.isAuthenticated.mockResolvedValue(false);
    const refresh = session.refreshAfterRemoteSignOut(USER);
    expect(session.state.kind).toBe("anonymous");
    expect(options.clearMemory).toHaveBeenCalled();
    await refresh;
    expect(options.createClient).toHaveBeenCalledTimes(2);
    expect(client.logout).not.toHaveBeenCalled();
    expect(options.clearDevice).toHaveBeenCalledExactlyOnceWith(USER);
    expect(session.state.kind).toBe("anonymous");
  });

  it("removes a late cross-tab device write before the SDK can restore authentication", async () => {
    const { session, client, options } = fixture();
    await session.restore();
    let lateDeviceRecord = false;
    const finishPurge = deferred<void>();
    options.clearDevice.mockImplementationOnce(async principal => {
      expect(principal).toBe(USER);
      await finishPurge.promise;
      lateDeviceRecord = false;
    });
    options.createClient.mockImplementationOnce(async () => {
      expect(lateDeviceRecord).toBe(false);
      return client;
    });
    client.isAuthenticated.mockResolvedValue(false);
    const remoteLogout = session.refreshAfterRemoteSignOut(USER);
    expect(session.state.kind).toBe("anonymous");
    expect(options.createClient).toHaveBeenCalledOnce();
    lateDeviceRecord = true; // A queued write committed after the first tab's deletion.
    finishPurge.resolve();
    await remoteLogout;
    expect(lateDeviceRecord).toBe(false);
    expect(options.createClient).toHaveBeenCalledTimes(2);
    expect(client.logout).not.toHaveBeenCalled();
  });

  it("does not overwrite a new account while awaiting the previous account's remote purge", async () => {
    const { session, options } = fixture();
    await session.restore();
    const finishPurge = deferred<void>();
    options.clearDevice.mockReturnValueOnce(finishPurge.promise);
    const remoteLogout = session.refreshAfterRemoteSignOut(USER);
    session.signInDev();
    finishPurge.resolve();
    await remoteLogout;
    expect(session.state).toMatchObject({ kind: "authenticated", principal: OTHER });
    expect(options.clearDevice).toHaveBeenCalledExactlyOnceWith(USER);
    expect(options.createClient).toHaveBeenCalledOnce();
    session.suspend();
  });

  it("stays locked without re-reading SDK auth if a remote device purge fails", async () => {
    const { session, options, client } = fixture();
    await session.restore();
    options.clearDevice.mockRejectedValueOnce(new Error("device storage unavailable"));
    await expect(session.refreshAfterRemoteSignOut(USER)).rejects.toThrow("device storage unavailable");
    expect(session.state.kind).toBe("anonymous");
    expect(options.createClient).toHaveBeenCalledOnce();
    expect(client.logout).not.toHaveBeenCalled();
  });

  it("does not erase, recheck or lock an unrelated account on cross-tab logout", async () => {
    const { session, client, options } = fixture();
    await session.restore();
    options.clearMemory.mockClear();
    await session.refreshAfterRemoteSignOut(OTHER);
    expect(session.state).toMatchObject({ kind: "authenticated", principal: USER });
    expect(options.createClient).toHaveBeenCalledOnce();
    expect(options.clearMemory).not.toHaveBeenCalled();
    expect(options.clearDevice).not.toHaveBeenCalled();
    expect(client.logout).not.toHaveBeenCalled();
    session.suspend();
  });
});

describe("delegation expiry parsing", () => {
  it("uses the shortest nanosecond expiry", () => {
    expect(delegationExpiresAt(identity(USER, [expires(NOW + 9), expires(NOW + 4)]))).toBe(NOW + 4);
  });
  it("leaves non-delegated development identities untimed", () => {
    expect(delegationExpiresAt(identity())).toBeUndefined();
  });
  it.each([[], [0n], [-1n], [1n << 100n]].map(expirations => ({ expirations })))("rejects invalid delegation chains $expirations", ({ expirations }) => {
    expect(delegationExpiresAt(identity(USER, expirations))).toBe(0);
  });
});
