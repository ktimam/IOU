// Build-time guarantee: the devVetkd adapter must never be
// reachable from a production bundle.
//
// Strategy: the public API has two adapters (dev + prod), gated by
// the VITE_IOU_PROD_VETKD env var. We pin that behavior here.

import { describe, it, expect } from "vitest";
import { bls12_381 } from "@noble/curves/bls12-381";
import { DerivedPublicKey, augmentedHashToG1 } from "@dfinity/vetkeys";
import { isDevVetkd, isProdVetkd } from "./devVetkd";
import {
  isProdVetkd as isProdVetkdFromProd,
  newTransportKey,
  deriveConsumerWrapKeyProd,
  deriveSheetKey,
  type VetkdTransportKey,
} from "./prodVetkd";

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

// Build the exact 48+96+48-byte envelope returned by vetkd_derive_encrypted_key. This exercises
// EncryptedVetKey.decryptAndVerify rather than mocking away transport-key independence.
function encryptVetKeyForTransport(
  derivedPublicKey: DerivedPublicKey,
  signingSecret: bigint,
  input: Uint8Array,
  transport: VetkdTransportKey,
  randomness: bigint,
): Uint8Array {
  const signature = bls12_381.G1.ProjectivePoint.fromHex(
    augmentedHashToG1(derivedPublicKey, input)
      .multiply(signingSecret)
      .toRawBytes(true),
  );
  const transportPublicKey = bls12_381.G1.ProjectivePoint.fromHex(transport.publicKey);
  const c1 = bls12_381.G1.ProjectivePoint.BASE.multiply(randomness);
  const c2 = bls12_381.G2.ProjectivePoint.BASE.multiply(randomness);
  const c3 = signature.add(transportPublicKey.multiply(randomness));
  return concatBytes(c1.toRawBytes(true), c2.toRawBytes(true), c3.toRawBytes(true));
}

describe("prod-path guard", () => {
  it("the dev adapter is the default", () => {
    expect(isDevVetkd()).toBe(true);
    expect(isProdVetkd()).toBe(false);
  });

  it("prod adapter exists but is gated behind the feature flag", () => {
    expect(isProdVetkdFromProd()).toBe(false);
  });

  it("the feature flag contract is documented", () => {
    // In a Node test environment, import.meta.env is undefined and
    // both adapters default to the dev path. In a Vite build, the
    // env var is replaced at build time and the prod path is taken
    // when VITE_IOU_PROD_VETKD=1.
    //
    // This test pins the default-off behavior. The env-driven
    // branch is exercised at build time (see the vite config and
    // the deploy-prod.sh script).
    expect(isDevVetkd()).toBe(true);
    expect(isProdVetkd()).toBe(false);
    expect(isProdVetkdFromProd()).toBe(false);
  });

  it("newTransportKey generates a valid BLS12-381 G1 transport key (48 bytes compressed)", () => {
    const t = newTransportKey();
    expect(t.secretKey.length).toBe(32);
    expect(t.publicKey.length).toBe(48);
  });

  it("derives the same production user key through two fresh device transport keys", async () => {
    const principal = "rrkah-fqaaa-aaaaa-aaaaq-cai";
    const input = new TextEncoder().encode("iou-consumer:" + principal);
    const signingSecret = 0x1234_5678_9abcn;
    const derivedPublicKeyBytes = bls12_381.G2.ProjectivePoint.BASE
      .multiply(signingSecret)
      .toRawBytes(true);
    const derivedPublicKey = DerivedPublicKey.deserialize(derivedPublicKeyBytes);
    const firstTransport = newTransportKey();
    const secondTransport = newTransportKey();
    expect(firstTransport.publicKey).not.toEqual(secondTransport.publicKey);

    const firstEncrypted = encryptVetKeyForTransport(
      derivedPublicKey,
      signingSecret,
      input,
      firstTransport,
      17n,
    );
    const secondEncrypted = encryptVetKeyForTransport(
      derivedPublicKey,
      signingSecret,
      input,
      secondTransport,
      23n,
    );
    expect(firstEncrypted).not.toEqual(secondEncrypted);

    const firstKey = await deriveConsumerWrapKeyProd(
      principal,
      firstTransport,
      derivedPublicKeyBytes,
      firstEncrypted,
    );
    const secondKey = await deriveConsumerWrapKeyProd(
      principal,
      secondTransport,
      derivedPublicKeyBytes,
      secondEncrypted,
    );
    expect(firstKey).toHaveLength(32);
    expect(secondKey).toEqual(firstKey);
  });

  it("deriveSheetKey signature is the 5-arg form (canisterId is now a no-op)", () => {
    // v1.1.5 added a 5th `canisterId` arg. v1.2.2 made it a no-op
    // (the IC already does the canister+context derivation server-
    // side; the PWA just deserializes the result). We keep the
    // 5-arg signature for source compatibility with existing
    // callers — this test pins the count so a future refactor that
    // drops the arg fails CI. (TypeScript can't pin a parameter
    // count at the type level; .length is the only runtime check
    // available without invoking.)
    expect(deriveSheetKey.length).toBe(5);
  });
});
