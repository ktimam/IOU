import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureOpenChatRoutingLaunch,
  clearOpenChatRoutingLaunch,
  consumeAndScrubOpenChatRoutingFragment,
  parseOpenChatRoutingToken,
} from "./chatLinkLaunch";

const TOKEN_A = "CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg";
const TOKEN_B = "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk";

describe("OpenChat per-chat Settings launch", () => {
  beforeEach(() => {
    clearOpenChatRoutingLaunch(TOKEN_A);
    clearOpenChatRoutingLaunch(TOKEN_B);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("accepts only the exact canonical 32-byte base64url fragment", () => {
    expect(parseOpenChatRoutingToken(`#openchat-routing/${TOKEN_A}`)).toBe(TOKEN_A);
    for (const malformed of [
      "#openchat-routing",
      "#openchat-routing/",
      `#openchat-routing/${TOKEN_A}=`,
      `#openchat-routing/${TOKEN_A}/extra`,
      `#openchat-routing/${TOKEN_A.slice(0, 42)}B`,
      `#openchat-routing/${"a".repeat(43)}`,
      `#openchat-routing/${TOKEN_A}?copy=1`,
    ]) {
      expect(parseOpenChatRoutingToken(malformed), malformed).toBeNull();
    }
  });

  it("scrubs valid and malformed token fragments immediately without storing or logging them", () => {
    const replaceState = vi.fn();
    const storageSet = vi.fn();
    vi.stubGlobal("localStorage", { setItem: storageSet });
    vi.stubGlobal("sessionStorage", { setItem: storageSet });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(consumeAndScrubOpenChatRoutingFragment(
      {
        pathname: "/settings",
        search: "",
        hash: `#openchat-routing/${TOKEN_A}`,
      },
      { state: { router: true }, replaceState } as unknown as History,
    )).toBe(TOKEN_A);
    expect(replaceState).toHaveBeenCalledWith(
      { router: true },
      "",
      "/settings#openchat-routing",
    );
    expect(storageSet).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();

    replaceState.mockClear();
    expect(consumeAndScrubOpenChatRoutingFragment(
      {
        pathname: "/settings",
        search: "",
        hash: "#openchat-routing/not-a-token",
      },
      { state: null, replaceState } as unknown as History,
    )).toBeNull();
    expect(replaceState).toHaveBeenCalledWith(null, "", "/settings#openchat-routing");
    consoleLog.mockRestore();
  });

  it("keeps a scrubbed token only in memory across an auth remount until explicitly cleared", () => {
    const location = {
      pathname: "/settings",
      search: "",
      hash: `#openchat-routing/${TOKEN_B}`,
    };
    const history = {
      state: null,
      replaceState: (_state: unknown, _unused: string, url?: string | URL | null) => {
        location.hash = new URL(String(url), "https://iou.test").hash;
      },
    };
    vi.stubGlobal("window", {
      location,
      history,
      localStorage: { setItem: vi.fn() },
      sessionStorage: { setItem: vi.fn() },
    });
    expect(captureOpenChatRoutingLaunch()).toBe(TOKEN_B);
    expect(location.hash).toBe("#openchat-routing");
    expect(window.localStorage.setItem).not.toHaveBeenCalled();
    expect(window.sessionStorage.setItem).not.toHaveBeenCalled();
    expect(captureOpenChatRoutingLaunch()).toBe(TOKEN_B);
    clearOpenChatRoutingLaunch(TOKEN_B);
    expect(captureOpenChatRoutingLaunch()).toBeNull();
  });
});
