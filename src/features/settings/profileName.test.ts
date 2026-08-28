import { describe, expect, it, vi } from "vitest";
import {
  decodeStoredProfileName,
  encryptProfileName,
  LEGACY_PLAINTEXT_DISPLAY_NAME_IV,
  profileNameHydrationIsCurrent,
  reconcileProfileName,
  synchronizeProfileName,
  type ProfileNameActor,
} from "./profileName";

const key = new Uint8Array(32).fill(19);

describe("canister-backed profile name", () => {
  it("stores only AES-GCM ciphertext and round-trips Unicode names", async () => {
    const stored = await encryptProfileName("Mickey موسى", key);
    expect(stored.displayNameIv).toHaveLength(12);
    expect(new TextDecoder().decode(stored.wrappedDisplayName)).not.toContain("Mickey");

    await expect(
      decodeStoredProfileName(
        {
          wrapped_display_name: stored.wrappedDisplayName,
          display_name_iv: stored.displayNameIv,
        },
        key,
      ),
    ).resolves.toEqual({ kind: "encrypted", name: "Mickey موسى" });
  });

  it("classifies the obsolete plaintext sentinel for immediate encrypted migration", async () => {
    await expect(
      decodeStoredProfileName(
        {
          wrapped_display_name: new TextEncoder().encode("Mickey"),
          display_name_iv: new TextEncoder().encode(LEGACY_PLAINTEXT_DISPLAY_NAME_IV),
        },
        key,
      ),
    ).resolves.toEqual({ kind: "legacy_plaintext", name: "Mickey" });
  });

  it("never lets an empty, malformed, or undecryptable remote record erase a local name", async () => {
    expect(reconcileProfileName({ kind: "absent" }, "Mickey")).toEqual({
      use: "Mickey",
      push: "Mickey",
    });
    expect(reconcileProfileName({ kind: "invalid" }, "Mickey")).toEqual({ use: "Mickey" });

    await expect(
      decodeStoredProfileName(
        { wrapped_display_name: [1, 2, 3], display_name_iv: new Uint8Array(12) },
        key,
      ),
    ).resolves.toEqual({ kind: "invalid" });
  });

  it("keeps encrypted canister state authoritative", () => {
    expect(reconcileProfileName({ kind: "encrypted", name: "Remote" }, "Local")).toEqual({
      use: "Remote",
    });
  });

  it("prefers a valid local cache only during legacy plaintext migration", () => {
    expect(
      reconcileProfileName({ kind: "legacy_plaintext", name: "Legacy" }, "New local"),
    ).toEqual({ use: "New local", push: "New local" });
    expect(
      reconcileProfileName({ kind: "legacy_plaintext", name: "Legacy" }, ""),
    ).toEqual({ use: "Legacy", push: "Legacy" });
    expect(
      reconcileProfileName({ kind: "legacy_plaintext", name: "Legacy" }, "x".repeat(33)),
    ).toEqual({ use: "Legacy", push: "Legacy" });
  });

  it("migrates a browser-only name through the actor as ciphertext, never plaintext", async () => {
    const setDisplayName = vi.fn(async () => undefined);
    const actor = {
      get_my_user: vi.fn(async () => []),
      set_display_name: setDisplayName,
      vetkd_public_key: vi.fn(async () => []),
      vetkd_wrap_consumer_key: vi.fn(async () => []),
    } as ProfileNameActor;

    await expect(
      synchronizeProfileName(actor, "profile-sync-principal", "Mickey"),
    ).resolves.toEqual({ use: "Mickey", push: "Mickey" });

    expect(setDisplayName).toHaveBeenCalledOnce();
    const [ciphertext, iv] = (
      setDisplayName.mock.calls as unknown as [number[], number[]][]
    )[0];
    expect(iv).toHaveLength(12);
    expect(new TextDecoder().decode(Uint8Array.from(ciphertext))).not.toContain("Mickey");
  });

  it("rewrites a legacy record with the newer valid local name as ciphertext", async () => {
    const setDisplayName = vi.fn(async () => undefined);
    const actor = {
      get_my_user: vi.fn(async () => [{
        wrapped_display_name: new TextEncoder().encode("Legacy"),
        display_name_iv: new TextEncoder().encode(LEGACY_PLAINTEXT_DISPLAY_NAME_IV),
      }]),
      set_display_name: setDisplayName,
      vetkd_public_key: vi.fn(async () => []),
      vetkd_wrap_consumer_key: vi.fn(async () => []),
    } as ProfileNameActor;

    await expect(
      synchronizeProfileName(actor, "legacy-conflict-principal", "New local"),
    ).resolves.toEqual({ use: "New local", push: "New local" });

    const [ciphertext, iv] = (
      setDisplayName.mock.calls as unknown as [number[], number[]][]
    )[0];
    expect(iv).toHaveLength(12);
    expect(new TextDecoder().decode(Uint8Array.from(ciphertext))).not.toContain("New local");
  });

  it("does not push a stale cache or write after a failed remote read", async () => {
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let currentLocal = "Old";
    const staleWrite = vi.fn(async () => undefined);
    const staleActor = {
      get_my_user: vi.fn(async () => {
        await readGate;
        return [];
      }),
      set_display_name: staleWrite,
      vetkd_public_key: vi.fn(async () => []),
      vetkd_wrap_consumer_key: vi.fn(async () => []),
    } as ProfileNameActor;
    const hydration = synchronizeProfileName(
      staleActor,
      "stale-profile-principal",
      "Old",
      () => profileNameHydrationIsCurrent("Old", currentLocal),
    );
    currentLocal = "Typing a new name";
    releaseRead();
    await hydration;
    expect(profileNameHydrationIsCurrent("Old", currentLocal)).toBe(false);
    expect(staleWrite).not.toHaveBeenCalled();

    const failedWrite = vi.fn(async () => undefined);
    const failedActor = {
      get_my_user: vi.fn(async () => {
        throw new Error("offline");
      }),
      set_display_name: failedWrite,
      vetkd_public_key: vi.fn(async () => []),
      vetkd_wrap_consumer_key: vi.fn(async () => []),
    } as ProfileNameActor;
    await expect(
      synchronizeProfileName(failedActor, "failed-profile-principal", "Keep me"),
    ).rejects.toThrow("offline");
    expect(failedWrite).not.toHaveBeenCalled();
  });

  it("rechecks freshness after asynchronous encryption and before writing", async () => {
    let releaseEncryption!: () => void;
    let encryptionStarted!: () => void;
    const encryptionGate = new Promise<void>((resolve) => {
      releaseEncryption = resolve;
    });
    const started = new Promise<void>((resolve) => {
      encryptionStarted = resolve;
    });
    const originalEncrypt = globalThis.crypto.subtle.encrypt.bind(globalThis.crypto.subtle);
    const encryptSpy = vi
      .spyOn(globalThis.crypto.subtle, "encrypt")
      .mockImplementation(async (algorithm, cryptoKey, data) => {
        encryptionStarted();
        await encryptionGate;
        return originalEncrypt(algorithm, cryptoKey, data);
      });
    let currentLocal = "Old";
    const staleWrite = vi.fn(async () => undefined);
    const actor = {
      get_my_user: vi.fn(async () => []),
      set_display_name: staleWrite,
      vetkd_public_key: vi.fn(async () => []),
      vetkd_wrap_consumer_key: vi.fn(async () => []),
    } as ProfileNameActor;

    try {
      const hydration = synchronizeProfileName(
        actor,
        "encrypt-race-principal",
        "Old",
        () => profileNameHydrationIsCurrent("Old", currentLocal),
      );
      await started;
      currentLocal = "New";
      releaseEncryption();
      await hydration;
      expect(staleWrite).not.toHaveBeenCalled();
    } finally {
      releaseEncryption();
      encryptSpy.mockRestore();
    }
  });
});
