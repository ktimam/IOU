import { defineConfig } from "vitest/config";

// E2E layer: drives the LIVE local replica (multi-identity), kept separate from
// the deterministic unit suite (vitest.config.ts). Runs single-file at a time
// with a generous timeout because every call is a real replica round-trip.
// Missing infrastructure fails closed. IOU_E2E_ALLOW_SKIP=1 is an explicit local-only escape hatch.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/e2e/**/*.e2e.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
