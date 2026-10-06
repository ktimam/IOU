import { describe, expect, it } from "vitest";
import { localAppSenderWindow } from "./localAppSender";

describe("app sender WindowProxy selection", () => {
  it("uses only the embedding parent when framed, not another opener", () => {
    const parent = { closed: false }, opener = { closed: false };
    expect(localAppSenderWindow({ parent, opener } as unknown as Window)).toBe(parent);
  });
  it("uses the original opener for a top-level receiver", () => {
    const opener = { closed: false }, target = { opener } as Window;
    Object.assign(target, { parent: target });
    expect(localAppSenderWindow(target)).toBe(opener);
  });
  it("does not replace a closed parent with an unrelated opener", () => {
    expect(localAppSenderWindow({ parent: { closed: true }, opener: { closed: false } } as unknown as Window)).toBeUndefined();
  });
  it("returns no source for a directly visited top-level page", () => {
    const target = { opener: null } as Window;
    Object.assign(target, { parent: target });
    expect(localAppSenderWindow(target)).toBeUndefined();
  });
});
