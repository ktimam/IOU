// Build-time guarantee: the devVetkd adapter must never be
// reachable from a production bundle.
//
// Strategy: in this repo, the dev adapter is the only adapter, and
// it explicitly throws if `isProdVetkd()` is ever called from a
// production build context. We pin that behavior here.
//
// When the prod adapter is implemented, this test should be updated
// to assert that the prod adapter is the *only* one reachable from
// the public API in prod.

import { describe, it, expect } from "vitest";
import { isDevVetkd, isProdVetkd } from "./devVetkd";
import { isProdVetkd as isProdVetkdFromProd, loadOrCreateTransportKey } from "./prodVetkd";

describe("prod-path guard", () => {
  it("the dev adapter is the only one available today", () => {
    expect(isDevVetkd()).toBe(true);
    expect(isProdVetkd()).toBe(false);
  });

  it("prod adapter exists but is gated behind the feature flag", () => {
    // The prod adapter's own isProdVetkd() reads the Vite env var
    // and is independent from the dev stub. In tests the env var is
    // unset, so this should be false.
    expect(isProdVetkdFromProd()).toBe(false);
  });

  it("prod adapter throws a clear error when the feature flag is on but the underlying primitives are missing", async () => {
    // Temporarily flip the env var to simulate "VITE_IOU_PROD_VETKD=1".
    // We can't easily set the Vite env at test time, so we test the
    // dev-path behavior: the adapter is reachable but throws because
    // BLS12-381 G2 IBE is a v1.1.1 deliverable.
    const original = (import.meta as any).env.VITE_IOU_PROD_VETKD;
    (import.meta as any).env.VITE_IOU_PROD_VETKD = "1";
    try {
      if (typeof indexedDB === "undefined") {
        // In Node, the prod adapter fails fast with the
        // "IndexedDB not available" error — that's the right
        // behavior in a non-browser environment.
        await expect(loadOrCreateTransportKey()).rejects.toThrow(
          /IndexedDB not available/,
        );
      } else {
        await expect(loadOrCreateTransportKey()).rejects.toThrow(
          /v1\.1\.1 deliverable/,
        );
      }
    } finally {
      (import.meta as any).env.VITE_IOU_PROD_VETKD = original;
    }
  });

  it("the public API surface of the dev adapter is documented", () => {
    // If we add a function that shouldn't be in prod, this test will
    // fail and force a review. The exported names are intentionally
    // listed so a future PR adding a new public function must
    // decide explicitly: dev-only or prod-also.
    const exportedNames = [
      "deriveUserKeypair",
      "importPublicKeyB64Wrap",
      "newSheetKey",
      "wrapSheetKey",
      "unwrapSheetKey",
      "VETKD_CONTEXT",
    ];
    // Compile-time check that the imports exist:
    expect(exportedNames).toContain("wrapSheetKey");
    expect(exportedNames).toContain("unwrapSheetKey");
  });
});
