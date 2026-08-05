import { afterEach, describe, expect, it, vi } from "vitest";
import type { Identity } from "@dfinity/agent";

const registerAiAppMock = vi.hoisted(() => vi.fn(async () => ({ kind: "success" as const, registration: {} })));

vi.mock("./registerAiApp", () => ({ registerAiApp: registerAiAppMock }));
vi.mock("./actionInboxClient", () => ({ invalidateInboxCache: vi.fn() }));
vi.mock("./ocConfig", () => ({
  OC_ACTION_INBOX_CANISTER_ID: "aaaaa-aa",
  OC_CONNECTED_KEY: "iou.oc.connected",
  OC_IC_URL: "http://127.0.0.1:8080",
  OC_LINKED_KEY: "iou.oc.linked",
  OC_USER_INDEX_CANISTER_ID: "aaaaa-aa",
}));
vi.mock("../auth/config", () => ({ canisterId: "aaaaa-aa" }));

import { syncOpenChatManifest } from "./syncManifest";

const ME = "2vxsx-fae";
const identity = {
  getPrincipal: () => ({ toText: () => ME }),
} as unknown as Identity;

describe("syncOpenChatManifest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    registerAiAppMock.mockClear();
  });

  it("never lets a connected end-user identity mutate the deployment-owned public manifest", async () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === "iou.oc.connected" ? ME : null),
    });

    await syncOpenChatManifest(identity);

    expect(registerAiAppMock).not.toHaveBeenCalled();
  });
});
