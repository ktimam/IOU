import { describe, expect, it } from "vitest";
import {
  exactPrivateMatchSource,
  privateMatchSourceHashV1,
  uniquePrivateKeywordMatch,
} from "./privateMatchContext";

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("private-match exact source commitment", () => {
  it("matches OpenChat's frozen UTF-8 length-delimited vector", () => {
    expect(hex(privateMatchSourceHashV1("School expense 350 EGP"))).toBe(
      "31c494e1ee6b6f60ce0721675f922496dea4bce13acb276d674c55bf53e1ec89",
    );
  });

  it("binds case, whitespace and embedded NUL exactly", () => {
    const expected = privateMatchSourceHashV1("school expense");
    expect(exactPrivateMatchSource("school expense", expected)).toBe(true);
    expect(exactPrivateMatchSource("School expense", expected)).toBe(false);
    expect(exactPrivateMatchSource("school expense ", expected)).toBe(false);
    expect(exactPrivateMatchSource("school\0expense", expected)).toBe(false);
  });
});

describe("private Saved-type keyword decision", () => {
  it("returns true for exactly one Saved type and fails collisions closed", () => {
    expect(uniquePrivateKeywordMatch([["school", "tuition"], ["groceries"]], "School fee 350")).toBe(true);
    expect(uniquePrivateKeywordMatch([["school"], ["fee"]], "School fee 350")).toBe(false);
    expect(uniquePrivateKeywordMatch([["school"]], "preschooling 350")).toBe(false);
  });

  it("scans every keyword of every type for match, collision and no-match decisions", () => {
    for (const matching of [new Set([0]), new Set([0, 3]), new Set<number>()]) {
      const calls: string[] = [];
      const result = uniquePrivateKeywordMatch(
        [["a", "b"], ["c", "d"]],
        "source",
        (_source, keyword) => {
          calls.push(keyword);
          return matching.has(calls.length - 1);
        },
      );
      expect(calls).toEqual(["a", "b", "c", "d"]);
      expect(result).toBe(matching.size === 1);
    }
  });
});
