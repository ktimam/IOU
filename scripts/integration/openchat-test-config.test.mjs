import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveOpenChatTestConfig } from "./openchat-test-config.mjs";

function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), "iou-openchat-config-"));
  try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("uses the merged upstream root configuration", () => fixture(dir => {
  const expected = join(dir, "vitest.config.ts");
  writeFileSync(expected, "export default {};");
  assert.equal(resolveOpenChatTestConfig(dir), expected);
}));

test("retains compatibility with the older PR configuration", () => fixture(dir => {
  mkdirSync(join(dir, "app"));
  const expected = join(dir, "app", "vitest.config.ts");
  writeFileSync(expected, "export default {};");
  assert.equal(resolveOpenChatTestConfig(dir), expected);
}));

test("prefers the root configuration when both exist", () => fixture(dir => {
  mkdirSync(join(dir, "app"));
  writeFileSync(join(dir, "app", "vitest.config.ts"), "export default {};");
  const expected = join(dir, "vitest.config.ts");
  writeFileSync(expected, "export default {};");
  assert.equal(resolveOpenChatTestConfig(dir), expected);
}));

test("fails closed without an existing checkout configuration", () => fixture(dir => {
  assert.throws(() => resolveOpenChatTestConfig(dir), /configuration is missing.*No tests ran/);
}));
