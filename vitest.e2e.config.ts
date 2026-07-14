import { defineConfig } from "vitest/config";

// E2E layer: drives the LIVE local replica (multi-identity), kept separate from
// the deterministic unit suite (vitest.config.ts). Runs single-file at a time
// with a generous timeout because every call is a real replica round-trip.
// The suite self-skips (see test/e2e/env.ts) when the replica isn't up.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/e2e/**/*.e2e.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
