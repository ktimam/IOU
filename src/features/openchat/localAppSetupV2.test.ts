import { describe, expect, it, vi } from "vitest";
import { Principal } from "@dfinity/principal";
import { localSetupAccountId, parseLocalSetupContextV2, serializeLocalSetupResultV2 } from "./localAppSetupV2";
const id = "A".repeat(43), other = "B".repeat(42) + "A";
describe("strict setup-v2 metadata", () => {
  it("parses account and chat scope, keeping optional recovery catalogs", () => {
    const account = { version: 2, scope: "account", accountId: id, routes: [{ handle: id, catalogJson: "{}" }], legacyCatalogJson: "{}" };
    expect(parseLocalSetupContextV2(account)).toEqual(account);
    expect(parseLocalSetupContextV2({ version: 2, scope: "chat", accountId: id, handle: other, catalogJson: "{}" }).scope).toBe("chat");
  });
  it.each([
    { version: 2, scope: "account" }, { version: 2, scope: "account", routes: [], handle: id },
    { version: 2, scope: "chat", accountId: id, handle: id, routes: [] },
    { version: 2, scope: "chat", handle: id }, { version: 2, scope: "account", routes: [], messages: [] },
    { version: 2, scope: "account", routes: [{ handle: id, catalogJson: "{}" }, { handle: id, catalogJson: "{}" }] },
    { version: 2, scope: "account", accountId: "not-canonical", routes: [] },
    { version: 2, scope: "chat", accountId: id, handle: id, legacyCatalogJson: "{}" },
  ])("rejects malformed or excess metadata %j", value => expect(() => parseLocalSetupContextV2(value)).toThrow());
  it("rejects over-budget catalogs and accessor fields without invoking them", () => {
    expect(() => parseLocalSetupContextV2({ version: 2, scope: "account", routes: [], legacyCatalogJson: "x".repeat(1024 * 1024) })).toThrow();
    const getter = vi.fn(() => id), value = { version: 2, scope: "chat", handle: id };
    Object.defineProperty(value, "accountId", { get: getter, enumerable: true });
    expect(() => parseLocalSetupContextV2(value)).toThrow(); expect(getter).not.toHaveBeenCalled();
  });
  it("returns exactly the requested route set and account", () => {
    const context = parseLocalSetupContextV2({ version: 2, scope: "chat", accountId: id, handle: id });
    const result = { version: 2 as const, scope: "chat" as const, appId: "iou" as const, accountId: id, catalogJson: "{}", routes: [{ handle: id, catalogJson: "{}" }] };
    expect(JSON.parse(serializeLocalSetupResultV2(context, result))).toEqual(result);
    expect(() => serializeLocalSetupResultV2(context, { ...result, accountId: other })).toThrow();
    expect(() => serializeLocalSetupResultV2(context, { ...result, routes: [] })).toThrow();
    expect(() => serializeLocalSetupResultV2(context, { ...result, routes: [{ handle: other, catalogJson: "{}" }] })).toThrow();
  });
  it("rejects sparse or accessor route arrays without evaluating route getters", () => {
    const getter = vi.fn(() => ({ handle: id, catalogJson: "{}" })), rows = [{}];
    Object.defineProperty(rows, "0", { enumerable: true, get: getter });
    expect(() => parseLocalSetupContextV2({ version: 2, scope: "account", routes: rows })).toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(() => parseLocalSetupContextV2({ version: 2, scope: "account", routes: new Array(2) })).toThrow();
  });
  it("derives the stable app account from IOU identity/backend, not from key or sheet", async () => {
    const input = { principal: Principal.selfAuthenticating(new Uint8Array([1])).toText(), backendHost: "https://backend.example", backendCanisterId: "rrkah-fqaaa-aaaaa-aaaaq-cai" };
    const first = await localSetupAccountId(input);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await localSetupAccountId({ ...input })).toBe(first);
    expect(await localSetupAccountId({ ...input, backendHost: "https://other.example" })).not.toBe(first);
    expect(await localSetupAccountId({ ...input, principal: Principal.selfAuthenticating(new Uint8Array([2])).toText() })).not.toBe(first);
  });
});
