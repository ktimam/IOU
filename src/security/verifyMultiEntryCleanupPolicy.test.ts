import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  path.join(process.cwd(), "scripts/live/verify-multi-entry.ts"),
  "utf8",
);

describe("multi-entry inbox cleanup policy", () => {
  it("acknowledges only one exact match and retains ambiguous matches", () => {
    expect(source).toContain("if (shouldAcknowledge && matches.length === 1)");
    expect(source).not.toMatch(
      /if \(shouldAcknowledge\)\s*\{\s*for \(const match of matches\)/,
    );
  });
});
