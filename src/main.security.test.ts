import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const bootstrapEvents = vi.hoisted(() => [] as string[]);

vi.mock("./features/openchat/chatLinkLaunch", () => ({
  captureOpenChatRoutingLaunch: () => {
    bootstrapEvents.push("scrub");
    return null;
  },
}));

vi.mock("./bootstrapApp", () => {
  bootstrapEvents.push("app-import");
  return {};
});

describe("security bootstrap ordering", () => {
  beforeEach(() => {
    bootstrapEvents.length = 0;
    vi.resetModules();
  });

  it("scrubs an OpenChat routing token before importing the React/auth tree", () => {
    const source = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
    const capture = source.indexOf("captureOpenChatRoutingLaunch();");
    const appImport = source.indexOf('import("./bootstrapApp")');

    expect(capture).toBeGreaterThanOrEqual(0);
    expect(appImport).toBeGreaterThan(capture);
    expect(source).not.toMatch(/from ["']\.\/app\/App["']/);
    expect(source).not.toContain("ReactDOM.createRoot");
  });

  it("executes the scrub before evaluating the application bootstrap", async () => {
    const main = await import("./main");
    await main.appBootstrap;

    expect(bootstrapEvents).toEqual(["scrub", "app-import"]);
  });
});
