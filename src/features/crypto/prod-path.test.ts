// Build-time guarantee: the devVetkd adapter must never be
// reachable from a production bundle.
//
// Strategy: the public API has two adapters (dev + prod), gated by
// the VITE_IOU_PROD_VETKD env var. We pin that behavior here.

import { describe, it, expect } from "vitest";
import { isDevVetkd, isProdVetkd } from "./devVetkd";
import {
  isProdVetkd as isProdVetkdFromProd,
  newTransportKey,
  deriveSheetKey,
} from "./prodVetkd";

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
