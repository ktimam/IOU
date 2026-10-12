import { describe, expect, it } from "vitest";
import { validateImageTypeTexts } from "./rawImageSourceDetails";

describe("bounded raw image Type evidence", () => {
  it("preserves a dense safe array exactly, including explicit absence and whitespace", () => {
    expect(validateImageTypeTexts([])).toEqual([]);
    const value = Object.freeze([
      "TEST ONLY",
      "",
      "TEST ONLY",
      "x".repeat(160),
    ]);
    const result = validateImageTypeTexts(value);
    expect(result).toEqual(value);
    expect(result).not.toBe(value);
  });

  it.each([
    null,
    undefined,
    "TEST ONLY",
    {},
    new Array(1),
    ["one", "two", "three", "four", "five"],
    ["x".repeat(161)],
    ["safe", 1],
    ["line\nbreak"],
    ["bidi\u202econtrol"],
    ["unpaired\ud800surrogate"],
  ])("rejects malformed or unsafe evidence atomically: %j", (value) => {
    expect(validateImageTypeTexts(value)).toBeUndefined();
  });

  it("rejects decorated, symbolic, accessor and altered-prototype arrays without reading entries", () => {
    let reads = 0;
    const accessor = Object.defineProperty(["safe"], "0", {
      get() {
        reads++;
        return "TEST ONLY";
      },
    });
    const decorated = Object.assign(["safe"], { extra: true });
    const symbolic = Object.assign(["safe"], { [Symbol("extra")]: true });
    const hidden = Object.defineProperty(["safe"], "0", {
      enumerable: false,
    });
    const altered = ["safe"];
    Object.setPrototypeOf(altered, null);
    const throwing = new Proxy([], {
      getPrototypeOf() {
        throw new Error("trap");
      },
    });
    for (const value of [
      accessor,
      decorated,
      symbolic,
      hidden,
      altered,
      throwing,
    ])
      expect(validateImageTypeTexts(value)).toBeUndefined();
    expect(reads).toBe(0);
  });
});
