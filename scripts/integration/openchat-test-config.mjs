import { existsSync } from "node:fs";
import { join } from "node:path";

// Upstream consolidated package test configuration at frontend/vitest.config.ts.
// Retain support for the older PR checkout without recreating or weakening its config.
export function resolveOpenChatTestConfig(frontend) {
  for (const relative of ["vitest.config.ts", "app/vitest.config.ts"]) {
    const candidate = join(frontend, relative);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Required existing OpenChat Vitest configuration is missing beneath ${frontend}. No tests ran.`);
}
