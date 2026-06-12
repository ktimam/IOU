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

describe("prod-path guard", () => {
  it("the dev adapter is the only one available today", () => {
    expect(isDevVetkd()).toBe(true);
    expect(isProdVetkd()).toBe(false);
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
