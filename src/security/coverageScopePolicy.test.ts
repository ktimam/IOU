import { describe, expect, it } from "vitest";
import {
  SECURITY_CRITICAL_COVERAGE_EXCLUDE,
  SECURITY_CRITICAL_COVERAGE_INCLUDE,
} from "../../vitest.config";

function isIncluded(file: string): boolean {
  return SECURITY_CRITICAL_COVERAGE_INCLUDE.some((pattern) => {
    if (!pattern.endsWith("/*.ts")) return pattern === file;
    const prefix = pattern.slice(0, -4);
    const relative = file.startsWith(prefix) ? file.slice(prefix.length) : "";
    return relative.length > 0 && !relative.includes("/") && relative.endsWith(".ts");
  });
}

function isExcluded(file: string): boolean {
  return (
    file.endsWith(".test.ts") ||
    file.endsWith(".d.ts") ||
    file.startsWith("src/declarations/") ||
    file === "src/features/openchat/ecTestKit.ts"
  );
}

describe("security-critical coverage scope policy", () => {
  it("includes representative security and runtime modules", () => {
    for (const file of [
      "src/backend/declarations.ts",
      "src/features/crypto/prodVetkd.ts",
      "src/features/storage/scopedStorage.ts",
      "src/features/relay/relay.ts",
      "src/features/openchat/cardBridge.ts",
      "src/features/openchat/consumerKeypair.ts",
      "src/features/entries/csvExport.ts",
      "src/features/entries/decryptEntries.ts",
      "src/features/entries/closingBalances.ts",
      "src/features/flows/createSheet.ts",
      "src/features/invite/acceptInvite.ts",
      "src/security/dependencyAuditPolicy.ts",
    ]) {
      expect(isIncluded(file), file).toBe(true);
      expect(isExcluded(file), file).toBe(false);
    }
  });

  it("excludes tests, generated declarations, and test helpers", () => {
    expect(SECURITY_CRITICAL_COVERAGE_EXCLUDE).toEqual(
      expect.arrayContaining([
        "src/**/*.test.ts",
        "src/**/*.d.ts",
        "src/declarations/**",
        "src/features/openchat/ecTestKit.ts",
      ]),
    );
    for (const file of [
      "src/features/crypto/prodVetkd.test.ts",
      "src/declarations/iou_backend/iou_backend.did.js",
      "src/features/openchat/ecTestKit.ts",
    ]) {
      expect(isExcluded(file), file).toBe(true);
    }
  });

  it("cannot include operational scripts or generated Android bundles", () => {
    for (const file of [
      "scripts/awa-smoke.ts",
      "android/app/src/main/assets/public/assets/index.js",
    ]) {
      expect(isIncluded(file), file).toBe(false);
    }
  });
});
