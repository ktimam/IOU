import { describe, it, expect } from "vitest";
import { IDL } from "@dfinity/candid";
import { buildIdl, buildManifestWire } from "./registerAiApp";
import { iouActionManifest } from "./actionManifest";

const FAKE_PEM = "-----BEGIN PUBLIC KEY-----\nMFkw...\n-----END PUBLIC KEY-----\n";

describe("buildManifestWire", () => {
  it("accepts an EMPTY app-level key for the per-user-keys manifest (zero-input registration)", () => {
    // Precondition of the whole zero-input flow: IOU's manifest uses per-user delivery keys.
    expect(iouActionManifest.perUserKeys).toBe(true);

    const manifest = buildManifestWire("", () => {});
    expect(manifest.consumer_public_key).toBe("");
    expect(manifest.per_user_keys).toBe(true);
  });

  it("still carries an explicit app-level key when one is supplied (legacy path)", () => {
    const manifest = buildManifestWire(FAKE_PEM, () => {});
    expect(manifest.consumer_public_key).toBe(FAKE_PEM);
    expect(manifest.per_user_keys).toBe(true);
  });

  it("candid-encodes the empty-key manifest against the register_ai_app IDL", () => {
    const manifest = buildManifestWire("", () => {});
    const { RegisterAiAppArgs } = buildIdl();
    const encoded = IDL.encode([RegisterAiAppArgs], [{ manifest }]);
    expect(encoded.byteLength).toBeGreaterThan(0);
  });
});
