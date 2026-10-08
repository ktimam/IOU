import { describe, expect, it, vi } from "vitest";
import { Principal } from "@dfinity/principal";
import { resolveDurableInboxSheet } from "./durableInboxNavigation";
import { encodeIouDeliveryContext, IOU_LOCAL_APP_REVISION } from "./localImportEncryption";
import { captureLocalImportLaunch, localInboxLaunch, localImportNativeBootstrap, localImportSessionNonce } from "./localImportLaunch";

const inboxId = "a".repeat(64), requestId = "A".repeat(43);
const context = { principal: Principal.fromUint8Array(new Uint8Array([1, 1])).toText(), backendHost: "http://127.0.0.1:8080", backendCanisterId: "rrkah-fqaaa-aaaaa-aaaaq-cai",
  pairId: "0000000000000001", sheetId: "0000000000000002" };
const destination = "http://localhost:3000/openchat/import";
const grant = { inbox_id: inboxId, app_id: "iou", app_revision: IOU_LOCAL_APP_REVISION,
  action_id: "iou.entry.import", destination, recipient_context: encodeIouDeliveryContext(context),
  recipient_key_id: "b".repeat(64), created_at_ms: 1n, expires_at_ms: 2n, revoked: true };
const actor = () => ({ list_encrypted_inbox_grants: vi.fn().mockResolvedValue({ Ok: { grants: [grant], next: [] } }) });
const navigate = (testActor = actor(), override = {}) => resolveDurableInboxSheet({ actor: testActor, inboxId, context, destination, assertCurrent: () => {}, ...override });

describe("durable inbox normal-sheet navigation", () => {
  it("uses owner-returned metadata even after a grant expires or is revoked; never saves or decrypts", async () => {
    const a = actor();
    await expect(navigate(a)).resolves.toBe("/sheet/0000000000000002");
    expect(a.list_encrypted_inbox_grants).toHaveBeenCalledWith([]);
  });
  it.each(["principal", "backendHost", "backendCanisterId"] as const)("rejects another %s", async field => {
    await expect(navigate(actor(), { context: { ...context, [field]: "different" } })).rejects.toThrow();
  });
  it.each(["app_id", "app_revision", "action_id", "destination"] as const)("rejects a changed %s", async field => {
    const a = actor(); a.list_encrypted_inbox_grants.mockResolvedValue({ Ok: { grants: [{ ...grant, [field]: "different" }], next: [] } });
    await expect(navigate(a)).rejects.toThrow();
  });
  it("pages by an owner-scoped cursor", async () => {
    const a = actor(); a.list_encrypted_inbox_grants.mockResolvedValueOnce({ Ok: { grants: [], next: ["0".repeat(64)] } });
    await expect(navigate(a)).resolves.toBe("/sheet/0000000000000002");
    expect(a.list_encrypted_inbox_grants).toHaveBeenNthCalledWith(2, ["0".repeat(64)]);
  });
  it("rejects unavailable, malformed and looping results", async () => {
    for (const result of [{ Err: { NotAuthorized: null } }, { Ok: { grants: [], next: [] } },
      { Ok: { grants: [], next: ["bad"] } }, { Ok: { grants: [], next: [inboxId] } }]) {
      const a = actor(); a.list_encrypted_inbox_grants.mockResolvedValue(result);
      await expect(navigate(a)).rejects.toThrow();
      expect(a.list_encrypted_inbox_grants.mock.calls.length).toBeLessThanOrEqual(2);
    }
  });
  it("drops a result when the account changes during the read", async () => {
    const assertCurrent = vi.fn().mockImplementationOnce(() => {}).mockImplementation(() => { throw new Error("changed"); });
    await expect(navigate(actor(), { assertCurrent })).rejects.toThrow("changed");
  });
  it("rejects invalid selectors before contacting the backend", async () => {
    const a = actor(); await expect(navigate(a, { inboxId: "bad" })).rejects.toThrow();
    expect(a.list_encrypted_inbox_grants).not.toHaveBeenCalled();
  });
});

describe("durable inbox launch selectors", () => {
  function launch(hash: string, search = "") {
    const replaceState = vi.fn();
    captureLocalImportLaunch({ location: { pathname: "/openchat/import", hash, search },
      history: { state: null, replaceState } } as unknown as Pick<Window, "location" | "history">);
    return replaceState;
  }
  it("captures exactly the two opaque IDs and removes the fragment without granting legacy transport consent", () => {
    const replace = launch(`#oc-inbox=${inboxId}&oc-request=${requestId}`);
    expect(localInboxLaunch()).toEqual({ inboxId, requestId });
    expect(localImportNativeBootstrap()).toBe(false); expect(localImportSessionNonce()).toBeUndefined();
    expect(replace).toHaveBeenCalledWith(null, "", "/openchat/import");
  });
  it.each([`#oc-inbox=${inboxId}`, `#oc-inbox=bad&oc-request=${requestId}`, `#oc-inbox=${inboxId}&oc-request=bad`,
    `#oc-inbox=${inboxId}&oc-request=${requestId}&payload=private`, `#oc-inbox=${inboxId}&oc-request=${requestId}&oc-inbox=${inboxId}`])("rejects malformed selectors %s", hash => {
    launch(hash); expect(localInboxLaunch()).toBeUndefined(); expect(localImportNativeBootstrap()).toBe(false);
  });
  it("does not accept query data and resets captured selectors on the next launch", () => {
    launch(`#oc-inbox=${inboxId}&oc-request=${requestId}`, "?payload=private"); expect(localInboxLaunch()).toBeUndefined();
    launch(`#oc-inbox=${inboxId}&oc-request=${requestId}`); expect(localInboxLaunch()).toBeDefined();
    launch(""); expect(localInboxLaunch()).toBeUndefined(); expect(localImportNativeBootstrap()).toBe(true);
  });
});
