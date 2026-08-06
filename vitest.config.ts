import { defineConfig } from "vitest/config";

export const SECURITY_CRITICAL_COVERAGE_INCLUDE: string[] = [
  "src/backend/declarations.ts",
  "src/features/crypto/*.ts",
  "src/features/storage/*.ts",
  "src/features/relay/relay.ts",
  "src/features/openchat/*.ts",
  "src/features/openchat/*.tsx",
  "src/features/entries/csvExport.ts",
  "src/features/entries/decryptEntries.ts",
  "src/features/entries/closingBalances.ts",
  "src/features/entries/resolveTemplateBase.ts",
  "src/features/flows/createSheet.ts",
  "src/features/flows/grantPartnerAccess.ts",
  "src/features/flows/inviteLink.ts",
  "src/features/flows/useActor.ts",
  "src/features/flows/useMyKeypair.ts",
  "src/features/invite/acceptInvite.ts",
  "src/security/*.ts",
];

export const SECURITY_CRITICAL_COVERAGE_EXCLUDE: string[] = [
  "src/**/*.test.ts",
  "src/**/*.test.tsx",
  "src/**/*.d.ts",
  "src/declarations/**",
  "src/features/openchat/ecTestKit.ts",
];

export default defineConfig({
  // Vite statically replaces import.meta.env at transform time, before
  // Vitest's process env is installed. Pin the unit build explicitly while
  // .env.local remains production-vetKD for the real four-profile runtime.
  define: {
    "import.meta.env.VITE_IOU_PROD_VETKD": JSON.stringify("0"),
  },
  test: {
    environment: "node",
    // The four-profile runtime deliberately uses production vetKD locally.
    // Unit fixtures remain deterministic/dev-mode unless a test explicitly
    // exercises or stubs the production adapter.
    env: { VITE_IOU_PROD_VETKD: "0" },
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      include: SECURITY_CRITICAL_COVERAGE_INCLUDE,
      exclude: SECURITY_CRITICAL_COVERAGE_EXCLUDE,
      thresholds: {
        statements: 70,
        branches: 80,
        functions: 80,
        lines: 70,
      },
    },
  },
});
