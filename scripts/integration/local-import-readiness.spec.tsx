// @vitest-environment-options {"url":"http://localhost:3000/openchat/import"}
// Real React hooks, receiver and delivery crypto. Authentication and ledger encryption are synthetic boundaries.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, beforeAll, describe, expect, it, vi } from "vitest";

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
  deliveryKey: undefined as CryptoKeyPair | undefined,
  decryptions: [] as Promise<unknown>[],
  deliverySheet: "0123456789abcdef",
}));
vi.mock("../../src/features/auth/config", () => ({ host:"http://127.0.0.1:4943", canisterId:"rrkah-fqaaa-aaaaa-aaaaq-cai" }));
vi.mock("../../src/features/openchat/LocalDeliveryKeyProvider", () => ({
  LocalDeliveryKeyProvider: ({children}:{children:ReactNode})=>children,
  useLocalDeliveryKey:()=>({ready:!!fixture.identity && !!fixture.actor,load:async()=>fixture.deliveryKey}),
}));
vi.mock("../../src/features/openchat/localImportHandoff", async original=>{
  const real=await original<typeof import("../../src/features/openchat/localImportHandoff")>();
  return {...real,decryptPendingLocalImport:(...args:Parameters<typeof real.decryptPendingLocalImport>)=>{
    const pending=real.decryptPendingLocalImport(...args);fixture.decryptions.push(pending);return pending;
  }};
});
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
vi.mock("../../src/features/openchat/localImportLaunch", async (original) => {
  const real = await original<typeof import("../../src/features/openchat/localImportLaunch")>();
  return {
    ...real,
    localImportSessionNonce: () => fixture.nativeBootstrap ? undefined : "A".repeat(43),
    localImportNativeBootstrap: () => fixture.nativeBootstrap,
  };
});
import { usePairTemplates, type PairTemplatesApi } from "../../src/features/templates/PairTemplatesContext";
import { LocalImportPage } from "../../src/features/openchat/LocalImportPage";
import type { LocalImportDraft } from "../../src/features/openchat/localImportHandoff";
import type { EntryBatchActor } from "../../src/features/entries/batchImport";
import { createLocalAppHandoffSession } from "@oc-test/localAppHandoff";
import { sealLocalAppDelivery } from "@oc-test/localAppEncryption";
import { createLocalDeliveryEncryption } from "../../src/features/openchat/localImportEncryption";

const sheetId = "0123456789abcdef";
const pairId = "0000000000000001";
const destination = "http://localhost:3000/openchat/import";
beforeAll(async()=>{ fixture.deliveryKey=await crypto.subtle.generateKey({name:"ECDH",namedCurve:"P-256"},false,["deriveBits"]); });
const encryptedRequest=async(entries:readonly LocalImportDraft[],idempotencyKey=importId)=>sealLocalAppDelivery({
  appId:"iou",appRevision:"local-import-v2",actionId:"iou.entry.import",destination,recipient:"Synthetic recipient",idempotencyKey,payload:{entries},
  deliveryEncryption:await createLocalDeliveryEncryption(fixture.deliveryKey!.publicKey,{principal:fixture.principal,
    backendHost:"http://127.0.0.1:4943",backendCanisterId:"rrkah-fqaaa-aaaaa-aaaaq-cai",pairId,sheetId:fixture.deliverySheet}),
});
const encryptedOffer=async(entries:readonly LocalImportDraft[],sessionNonce:string,idempotencyKey=importId)=>{
  const {idempotencyKey:importId,...sealed}=await encryptedRequest(entries,idempotencyKey);
  return {type:"oc:app-import:offer",version:2,sessionNonce,importId,...sealed};
};
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
  latest = usePairTemplates(pairId, sheetId);
  renders.push(latest.ready);
  return null;
}
const render = async (child: ReactNode) => { await act(async () => root.render(child)); };
const flush = async () => { await act(async () => { await Promise.resolve(); }); };
const button = (text: string) => Array.from(container.querySelectorAll("button")).find(item => item.textContent === text)!;
const click = async (element: HTMLElement) => { await act(async () => element.click()); };
const select = async (element: HTMLSelectElement, value: string) => {
  if(element.getAttribute("aria-label")==="Received draft")fixture.decryptions=[];
  await act(async () => { element.value = value; element.dispatchEvent(new Event("change", { bubbles: true })); });
  if(element.getAttribute("aria-label")==="Received draft" && value){
    await act(async()=>{
      await vi.waitFor(()=>expect(fixture.decryptions.length).toBeGreaterThan(0));
      await Promise.allSettled(fixture.decryptions);
    });
  }
};
function identity(principal: string) {
  fixture.principal = principal;
  fixture.identity = { getPrincipal: () => ({ toText: () => principal }) };
}
function actor(getPair: () => Promise<unknown> = async () => [pair()]) {
  return {
    get_pair: vi.fn(getPair),
    get_my_pairs: vi.fn(async () => [{ id: pairId, active_sheet_id: [sheetId], archived_at: [], other_principal: { toText: () => "synthetic-partner" } }]),
    get_my_user: vi.fn(async () => []),
    add_entry_batch: vi.fn(async () => ({ entry_ids: [1n], replayed: false })),
    set_pair_templates: vi.fn(),
  };
}
async function offer(typeId = "foreign", typeName = "Foreign Type") {
  await offerRows([{
    kind: "iou", amount: 100, currency: "USD", direction: "credit", date: "2026-09-26", note: "Synthetic reviewed note", typeId, typeName,
  }]);
}
async function offerRows(entries: readonly LocalImportDraft[], offeredId = importId) {
  const offer=await encryptedOffer(entries,"A".repeat(43),offeredId);
  await act(async () => {
    for (const data of [
      { type: "oc:app-import:hello", version: 2, sessionNonce: "A".repeat(43) }, offer,
    ]) window.dispatchEvent(new MessageEvent("message", { data, source: fixture.sender as unknown as Window, origin: "http://localhost:5190" }));
  });
}
async function mountSheet(selectedSheetId = sheetId) {
  fixture.deliverySheet=selectedSheetId;
  await render(<LocalImportPage />);
  const sheetSelect = container.querySelector("select")!;
  await select(sheetSelect, selectedSheetId);
  await click(button("Load this sheet’s private Types"));
}
beforeEach(() => {
  vi.clearAllMocks();
  fixture.sender.postMessage.mockReset();
  fixture.encrypt.mockReset();
  vi.stubEnv("VITE_LOCAL_IMPORT_SENDER_ORIGIN", "http://localhost:5190");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No network expected in this test"); }));
  Object.defineProperty(window, "opener", { value: fixture.sender, configurable: true });
  identity("synthetic-a"); fixture.actor = null; fixture.actorError = null; fixture.realSlots = false;
  fixture.nativeBootstrap = false; fixture.sender.closed = false;
  fixture.decryptions=[];
  fixture.unwrap.mockResolvedValue(new Uint8Array(32).fill(7));
  fixture.decrypt.mockResolvedValue(slots);
  fixture.encrypt.mockResolvedValue({ entryKey: new Uint8Array([1]), ciphertext: new Uint8Array([2]), iv: new Uint8Array([3]) });
  renders.length = 0;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});

describe("actual local receiver Type and manual-direction editing", () => {
  const entry: LocalImportDraft = { kind: "iou", amount: 100, currency: "USD", direction: "credit", date: "2026-09-26", note: "Synthetic reviewed note" };
  const creditType = { ...template, id: "credit-type", name: "Credit Type", direction: "credit" as const };
  const rowSelect = (label: string, index = 0) => {
    const fieldset = container.querySelectorAll("fieldset")[index];
    return [...fieldset.querySelectorAll("label")].find(node => node.textContent?.startsWith(`${label} `))!
      .querySelector("select")!;
  };
  const chooseReceived = async (id = importId) => select(container.querySelector('[aria-label="Received draft"]')!, id);
  const reviewed = () => JSON.parse(container.querySelector("pre")!.textContent!);

  it.each([false,true])("invalidates a review when a new ciphertext retries the same ID (changed payload %s)",async(changed)=>{
    fixture.actor=actor();await mountSheet();await offerRows([entry]);await chooseReceived();
    await click(button("Review exact encrypted entry contents"));expect(button("Save in IOU")).toBeDefined();
    await offerRows([{...entry,amount:changed?999:entry.amount}]);
    expect(button("Save in IOU")).toBeUndefined();expect(container.querySelectorAll("fieldset")).toHaveLength(0);
    expect(fixture.actor.add_entry_batch).not.toHaveBeenCalled();
    await chooseReceived();
    if(changed){
      expect(container.textContent).toContain("retries conflict");expect(container.querySelectorAll("fieldset")).toHaveLength(0);
      expect(button("Review exact encrypted entry contents")).toBeUndefined();
    }else{
      expect(container.querySelectorAll("fieldset")).toHaveLength(1);
      await click(button("Review exact encrypted entry contents"));expect(reviewed()[0].amount_minor).toBe(10000);
    }
    expect(fixture.actor.add_entry_batch).not.toHaveBeenCalled();
  });

  it("blocks a paused save if a different ciphertext arrives before the backend mutation",async()=>{
    fixture.actor=actor();await mountSheet();await offerRows([entry]);await chooseReceived();
    await click(button("Review exact encrypted entry contents"));
    const pending=deferred<{entryKey:Uint8Array;ciphertext:Uint8Array;iv:Uint8Array}>();
    fixture.encrypt.mockReturnValueOnce(pending.promise);await click(button("Save in IOU"));
    expect(fixture.encrypt).toHaveBeenCalledOnce();await offerRows([{...entry,amount:999}]);
    await act(async()=>pending.resolve({entryKey:new Uint8Array([1]),ciphertext:new Uint8Array([2]),iv:new Uint8Array([3])}));
    expect(fixture.actor.add_entry_batch).not.toHaveBeenCalled();expect(button("Save in IOU")).toBeUndefined();
    expect(fixture.sender.postMessage.mock.calls.some(([value])=>value.type==="oc:app-import:committed")).toBe(false);
  });

  it("clears an incoming matched Type without inventing missing pre-Type direction history", async () => {
    fixture.actor = actor(); await mountSheet();
    await offerRows([{ ...entry, direction: "debt", typeId: template.id, typeName: template.name }]);
    await chooseReceived();
    expect(rowSelect("Type").value).toBe(`type:${template.id}`);
    await select(rowSelect("Type"), "none");
    expect(rowSelect("Direction").value).toBe("debt");
    await click(button("Review exact encrypted entry contents"));
    expect(reviewed()[0]).toMatchObject({ direction: "debt", amount_minor: 10000 });
    expect(reviewed()[0]).not.toHaveProperty("fee");
  });

  it("restores a known receiver direction after Type A, Type B and None", async () => {
    fixture.decrypt.mockResolvedValue({ templates: [template, creditType], dismissed: [] });
    fixture.actor = actor(); await mountSheet(); await offerRows([entry]); await chooseReceived();
    await select(rowSelect("Type"), `type:${template.id}`);
    expect(rowSelect("Direction").value).toBe("debt");
    await select(rowSelect("Type"), `type:${creditType.id}`);
    expect(rowSelect("Direction").value).toBe("credit");
    await select(rowSelect("Type"), "none");
    expect(rowSelect("Direction").value).toBe("credit");
    await click(button("Review exact encrypted entry contents"));
    expect(reviewed()[0]).toMatchObject({ direction: "credit", amount_minor: 10000 });
    expect(reviewed()[0]).not.toHaveProperty("fee");
  });

  it("keeps an explicit direction through later Type and None choices and encrypts only the final DTO", async () => {
    fixture.decrypt.mockResolvedValue({ templates: [template, creditType], dismissed: [] });
    fixture.actor = actor(); await mountSheet(); await offerRows([entry]); await chooseReceived();
    await select(rowSelect("Direction"), "debt");
    await select(rowSelect("Type"), `type:${creditType.id}`);
    expect(rowSelect("Direction").value).toBe("debt");
    await select(rowSelect("Type"), "none");
    expect(rowSelect("Direction").value).toBe("debt");
    await select(rowSelect("Type"), `type:${creditType.id}`);
    await click(button("Review exact encrypted entry contents"));
    const expected = reviewed()[0];
    expect(expected).toMatchObject({ direction: "debt", amount_minor: 9000, fee: { percent: 10 } });
    expect(expected).not.toHaveProperty("directionEdited");
    expect(expected).not.toHaveProperty("directionBeforeType");
    expect(expected).not.toHaveProperty("selectedTypeId");
    await click(button("Save in IOU"));
    expect(fixture.encrypt).toHaveBeenCalledOnce();
    expect(JSON.parse(new TextDecoder().decode(fixture.encrypt.mock.calls[0][0]))).toEqual(expected);
    expect(fixture.actor.add_entry_batch).toHaveBeenCalledOnce();
  });

  it("isolates manual direction history per entry and resets it when choosing another draft", async () => {
    fixture.actor = actor(); await mountSheet();
    await offerRows([entry, { ...entry, note: "Second entry" }]); await chooseReceived();
    await select(rowSelect("Direction", 0), "credit");
    await select(rowSelect("Type", 0), `type:${template.id}`);
    await select(rowSelect("Type", 1), `type:${template.id}`);
    expect(rowSelect("Direction", 0).value).toBe("credit");
    expect(rowSelect("Direction", 1).value).toBe("debt");
    await select(rowSelect("Type", 1), "none");
    expect(rowSelect("Direction", 1).value).toBe("credit");
    await click(button("Review exact encrypted entry contents"));
    expect(reviewed().map((value: { direction: string }) => value.direction)).toEqual(["credit", "credit"]);
    expect(reviewed()[0]).toHaveProperty("fee.percent", 10);
    expect(reviewed()[1]).not.toHaveProperty("fee");
    const anotherId = "C".repeat(42) + "A";
    await offerRows([entry], anotherId); await chooseReceived(anotherId);
    expect(button("Save in IOU")).toBeUndefined();
    await select(rowSelect("Type"), `type:${template.id}`);
    expect(rowSelect("Direction").value).toBe("debt");
    await select(rowSelect("Type"), "none");
    expect(rowSelect("Direction").value).toBe("credit");
  });

  it.each(["account", "sheet"])("never applies a foreign proposed Type and resets row metadata for a new %s", async (replacement) => {
    fixture.actor = actor(); await mountSheet(); await offerRows([entry]); await chooseReceived();
    await select(rowSelect("Direction"), "credit");
    await select(rowSelect("Type"), `type:${template.id}`);
    expect(rowSelect("Direction").value).toBe("credit");
    const selectedSheetId = replacement === "sheet" ? "fedcba9876543210" : sheetId;
    if (replacement === "account") {
      identity("synthetic-b"); fixture.actor = actor(); await render(<LocalImportPage />);
      expect(container.querySelectorAll("fieldset")).toHaveLength(0);
    } else {
      fixture.actor = actor();
      fixture.actor.get_my_pairs.mockResolvedValue([{ id: pairId, active_sheet_id: [selectedSheetId], archived_at: [], other_principal: { toText: () => "synthetic-partner" } }]);
    }
    // Changing account closes the exact old connection; choosing a different destination also
    // requires a fresh receiving page instead of moving an in-progress review to another sheet.
    await render(null); await mountSheet(selectedSheetId);
    await offerRows([{ ...entry, typeId: template.id, typeName: "Stale or foreign name" }]);
    await chooseReceived();
    expect(rowSelect("Type").value).toBe("");
    expect(rowSelect("Direction").value).toBe("credit");
    await click(button("Review exact encrypted entry contents"));
    expect(button("Save in IOU")).toBeUndefined();
    await select(rowSelect("Type"), `type:${template.id}`);
    expect(rowSelect("Direction").value).toBe("debt");
    await select(rowSelect("Type"), "none");
    expect(rowSelect("Direction").value).toBe("credit");
    await click(button("Review exact encrypted entry contents"));
    expect(reviewed()[0]).not.toHaveProperty("fee");
    expect(fixture.actor.add_entry_batch).not.toHaveBeenCalled();
  });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

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
    expect(button("Prepare setup files").disabled).toBe(true);
    expect((container.querySelector('[aria-label="Received draft"]') as HTMLSelectElement).disabled).toBe(true);
    expect(container.textContent).toContain("Could not load this sheet’s Types");
    expect(fixture.actor.add_entry_batch).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it("allows genuinely absent private slots, without treating absent ciphertext as a decryption error", async () => {
    fixture.realSlots = true; fixture.actor = actor(); await mountSheet();
    expect(button("Prepare setup files").disabled).toBe(false);
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
    expect(button("Prepare setup files").disabled).toBe(true);
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
  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["noncanonical", "http://localhost:5190/"],
    ["non-loopback", "http://example.invalid:5190"],
  ] as const)("does not acknowledge, queue or save a browser handoff with %s sender configuration", async (_reason, senderOrigin) => {
    vi.stubEnv("VITE_LOCAL_IMPORT_SENDER_ORIGIN", senderOrigin);
    fixture.actor = actor();
    await mountSheet();
    // The browser launch still has its valid nonce and exact opener. Neither is authority
    // to learn a trusted sender from an incoming hello/offer when configuration is absent/invalid.
    expect(fixture.nativeBootstrap).toBe(false);
    expect(window.opener).toBe(fixture.sender);
    await offer(template.id, template.name);
    expect(container.textContent).toContain("No active handoff");
    expect(fixture.sender.postMessage).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="Received draft"]')!.querySelectorAll("option")).toHaveLength(1);
    expect(container.querySelectorAll("fieldset")).toHaveLength(0);
    expect(button("Review exact encrypted entry contents")).toBeUndefined();
    expect(button("Save in IOU")).toBeUndefined();
    expect(fixture.encrypt).not.toHaveBeenCalled();
    expect(fixture.actor.add_entry_batch).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("blocks setup/draft selection before private Types load, then requires an explicit mismatched-Type choice", async () => {
    const fetched = deferred<unknown>(); fixture.actor = actor(() => fetched.promise);
    await mountSheet(); await offer();
    const download = button("Prepare setup files");
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
    expect(button("Prepare setup files")).toBeUndefined();
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
    expect(button("Prepare setup files").disabled).toBe(false);
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

describe("actual two-entry receiver, batch adapter and OpenChat receipt composition", () => {
  const entries: readonly LocalImportDraft[] = [
    { kind: "iou", amount: 100, currency: "USD", direction: "debt", date: "2026-09-26", note: "Synthetic first reviewed row" },
    { kind: "settlement", amount: 25, currency: "EGP", direction: "credit", date: "2026-09-27", note: "Synthetic second reviewed row" },
  ];
  type BatchRequest = Parameters<EntryBatchActor["add_entry_batch"]>[0];

  async function receiveReviewedBatch() {
    await mountSheet();
    const outcomes = vi.fn();
    const senderOrigin = "http://localhost:5190";
    const receiverOrigin = "http://localhost:3000";
    const send = vi.fn((data: unknown, exactOrigin: string) => {
      expect(exactOrigin).toBe(receiverOrigin);
      window.dispatchEvent(new MessageEvent("message", {
        data, source: fixture.sender as unknown as Window, origin: senderOrigin,
      }));
    });
    const session = createLocalAppHandoffSession({
      request: await encryptedRequest(entries),
      sessionNonce: "A".repeat(43), receiver: window, send, onOutcome: outcomes,
    });
    fixture.sender.postMessage.mockImplementation((data: unknown, exactOrigin: string) => {
      expect(exactOrigin).toBe(senderOrigin);
      session.receive({ origin: receiverOrigin, source: window, data });
    });
    await act(async () => session.start());
    expect(outcomes.mock.calls).toEqual([["received"]]);
    expect(send.mock.calls.map(([data]) => (data as { type: string }).type))
      .toEqual(["oc:app-import:hello", "oc:app-import:offer"]);
    expect(fixture.encrypt).not.toHaveBeenCalled();
    expect(fixture.actor.add_entry_batch).not.toHaveBeenCalled();
    await select(container.querySelector('[aria-label="Received draft"]')!, importId);
    await click(button("Review exact encrypted entry contents"));
    const reviewed = JSON.parse(container.querySelector("pre")!.textContent!);
    expect(reviewed).toHaveLength(2);
    expect(reviewed.map((row: { kind: string }) => row.kind)).toEqual(["expense", "payment"]);
    return { session, outcomes, send, reviewed };
  }

  it("keeps two committed rows after response loss and reports saved only after explicit same-ID replay", async () => {
    // Synthetic actor models only sheet/import receipt semantics; it is not a live backend.
    const ledger: BatchRequest["entries"] = [];
    const receipts = new Map<string, bigint[]>();
    const replayReply = deferred<{ entry_ids: bigint[]; replayed: boolean }>();
    fixture.actor = actor();
    fixture.actor.add_entry_batch.mockImplementation(async (request: BatchRequest) => {
      expect(request.sheet_id).toBe(sheetId);
      expect(request.entries).toHaveLength(2);
      const key = `${request.sheet_id}:${request.import_id.join(",")}`;
      if (receipts.has(key)) return replayReply.promise;
      ledger.push(...structuredClone(request.entries));
      receipts.set(key, [501n, 502n]);
      throw new Error("Synthetic response loss after both rows committed");
    });
    let encryptionNonce = 0;
    fixture.encrypt.mockImplementation(async () => {
      const nonce = ++encryptionNonce;
      return { entryKey: new Uint8Array([nonce]), ciphertext: new Uint8Array([nonce + 10]), iv: new Uint8Array([nonce + 20]) };
    });
    const sender = await receiveReviewedBatch();
    try {
      await click(button("Save in IOU"));
      expect(fixture.actor.add_entry_batch).toHaveBeenCalledOnce();
      expect(ledger).toHaveLength(2);
      expect(receipts.size).toBe(1);
      expect(sender.outcomes.mock.calls).toEqual([["received"]]);
      expect(fixture.sender.postMessage.mock.calls.some(([message]) => message.type === "oc:app-import:committed")).toBe(false);
      expect([...container.querySelectorAll("fieldset")].every((row) => row.disabled)).toBe(true);
      expect(container.textContent).toContain("The save did not return a confirmed result");
      await flush();
      expect(fixture.actor.add_entry_batch).toHaveBeenCalledOnce(); // Never retry on rerender/flush.

      await click(button("Retry the same save in IOU"));
      expect(fixture.actor.add_entry_batch).toHaveBeenCalledTimes(2);
      expect(sender.outcomes.mock.calls).toEqual([["received"]]); // A pending replay is not saved.
      expect(ledger).toHaveLength(2);
      const [first, second] = fixture.actor.add_entry_batch.mock.calls.map(([request]: [BatchRequest]) => request);
      expect(second.sheet_id).toBe(first.sheet_id);
      expect(second.import_id).toEqual(first.import_id);
      expect(second.entries).not.toEqual(first.entries); // Fresh encrypted envelopes retain one import identity.
      expect(fixture.encrypt.mock.calls.map(([bytes]) => JSON.parse(new TextDecoder().decode(bytes))))
        .toEqual([...sender.reviewed, ...sender.reviewed]);
      for (const request of [first, second]) {
        expect(Object.keys(request).sort()).toEqual(["entries", "import_id", "sheet_id"]);
        for (const row of request.entries) expect(Object.keys(row).sort()).toEqual(["ciphertext", "entry_key", "iv"]);
      }

      await act(async () => replayReply.resolve({ entry_ids: receipts.values().next().value!, replayed: true }));
      expect(ledger).toHaveLength(2);
      expect(fixture.actor.add_entry_batch).toHaveBeenCalledTimes(2);
      expect(container.textContent).toContain("Saved 2 entries in the reviewed IOU sheet (the earlier save was already accepted)");
      expect(button("Saved in IOU").disabled).toBe(true);
      const committed = fixture.sender.postMessage.mock.calls.filter(([message]) => message.type === "oc:app-import:committed");
      expect(committed).toEqual([[{
        type: "oc:app-import:committed", version: 2, sessionNonce: "A".repeat(43),
        importId, status: "saved", acceptedCount: 2, replayed: true,
      }, "http://localhost:5190"]]);
      expect(sender.outcomes.mock.calls).toEqual([["received"], ["saved"]]);
      expect(sender.send).toHaveBeenCalledTimes(2); // No repeated hello, offer, processor or inference.
      await click(button("Saved in IOU"));
      expect(fixture.actor.add_entry_batch).toHaveBeenCalledTimes(2);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      sender.session.close(); fixture.sender.postMessage.mockReset();
    }
  });

  it("never submits a partial batch or a saved receipt when the second row cannot be encrypted", async () => {
    fixture.actor = actor();
    fixture.encrypt.mockResolvedValueOnce({ entryKey: new Uint8Array([1]), ciphertext: new Uint8Array([2]), iv: new Uint8Array([3]) })
      .mockRejectedValueOnce(new Error("Synthetic second-row encryption failure"));
    const sender = await receiveReviewedBatch();
    try {
      await click(button("Save in IOU"));
      expect(fixture.encrypt).toHaveBeenCalledTimes(2);
      expect(fixture.actor.add_entry_batch).not.toHaveBeenCalled();
      expect(sender.outcomes.mock.calls).toEqual([["received"]]);
      expect(fixture.sender.postMessage.mock.calls.some(([message]) => message.type === "oc:app-import:committed")).toBe(false);
      expect(button("Retry the same save in IOU").disabled).toBe(false);
      expect([...container.querySelectorAll("fieldset")].every((row) => row.disabled)).toBe(true);
      await flush();
      expect(fixture.actor.add_entry_batch).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      sender.session.close(); fixture.sender.postMessage.mockReset();
    }
  });
});

describe("actual native receiver consent controls", () => {
  beforeEach(() => { vi.stubEnv("VITE_LOCAL_IMPORT_SENDER_ORIGIN", undefined); });
  const nativeOrigin = "http://localhost:54621";
  const connectionId = "C".repeat(42) + "A";
  const message = async (data: unknown, senderOrigin = nativeOrigin, senderWindow: unknown = fixture.sender) => {
    await act(async () => { window.dispatchEvent(new MessageEvent("message", {
      data, origin: senderOrigin, source: senderWindow as Window,
    })); });
  };
  const connect = () => message({ type: "oc:app-import:connect", version: 1, connectionId });
  const offerFor = (sessionNonce: string) => encryptedOffer([{ kind: "iou", amount: 100, currency: "USD", direction: "credit",
      date: "2026-09-26", note: "Synthetic reviewed note", typeId: template.id, typeName: template.name }],sessionNonce);
  const connectedReply = () => fixture.sender.postMessage.mock.calls.find(([value]) => value.type === "oc:app-import:connected")?.[0];
  const loadNative = async () => { fixture.nativeBootstrap = true; fixture.actor = actor(); await mountSheet(); await connect(); };
  const allowAndOffer = async () => {
    await click(button("Allow this connection once"));
    const sessionNonce = connectedReply().sessionNonce;
    await message({ type: "oc:app-import:hello", version: 2, sessionNonce });
    await message(await offerFor(sessionNonce));
    return sessionNonce;
  };

  it("requires explicit exact-origin consent before replying or queuing; Save remains separate", async () => {
    await loadNative();
    expect(container.textContent).toContain(`Unverified local sender: ${nativeOrigin}`);
    expect(fixture.sender.postMessage).not.toHaveBeenCalled();
    await message(await offerFor("A".repeat(43)));
    await message({ type: "oc:app-import:hello", version: 2, sessionNonce: "A".repeat(43) });
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
    await connect(); await message(await offerFor("A".repeat(43)));
    expect(fixture.sender.postMessage).not.toHaveBeenCalled(); expect(button("Allow this connection once")).toBeUndefined();
    expect(fixture.actor.add_entry_batch).not.toHaveBeenCalled();
  });

  it("ignores mismatched post-consent source, origin and nonce", async () => {
    await loadNative(); await click(button("Allow this connection once"));
    const sessionNonce = connectedReply().sessionNonce;
    const hello = { type: "oc:app-import:hello", version: 2, sessionNonce };
    await message(hello, "http://localhost:54622"); await message(hello, nativeOrigin, {});
    await message({ ...hello, sessionNonce: connectionId });
    await message(await offerFor(sessionNonce));
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
