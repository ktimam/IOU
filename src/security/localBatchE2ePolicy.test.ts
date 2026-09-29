import { describe, expect, it, vi } from "vitest";
import { createLocalBatchFetch, resolveLocalBatchE2eTarget } from "./localBatchE2ePolicy";

const fixture = () => ({
  IOU_BATCH_E2E_ALLOW_WRITES: "1",
  IOU_BATCH_E2E_HOST: "http://127.0.0.1:8080",
  IOU_BATCH_E2E_CANISTER_ID: "rrkah-fqaaa-aaaaa-aaaaq-cai",
});

describe("isolated local IOU batch acceptance target", () => {
  it.each(["http://127.0.0.1:8080", "http://localhost:4943/", "http://[::1]:40436"])(
    "accepts explicit loopback origin %s without any OpenChat configuration", (host) => {
      const result = resolveLocalBatchE2eTarget({ ...fixture(), IOU_BATCH_E2E_HOST: host });
      expect(result).toEqual({ host: new URL(host).origin, canisterId: fixture().IOU_BATCH_E2E_CANISTER_ID });
      expect(Object.isFrozen(result)).toBe(true);
    },
  );
  it.each([
    "https://icp-api.io", "https://localhost:8080", "http://localhost.example:8080",
    "http://127.0.0.2:8080", "http://127.1:8080", "http://2130706433:8080",
    "http://user:secret@localhost:8080", "http://localhost:8080/api", "http://localhost:8080?x=1",
    "http://localhost:8080#target", " http://localhost:8080", "http://LOCALHOST:8080", "not a URL", "",
  ])("rejects remote, ambiguous or decorated host %s", (host) => {
    expect(() => resolveLocalBatchE2eTarget({ ...fixture(), IOU_BATCH_E2E_HOST: host })).toThrow();
  });
  it.each([undefined, "", "true", "0"])("requires explicit isolated writes, not %s", (writes) => {
    expect(() => resolveLocalBatchE2eTarget({ ...fixture(), IOU_BATCH_E2E_ALLOW_WRITES: writes })).toThrow();
  });
  it.each([undefined, "", "aaaaa-aa", "2vxsx-fae", "invalid", " rrkah-fqaaa-aaaaa-aaaaq-cai"])(
    "rejects missing or unsuitable target ID %s", (canisterId) => {
      expect(() => resolveLocalBatchE2eTarget({ ...fixture(), IOU_BATCH_E2E_CANISTER_ID: canisterId })).toThrow();
    },
  );
  it("does not take a production or retired OpenChat target from unrelated environment settings", () => {
    expect(() => resolveLocalBatchE2eTarget({
      VITE_IOU_BACKEND_CANISTER_ID: fixture().IOU_BATCH_E2E_CANISTER_ID,
      VITE_OPENCHAT_HOST: "https://icp-api.io", IOU_E2E_ALLOW_SKIP: "1",
    })).toThrow();
  });
  it("rejects off-origin URLs and Requests before calling the transport", () => {
    const transport = vi.fn<typeof fetch>();
    const localFetch = createLocalBatchFetch(fixture().IOU_BATCH_E2E_HOST, transport);
    for (const input of ["https://icp-api.io/api/v2/status", new URL("http://localhost:8080/api/v2/status"),
      new Request("http://127.0.0.1:8081/api/v2/status")]) {
      expect(() => localFetch(input)).toThrow(/left the explicit local origin/);
    }
    expect(transport).not.toHaveBeenCalled();
  });
  it("pins redirect errors even when caller or Request asks to follow", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response("ready"));
    const localFetch = createLocalBatchFetch(fixture().IOU_BATCH_E2E_HOST, transport);
    const signal = new AbortController().signal;
    await localFetch(new Request(`${fixture().IOU_BATCH_E2E_HOST}/api/v2/status`, { redirect: "follow" }),
      { redirect: "follow", signal });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][1]).toEqual({ redirect: "error", signal });
  });
});
