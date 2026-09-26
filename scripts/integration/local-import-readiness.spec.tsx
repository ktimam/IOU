// Real React hook/component behavior; only authenticated IO and cryptographic boundaries are mocked.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  actor: null as any,
  actorError: null as string | null,
  identity: undefined as any,
  principal: "synthetic-a",
  decrypt: vi.fn(),
  decryptCrypto: vi.fn(),
  realSlots: false,
  nativeBootstrap: false,
  unwrap: vi.fn(),
  encrypt: vi.fn(),
  sender: { postMessage: vi.fn(), closed: false },
}));
vi.mock("../../src/features/auth/AuthProvider", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => ({
    identity: fixture.identity,
    state: fixture.identity ? { kind: "authenticated", identity: fixture.identity, principal: fixture.principal } : { kind: "anonymous" },
    signIn: vi.fn(), signOut: vi.fn(),
  }),
}));
vi.mock("../../src/features/flows/useActor", () => ({
  useActor: () => ({ actor: fixture.actor, err: fixture.actorError }),
  unwrap: (value: unknown) => Array.isArray(value) ? value[0] ?? null : value ?? null,
}));
vi.mock("../../src/features/flows/SheetKeyContext", () => ({
  SheetKeyProvider: ({ children }: { children: ReactNode }) => children,
  useSheetKey: () => ({ get: () => undefined, unwrapFor: fixture.unwrap }),
}));
vi.mock("../../src/features/templates/pairTemplatesActor", async (original) => {
  const real = await original<typeof import("../../src/features/templates/pairTemplatesActor")>();
  return {
    ...real,
    decryptSlot: (...args: Parameters<typeof real.decryptSlot>) => fixture.realSlots ? real.decryptSlot(...args) : fixture.decrypt(...args),
    decryptSlotWithStatus: async (...args: Parameters<typeof real.decryptSlotWithStatus>) => fixture.realSlots
      ? real.decryptSlotWithStatus(...args) : { readable: true, payload: await fixture.decrypt(...args) },
  };
});
vi.mock("../../src/features/crypto/devVetkd", () => ({
  encryptEntryPayload: fixture.encrypt, encryptWithSheetKey: vi.fn(), decryptWithSheetKey: fixture.decryptCrypto,
}));
vi.mock("../../src/features/openchat/localImportLaunch", () => ({
  localImportSenderOrigin: () => "http://localhost:5190",
  localImportSessionNonce: () => fixture.nativeBootstrap ? undefined : "A".repeat(43),
  localImportNativeBootstrap: () => fixture.nativeBootstrap,
}));
import { usePairTemplates, type PairTemplatesApi } from "../../src/features/templates/PairTemplatesContext";
import { LocalImportPage } from "../../src/features/openchat/LocalImportPage";

const sheetId = "0123456789abcdef";
const importId = "B".repeat(42) + "A";
const template = { id: "own-type", name: "Own Type", direction: "debt" as const, txn_type: "iou" as const, keywords: [], fee_percent: 10, rev: 1, updatedAt: 1 };
const slots = { templates: [template], dismissed: [] };
const pair = () => ({ members: [fixture.principal, "synthetic-partner"], templates_a_enc: [], templates_a_iv: [], templates_b_enc: [], templates_b_iv: [] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let root: Root;
let container: HTMLDivElement;
let latest: PairTemplatesApi;
const renders: boolean[] = [];
function Probe() {
  latest = usePairTemplates("synthetic-pair", sheetId);
  renders.push(latest.ready);
  return null;
}
const render = async (child: ReactNode) => { await act(async () => root.render(child)); };
const flush = async () => { await act(async () => { await Promise.resolve(); }); };
const button = (text: string) => Array.from(container.querySelectorAll("button")).find(item => item.textContent === text)!;
const click = async (element: HTMLElement) => { await act(async () => element.click()); };
const select = async (element: HTMLSelectElement, value: string) => {
  await act(async () => { element.value = value; element.dispatchEvent(new Event("change", { bubbles: true })); });
};
function identity(principal: string) {
  fixture.principal = principal;
  fixture.identity = { getPrincipal: () => ({ toText: () => principal }) };
}
function actor(getPair: () => Promise<unknown> = async () => [pair()]) {
  return {
    get_pair: vi.fn(getPair),
    get_my_pairs: vi.fn(async () => [{ id: "synthetic-pair", active_sheet_id: [sheetId], archived_at: [], other_principal: { toText: () => "synthetic-partner" } }]),
    get_my_user: vi.fn(async () => []),
    add_entry_batch: vi.fn(async () => ({ entry_ids: [1n], replayed: false })),
    set_pair_templates: vi.fn(),
  };
}
async function offer(typeId = "foreign", typeName = "Foreign Type") {
  await act(async () => {
    for (const data of [
      { type: "oc:app-import:hello", version: 1, sessionNonce: "A".repeat(43) },
      { type: "oc:app-import:offer", version: 1, sessionNonce: "A".repeat(43), importId, actionId: "iou.entry.import", payload: { entries: [{
        kind: "iou", amount: 100, currency: "USD", direction: "credit", date: "2026-09-26", note: "Synthetic reviewed note", typeId, typeName,
      }] } },
    ]) window.dispatchEvent(new MessageEvent("message", { data, source: fixture.sender as unknown as Window, origin: "http://localhost:5190" }));
  });
}
async function mountSheet() {
  await render(<LocalImportPage />);
  const sheetSelect = container.querySelector("select")!;
  await select(sheetSelect, sheetId);
  await click(button("Load this sheet’s private Types"));
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No network expected in this test"); }));
  Object.defineProperty(window, "opener", { value: fixture.sender, configurable: true });
  identity("synthetic-a"); fixture.actor = null; fixture.actorError = null; fixture.realSlots = false;
  fixture.nativeBootstrap = false; fixture.sender.closed = false;
  fixture.unwrap.mockResolvedValue(new Uint8Array(32).fill(7));
  fixture.decrypt.mockResolvedValue(slots);
  fixture.encrypt.mockResolvedValue({ entryKey: new Uint8Array([1]), ciphertext: new Uint8Array([2]), iv: new Uint8Array([3]) });
  renders.length = 0;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("actual private Type readiness lifecycle", () => {
  it("is not ready without an actor or until both private slots finish loading", async () => {
    await render(<Probe />); expect(latest.loading).toBe(false); expect(latest.ready).toBe(false);
    const fetched = deferred<unknown>(); const decrypted = deferred<typeof slots>();
    fixture.actor = actor(() => fetched.promise); fixture.decrypt.mockReturnValue(decrypted.promise);
    await render(<Probe />); expect(latest.ready).toBe(false);
    fetched.resolve([pair()]); await flush(); expect(latest.ready).toBe(false);
    decrypted.resolve(slots); await flush(); expect(latest.ready).toBe(true); expect(latest.shared[0].id).toBe(template.id);
    expect(fixture.actor.set_pair_templates).not.toHaveBeenCalled(); expect(fixture.actor.add_entry_batch).not.toHaveBeenCalled();
  });
  it.each(["missing-pair", "not-member"])("fails closed for %s", async (failure) => {
    fixture.actor = actor(async () => failure === "missing-pair" ? [] : [{ ...pair(), members: ["other-one", "other-two"] }]);
    await render(<Probe />); expect(latest.ready).toBe(false); expect(latest.error).toBeTruthy(); expect(fixture.unwrap).not.toHaveBeenCalled();
  });
  it("does not retain readiness on actor failure, account switch, or a late old-account response", async () => {
    fixture.actor = actor(); await render(<Probe />); expect(latest.ready).toBe(true);
    identity("synthetic-b"); fixture.actor = null; fixture.actorError = "Synthetic actor unavailable";
    renders.length = 0; await render(<Probe />);
    expect(renders[0]).toBe(false); expect(latest.ready).toBe(false); expect(latest.error).toBe("Synthetic actor unavailable");
    const oldFetch = deferred<unknown>(); fixture.actorError = null; fixture.actor = actor(() => oldFetch.promise);
    await render(<Probe />);
    identity("synthetic-c"); fixture.actor = null; await render(<Probe />);
    oldFetch.resolve([{ members: ["synthetic-b", "synthetic-partner"] }]); await flush();
    expect(latest.ready).toBe(false); expect(latest.shared).toEqual([]);
  });
  it("keeps legacy partial-slot fallback while strict private import refuses a real decryption failure", async () => {
    fixture.realSlots = true;
    fixture.decryptCrypto.mockRejectedValue(new Error("Synthetic authentication tag failure"));
    fixture.actor = actor(async () => [{ ...pair(), templates_a_enc: [[1, 2]], templates_a_iv: [Array(12).fill(0)] }]);
    await render(<Probe />);
    expect(latest.ready).toBe(true); expect(latest.shared).toEqual([]);
    await mountSheet();
    expect(fixture.decryptCrypto).toHaveBeenCalled();
    expect(button("Download private setup catalog and processor").disabled).toBe(true);
    expect((container.querySelector('[aria-label="Received draft"]') as HTMLSelectElement).disabled).toBe(true);
    expect(container.textContent).toContain("Could not load this sheet’s Types");
    expect(fixture.actor.add_entry_batch).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it("allows genuinely absent private slots, without treating absent ciphertext as a decryption error", async () => {
    fixture.realSlots = true; fixture.actor = actor(); await mountSheet();
    expect(button("Download private setup catalog and processor").disabled).toBe(false);
    expect(fixture.decryptCrypto).not.toHaveBeenCalled();
  });
  it.each([
    "not valid JSON",
    JSON.stringify({ v: 3, templates: [], dismissed: [] }),
    JSON.stringify({ v: 2, templates: [{ id: "broken" }], dismissed: [] }),
  ])("keeps strict UI disabled for unreadable decoded Type data: %s", async (data) => {
    fixture.realSlots = true; fixture.decryptCrypto.mockResolvedValue(new TextEncoder().encode(data));
    fixture.actor = actor(async () => [{ ...pair(), templates_a_enc: [[1, 2]], templates_a_iv: [Array(12).fill(0)] }]);
    await mountSheet();
    expect(button("Download private setup catalog and processor").disabled).toBe(true);
    expect(container.textContent).toContain("Could not load this sheet’s Types");
    expect(fixture.actor.add_entry_batch).not.toHaveBeenCalled();
  });
  it("invalidates the ready generation on the first actor-error render, before its reload effect", async () => {
    fixture.actor = actor(); await render(<Probe />); const generation = latest.readyGeneration;
    expect(generation).toBeDefined();
    fixture.actorError = "Synthetic reload"; renders.length = 0;
    await render(<Probe />);
    expect(renders[0]).toBe(false); expect(latest.ready).toBe(true); expect(latest.readyGeneration).not.toBe(generation);
  });
});

describe("actual local receiver controls", () => {
  it("blocks setup/draft selection before private Types load, then requires an explicit mismatched-Type choice", async () => {
    const fetched = deferred<unknown>(); fixture.actor = actor(() => fetched.promise);
    await mountSheet(); await offer();
    const download = button("Download private setup catalog and processor");
    expect(download.disabled).toBe(true);
    expect((container.querySelector('[aria-label="Received draft"]') as HTMLSelectElement).disabled).toBe(true);
    await click(download); expect(fetch).not.toHaveBeenCalled();
    fetched.resolve([pair()]); await flush(); expect(download.disabled).toBe(false);
    await select(container.querySelector('[aria-label="Received draft"]')!, importId);
    const typeSelect = container.querySelector("fieldset select") as HTMLSelectElement;
    expect(typeSelect.value).toBe("");
    await click(button("Review exact encrypted entry contents"));
    expect(container.textContent).toContain("explicitly select None"); expect(button("Save in IOU")).toBeUndefined();
    await select(typeSelect, "none"); await click(button("Review exact encrypted entry contents"));
    expect(button("Save in IOU")).toBeDefined(); expect(container.querySelector("pre")!.textContent).not.toContain('"fee"');
    expect(fixture.actor.add_entry_batch).not.toHaveBeenCalled();
  });
  it("clears received drafts, loaded account and export readiness when the account changes", async () => {
    fixture.actor = actor(); await mountSheet(); await offer(template.id, template.name);
    await select(container.querySelector('[aria-label="Received draft"]')!, importId);
    expect(container.querySelectorAll("fieldset")).toHaveLength(1);
    identity("synthetic-b"); fixture.actor = null; await render(<LocalImportPage />);
    expect(container.querySelectorAll("fieldset")).toHaveLength(0);
    expect(button("Download private setup catalog and processor")).toBeUndefined();
    expect(container.textContent).toContain("IOU account changed");
  });
  it("locks an outcome-unknown save and retries the same reviewed payload/id without a second approval transition", async () => {
    fixture.actor = actor(); fixture.actor.add_entry_batch.mockRejectedValueOnce(new Error("Synthetic response lost"));
    await mountSheet(); await offer(template.id, template.name);
    await select(container.querySelector('[aria-label="Received draft"]')!, importId);
    await click(button("Review exact encrypted entry contents"));
    expect(fixture.actor.add_entry_batch).not.toHaveBeenCalled();
    await click(button("Save in IOU"));
    expect((container.querySelector("fieldset") as HTMLFieldSetElement).disabled).toBe(true);
    expect(fixture.sender.postMessage.mock.calls.some(([value]) => value.type === "oc:app-import:committed")).toBe(false);
    await click(button("Retry the same save in IOU"));
    expect(fixture.actor.add_entry_batch).toHaveBeenCalledTimes(2);
    expect(fixture.actor.add_entry_batch.mock.calls[0][0]).toEqual(fixture.actor.add_entry_batch.mock.calls[1][0]);
    expect(fixture.encrypt.mock.calls[0][0]).toEqual(fixture.encrypt.mock.calls[1][0]);
    expect(button("Saved in IOU").disabled).toBe(true);
    expect(fixture.sender.postMessage.mock.calls.some(([value]) => value.type === "oc:app-import:committed")).toBe(true);
  });
  it.each([
    ["unwrap", "actor"], ["unwrap", "identity"],
    ["encrypt", "actor"], ["encrypt", "identity"], ["encrypt", "ready-generation"],
  ] as const)("blocks the old actor after pending %s and same-account %s change", async (stage, change) => {
    const oldActor = actor(); fixture.actor = oldActor;
    await mountSheet(); await offer(template.id, template.name);
    await select(container.querySelector('[aria-label="Received draft"]')!, importId);
    await click(button("Review exact encrypted entry contents"));
    const reviewed = container.querySelector("pre")!.textContent;
    const pendingKey = deferred<Uint8Array>();
    const pendingEncryption = deferred<{ entryKey: Uint8Array; ciphertext: Uint8Array; iv: Uint8Array }>();
    if (stage === "unwrap") fixture.unwrap.mockReturnValueOnce(pendingKey.promise);
    else fixture.encrypt.mockReturnValueOnce(pendingEncryption.promise);
    await click(button("Save in IOU"));
    expect(oldActor.add_entry_batch).not.toHaveBeenCalled();

    // Same principal and sheet throughout. Allow the new Type load to finish BEFORE the old save
    // resumes, so a boolean ready check alone would wrongly accept the previous generation.
    if (change === "actor") fixture.actor = actor();
    else if (change === "identity") identity(fixture.principal);
    else fixture.actorError = "Synthetic hook reload generation";
    await render(<LocalImportPage />);
    expect(button("Download private setup catalog and processor").disabled).toBe(false);
    await act(async () => {
      pendingKey.resolve(new Uint8Array(32).fill(7));
      pendingEncryption.resolve({ entryKey: new Uint8Array([1]), ciphertext: new Uint8Array([2]), iv: new Uint8Array([3]) });
    });
    expect(oldActor.add_entry_batch).not.toHaveBeenCalled();
    expect(fixture.actor.add_entry_batch).not.toHaveBeenCalled();
    if (stage === "unwrap") expect(fixture.encrypt).not.toHaveBeenCalled();
    expect(container.querySelector("pre")!.textContent).toBe(reviewed);
    expect(fixture.sender.postMessage.mock.calls.some(([value]) => value.type === "oc:app-import:committed")).toBe(false);

    await click(button("Retry the same save in IOU"));
    expect(fixture.actor.add_entry_batch).toHaveBeenCalledOnce();
    if (change === "actor") expect(oldActor.add_entry_batch).not.toHaveBeenCalled();
    const request = fixture.actor.add_entry_batch.mock.calls[0][0];
    const expectedId = Array.from(atob(importId.replace(/-/g, "+").replace(/_/g, "/") + "="), character => character.charCodeAt(0));
    expect(request.import_id).toEqual(expectedId);
    expect(container.querySelector("pre")!.textContent).toBe(reviewed);
    expect(button("Saved in IOU").disabled).toBe(true);
  });
});

describe("actual native receiver consent controls", () => {
  const nativeOrigin = "http://localhost:54621";
  const connectionId = "C".repeat(42) + "A";
  const message = async (data: unknown, senderOrigin = nativeOrigin, senderWindow: unknown = fixture.sender) => {
    await act(async () => { window.dispatchEvent(new MessageEvent("message", {
      data, origin: senderOrigin, source: senderWindow as Window,
    })); });
  };
  const connect = () => message({ type: "oc:app-import:connect", version: 1, connectionId });
  const offerFor = (sessionNonce: string) => ({ type: "oc:app-import:offer", version: 1, sessionNonce, importId,
    actionId: "iou.entry.import", payload: { entries: [{ kind: "iou", amount: 100, currency: "USD", direction: "credit",
      date: "2026-09-26", note: "Synthetic reviewed note", typeId: template.id, typeName: template.name }] } });
  const connectedReply = () => fixture.sender.postMessage.mock.calls.find(([value]) => value.type === "oc:app-import:connected")?.[0];
  const loadNative = async () => { fixture.nativeBootstrap = true; fixture.actor = actor(); await mountSheet(); await connect(); };
  const allowAndOffer = async () => {
    await click(button("Allow this connection once"));
    const sessionNonce = connectedReply().sessionNonce;
    await message({ type: "oc:app-import:hello", version: 1, sessionNonce });
    await message(offerFor(sessionNonce));
    return sessionNonce;
  };

  it("requires explicit exact-origin consent before replying or queuing; Save remains separate", async () => {
    await loadNative();
    expect(container.textContent).toContain(`Unverified local sender: ${nativeOrigin}`);
    expect(fixture.sender.postMessage).not.toHaveBeenCalled();
    await message(offerFor("A".repeat(43)));
    await message({ type: "oc:app-import:hello", version: 1, sessionNonce: "A".repeat(43) });
    expect(fixture.sender.postMessage).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="Received draft"]')!.querySelectorAll("option")).toHaveLength(1);

    const sessionNonce = await allowAndOffer();
    expect(sessionNonce).toMatch(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
    expect(sessionNonce).not.toBe(connectionId);
    expect(fixture.sender.postMessage.mock.calls.every(([, exactOrigin]) => exactOrigin === nativeOrigin)).toBe(true);
    expect(fixture.sender.postMessage.mock.calls.map(([value]) => value.type)).toEqual([
      "oc:app-import:connected", "oc:app-import:ready", "oc:app-import:received",
    ]);
    expect(container.querySelector('[aria-label="Received draft"]')!.querySelectorAll("option")).toHaveLength(2);
    expect(fixture.actor.add_entry_batch).not.toHaveBeenCalled(); expect(fixture.encrypt).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    await select(container.querySelector('[aria-label="Received draft"]')!, importId);
    await click(button("Review exact encrypted entry contents"));
    expect(fixture.actor.add_entry_batch).not.toHaveBeenCalled();
    await click(button("Save in IOU"));
    expect(fixture.actor.add_entry_batch).toHaveBeenCalledOnce(); expect(fixture.encrypt).toHaveBeenCalledOnce();
    expect(fixture.sender.postMessage.mock.calls.at(-1)?.[0].type).toBe("oc:app-import:committed");
    expect(fixture.actor.add_entry_batch.mock.calls[0][0]).not.toHaveProperty("payload");
  });

  it("does not learn a sender from another window or follow a changed opener after capture", async () => {
    fixture.nativeBootstrap = true; fixture.actor = actor(); await mountSheet();
    const changedSender = { postMessage: vi.fn() };
    Object.defineProperty(window, "opener", { value: changedSender, configurable: true });
    await message({ type: "oc:app-import:connect", version: 1, connectionId }, nativeOrigin, changedSender);
    expect(button("Allow this connection once")).toBeUndefined(); expect(changedSender.postMessage).not.toHaveBeenCalled();
    await connect(); expect(button("Allow this connection once")).toBeDefined();
    await click(button("Reject connection"));
    await connect(); await message(offerFor("A".repeat(43)));
    expect(fixture.sender.postMessage).not.toHaveBeenCalled(); expect(button("Allow this connection once")).toBeUndefined();
    expect(fixture.actor.add_entry_batch).not.toHaveBeenCalled();
  });

  it("ignores mismatched post-consent source, origin and nonce", async () => {
    await loadNative(); await click(button("Allow this connection once"));
    const sessionNonce = connectedReply().sessionNonce;
    const hello = { type: "oc:app-import:hello", version: 1, sessionNonce };
    await message(hello, "http://localhost:54622"); await message(hello, nativeOrigin, {});
    await message({ ...hello, sessionNonce: connectionId });
    await message(offerFor(sessionNonce));
    expect(fixture.sender.postMessage).toHaveBeenCalledOnce();
    expect(container.querySelector('[aria-label="Received draft"]')!.querySelectorAll("option")).toHaveLength(1);
  });

  it.each(["expiry", "closed-opener", "logout", "account-change", "navigation"])("invalidates pending consent on %s", async reason => {
    vi.useFakeTimers(); await loadNative();
    if (reason === "expiry") await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    if (reason === "closed-opener") { fixture.sender.closed = true; await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); }
    if (reason === "logout") await click(button("Sign out"));
    if (reason === "account-change") { identity("synthetic-b"); fixture.actor = actor(); await render(<LocalImportPage />); }
    if (reason === "navigation") await act(async () => { window.dispatchEvent(new Event("pagehide")); });
    expect(button("Allow this connection once")).toBeUndefined();
    await connect(); expect(fixture.sender.postMessage).not.toHaveBeenCalled();
    expect(fixture.actor.add_entry_batch).not.toHaveBeenCalled();
  });

  it.each(["close", "expiry", "navigation"])("blocks a paused native save after %s and discards unsaved review state", async reason => {
    vi.useFakeTimers(); await loadNative(); await allowAndOffer();
    await select(container.querySelector('[aria-label="Received draft"]')!, importId);
    await click(button("Review exact encrypted entry contents"));
    const pending = deferred<{ entryKey: Uint8Array; ciphertext: Uint8Array; iv: Uint8Array }>();
    fixture.encrypt.mockReturnValueOnce(pending.promise);
    await click(button("Save in IOU")); expect(fixture.encrypt).toHaveBeenCalledOnce();
    if (reason === "close") await click(button("Close local connection"));
    else if (reason === "navigation") await act(async () => { window.dispatchEvent(new Event("pagehide")); });
    else await act(async () => { await vi.advanceTimersByTimeAsync(600_000); });
    await act(async () => { pending.resolve({ entryKey: new Uint8Array([1]), ciphertext: new Uint8Array([2]), iv: new Uint8Array([3]) }); });
    expect(fixture.actor.add_entry_batch).not.toHaveBeenCalled();
    expect(fixture.sender.postMessage.mock.calls.some(([value]) => value.type === "oc:app-import:committed")).toBe(false);
    expect(button("Save in IOU")).toBeUndefined(); expect(container.querySelectorAll("fieldset")).toHaveLength(0);
  });
});
