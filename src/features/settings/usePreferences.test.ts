import { beforeEach, describe, expect, it } from "vitest";
import {
  loadPreferences,
  preferencesStorageKey,
  savePreferences,
  type Preferences,
} from "./usePreferences";

const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => void store.set(key, value),
  removeItem: (key) => void store.delete(key),
  clear: () => store.clear(),
  key: (index) => [...store.keys()][index] ?? null,
  get length() {
    return store.size;
  },
} as Storage;

function prefs(profileName: string): Preferences {
  return {
    defaultCurrency: "USD",
    profileName,
    accountNames: { pair: `${profileName}'s account` },
    sheetNames: { sheet: `${profileName}'s sheet` },
    partnerNames: { pair: `${profileName}'s partner` },
  };
}

beforeEach(() => store.clear());

describe("principal-scoped preferences", () => {
  it("does not reveal principal A's plaintext cache after switching to principal B", () => {
    savePreferences("principal-a", prefs("Alice"));
    expect(loadPreferences("principal-b")).toEqual({
      defaultCurrency: "USD",
      profileName: "",
      accountNames: {},
      sheetNames: {},
      partnerNames: {},
    });
  });

  it("restores the same principal's preferences across runs", () => {
    savePreferences("principal-a", prefs("Alice"));
    expect(loadPreferences("principal-a")).toEqual(prefs("Alice"));
  });

  it("does not consume the legacy browser-global record for an authenticated principal", () => {
    store.set("iou:prefs:v1", JSON.stringify(prefs("Legacy owner unknown")));
    expect(loadPreferences("principal-a").profileName).toBe("");
    expect(store.has(preferencesStorageKey("principal-a"))).toBe(false);
  });

  it("does not let a corrupt scoped record poison map consumers or another principal", () => {
    store.set(
      preferencesStorageKey("principal-a"),
      JSON.stringify({
        defaultCurrency: "usd",
        profileName: 7,
        accountNames: null,
        sheetNames: { valid: "Readable", invalid: 42 },
        partnerNames: ["not", "a", "map"],
      }),
    );

    expect(loadPreferences("principal-a")).toEqual({
      defaultCurrency: "USD",
      profileName: "",
      accountNames: {},
      sheetNames: { valid: "Readable" },
      partnerNames: {},
    });
    expect(loadPreferences("principal-b").sheetNames).toEqual({});
  });

  it.each(["null", "[]", "true", "not-json"])(
    "fails closed for malformed preference record %j",
    (raw) => {
      store.set(preferencesStorageKey("principal-a"), raw);
      expect(loadPreferences("principal-a")).toEqual({
        defaultCurrency: "USD",
        profileName: "",
        accountNames: {},
        sheetNames: {},
        partnerNames: {},
      });
    },
  );
});
