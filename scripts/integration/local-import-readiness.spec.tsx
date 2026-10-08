// @vitest-environment-options {"url":"http://localhost:3000/openchat/import"}
// Real normal IOU providers, sheet/forms, Type hooks, receiver and cross-client envelope crypto.
// Only authentication/actor/ledger-key boundaries are synthetic. No live backend or model runs.
import { act, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, beforeAll, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  actor: null as any, actorError: null as string | null, identity: undefined as any,
  principal: "synthetic-a", decrypt: vi.fn(), decryptCrypto: vi.fn(), realSlots: false,
  nativeBootstrap: false, unwrap: vi.fn(), encrypt: vi.fn(),
  sender: { postMessage: vi.fn(), closed: false },
  deliveryKey: undefined as CryptoKeyPair | undefined, decryptions: [] as Promise<unknown>[],
  deliverySheet: "0123456789abcdef", deliveryPrincipal: undefined as string | undefined,
}));
vi.mock("../../src/features/auth/config", () => ({ host: "http://127.0.0.1:4943", canisterId: "rrkah-fqaaa-aaaaa-aaaaq-cai" }));
vi.mock("../../src/features/openchat/LocalDeliveryKeyProvider", () => ({
  LocalDeliveryKeyProvider: ({ children }: { children: ReactNode }) => children,
  useLocalDeliveryKey: () => ({ ready: !!fixture.identity && !!fixture.actor, load: async () => fixture.deliveryKey }),
}));
// This receiver suite already supplies its authenticated key provider. Normal-sheet
// durable inbox polling is disabled in this embedded import flow and owns no key session.
vi.mock("../../src/features/openchat/consumerKeypair", () => ({
  captureConsumerKeypairSession: vi.fn(() => { throw new Error("Embedded import must not start normal-sheet inbox polling"); }),
  loadExistingConsumerKeypair: vi.fn(() => { throw new Error("Embedded import must use its supplied key provider"); }),
}));
vi.mock("../../src/features/openchat/localImportHandoff", async original => {
  const real = await original<typeof import("../../src/features/openchat/localImportHandoff")>();
  return { ...real, decryptPendingLocalImport: (...args: Parameters<typeof real.decryptPendingLocalImport>) => {
    const pending = real.decryptPendingLocalImport(...args); fixture.decryptions.push(pending); return pending;
  } };
});
vi.mock("../../src/features/auth/AuthProvider", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  buildAgent: async () => ({}),
  useAuth: () => ({ identity: fixture.identity,
    state: fixture.identity ? { kind: "authenticated", identity: fixture.identity, principal: fixture.principal } : { kind: "anonymous" },
    signIn: vi.fn(), signOut: vi.fn() }),
}));
vi.mock("../../src/backend/declarations", () => ({ createActor: () => fixture.actor }));
vi.mock("../../src/features/openchat/actionInboxClient", () => ({
  getActionInboxConfig: vi.fn(), pollActionInbox: vi.fn(), acknowledgeActionInbox: vi.fn(),
}));
vi.mock("../../src/features/flows/useActor", () => ({
  useActor: () => ({ actor: fixture.actor, err: fixture.actorError }),
  unwrap: (value: unknown) => Array.isArray(value) ? value[0] ?? null : value ?? null,
  isActive: (value: unknown) => !!value && typeof value === "object" && "Active" in value,
}));
vi.mock("../../src/features/flows/SheetKeyContext", () => ({
  SheetKeyProvider: ({ children }: { children: ReactNode }) => children,
  useSheetKey: () => ({ get: () => undefined, cache: vi.fn(), unwrapFor: fixture.unwrap }),
}));
vi.mock("../../src/features/templates/pairTemplatesActor", async original => {
  const real = await original<typeof import("../../src/features/templates/pairTemplatesActor")>();
  return { ...real,
    decryptSlot: (...args: Parameters<typeof real.decryptSlot>) => fixture.realSlots ? real.decryptSlot(...args) : fixture.decrypt(...args),
    decryptSlotWithStatus: async (...args: Parameters<typeof real.decryptSlotWithStatus>) => fixture.realSlots
      ? real.decryptSlotWithStatus(...args) : { readable: true, payload: await fixture.decrypt(...args) },
  };
});
vi.mock("../../src/features/crypto/devVetkd", () => ({
  encryptEntryPayload: fixture.encrypt, encryptWithSheetKey: vi.fn(), decryptWithSheetKey: fixture.decryptCrypto,
  decryptName: vi.fn(), encryptName: vi.fn(), isProdVetkd: () => false, deriveUserKey: vi.fn(),
}));
vi.mock("../../src/features/openchat/localImportLaunch", async original => {
  const real = await original<typeof import("../../src/features/openchat/localImportLaunch")>();
  return { ...real, localImportSessionNonce: () => fixture.nativeBootstrap ? undefined : "A".repeat(43),
    localImportNativeBootstrap: () => fixture.nativeBootstrap };
});

import { LocalImportPage } from "../../src/features/openchat/LocalImportPage";
import { usePairTemplates, type PairTemplatesApi } from "../../src/features/templates/PairTemplatesContext";
import type { LocalImportDraft } from "../../src/features/openchat/localImportHandoff";
import { createLocalAppHandoffSession } from "@oc-test/localAppHandoff";
import { sealLocalAppDelivery } from "@oc-test/localAppEncryption";
import { createLocalDeliveryEncryption } from "../../src/features/openchat/localImportEncryption";
import { localImportSheetDrafts } from "../../src/features/openchat/localImportSheet";
import { getActionInboxConfig, pollActionInbox, acknowledgeActionInbox } from "../../src/features/openchat/actionInboxClient";
import { LocalImportNavigationProvider } from "../../src/features/openchat/LocalImportNavigation";
import { CloseSheetButton } from "../../src/features/entries/CloseSheetButton";
import { PreferencesProvider } from "../../src/features/settings/usePreferences";
import { ToastProvider } from "../../src/features/ui/Toasts";

const sheetId = "0123456789abcdef", pairId = "0000000000000001";
const destination = "http://localhost:3000/openchat/import", senderOrigin = "http://localhost:5190";
const importId = "B".repeat(42) + "A", sessionNonce = "A".repeat(43);
const template = { id: "own-type", name: "Own Type", direction: "debt" as const, txn_type: "iou" as const, keywords: [], fee_percent: 10, rev: 1, updatedAt: 1 };
const slots = { templates: [template], dismissed: [] };
const entry: LocalImportDraft = { kind: "iou", amount: 100, currency: "USD", direction: "credit", date: "2026-09-26", note: "Synthetic reviewed note" };
const pair = () => ({ members: [fixture.principal, "synthetic-partner"], templates_a_enc: [], templates_a_iv: [], templates_b_enc: [], templates_b_iv: [] });
const encrypted = { entryKey: new Uint8Array([1]), ciphertext: new Uint8Array([2]), iv: new Uint8Array([3]) };
let root: Root, container: HTMLDivElement;
const button = (label: string) => [...container.querySelectorAll("button")].find(node => node.textContent === label);
const noteInput = () => [...container.querySelectorAll(".entry-form input")].find(node => (node as HTMLInputElement).value === entry.note || (node as HTMLInputElement).value === "User reviewed note") as HTMLInputElement;
const render = async (child: ReactNode = <LocalImportPage />) => {
  await act(async () => { root.render(<StrictMode><MemoryRouter>{child}</MemoryRouter></StrictMode>); });
};
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); };
const waitText = async (text: string) => { await vi.waitFor(async () => { await flush(); expect(container.textContent).toContain(text); }, { timeout: 4000 }); };
const click = async (element: HTMLElement | undefined) => { expect(element).toBeDefined(); await act(async () => { element!.click(); }); };
const submit = async () => { const form = container.querySelector(".entry-form"); expect(form).not.toBeNull();
  await act(async () => { form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); };
const message = async (data: unknown, origin = senderOrigin, source: unknown = fixture.sender) => {
  await act(async () => { window.dispatchEvent(new MessageEvent("message", { data, origin, source: source as Window })); });
};
function identity(principal = "synthetic-a") {
  fixture.principal = principal; fixture.identity = { getPrincipal: () => ({ toText: () => principal }) };
}
function actor() {
  return {
    get_pair: vi.fn(async () => [pair()]),
    get_my_pairs: vi.fn(async () => [{ id: pairId, active_sheet_id: [sheetId], archived_at: [], other_principal: { toText: () => "synthetic-partner" } }]),
    get_my_user: vi.fn(async () => []),
    get_sheet: vi.fn(async () => [{ id: sheetId, pair_id: pairId, member_a: fixture.principal, member_b: "synthetic-partner", state: { Active: null }, name_enc: [], name_iv: [] }]),
    list_entries: vi.fn(async () => ({ entries: [] })),
    add_entry_batch: vi.fn(async () => ({ entry_ids: [1n], replayed: false })),
    set_pair_templates: vi.fn(), set_member_name: vi.fn(), close_sheet_encrypted: vi.fn(),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve };
}
async function encryptedRequest(entries: readonly LocalImportDraft[], idempotencyKey = importId) {
  return sealLocalAppDelivery({
    appId: "iou", appRevision: "local-import-v2", actionId: "iou.entry.import", destination,
    recipient: "Synthetic recipient", idempotencyKey, payload: { entries: JSON.parse(JSON.stringify(entries)) },
    deliveryEncryption: await createLocalDeliveryEncryption(fixture.deliveryKey!.publicKey, {
      principal: fixture.deliveryPrincipal ?? fixture.principal, backendHost: "http://127.0.0.1:4943",
      backendCanisterId: "rrkah-fqaaa-aaaaa-aaaaq-cai", pairId, sheetId: fixture.deliverySheet,
    }),
  });
}
async function offerRows(entries: readonly LocalImportDraft[], nonce = sessionNonce, origin = senderOrigin) {
  const { idempotencyKey: id, ...sealed } = await encryptedRequest(entries);
  await message({ type: "oc:app-import:hello", version: 2, sessionNonce: nonce }, origin);
  await message({ type: "oc:app-import:offer", version: 2, sessionNonce: nonce, importId: id, ...sealed }, origin);
}
async function receive(entries: readonly LocalImportDraft[] = [entry]) {
  fixture.actor = actor(); await render(); await offerRows(entries); await waitText("Review & add");
}
async function review(entries: readonly LocalImportDraft[] = [entry]) {
  await receive(entries); await click(button("Review & add"));
}
function plaintexts() { return fixture.encrypt.mock.calls.map(([bytes]) => JSON.parse(new TextDecoder().decode(bytes))); }
function committed() { return fixture.sender.postMessage.mock.calls.filter(([value]) => value.type === "oc:app-import:committed"); }

beforeAll(async () => { fixture.deliveryKey = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]); });
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("VITE_LOCAL_IMPORT_SENDER_ORIGIN", senderOrigin);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No network expected"); }));
  localStorage.clear();
  Object.defineProperty(window, "parent", { configurable: true, value: window });
  Object.defineProperty(window, "opener", { configurable: true, value: fixture.sender });
  identity(); fixture.actor = actor(); fixture.actorError = null; fixture.realSlots = false;
  fixture.nativeBootstrap = false; fixture.sender.closed = false; fixture.deliverySheet = sheetId;
  fixture.deliveryPrincipal = undefined; fixture.decryptions = [];
  fixture.unwrap.mockReset().mockResolvedValue(new Uint8Array(32).fill(7));
  fixture.decrypt.mockReset().mockResolvedValue(slots);
  fixture.decryptCrypto.mockReset();
  fixture.encrypt.mockReset().mockResolvedValue(encrypted);
  fixture.sender.postMessage.mockReset();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); }); container.remove();
  Object.defineProperty(window, "parent", { configurable: true, value: window });
  Object.defineProperty(window, "opener", { configurable: true, value: null });
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
});

describe("normal IOU sheet receiver and form", () => {
  it.each([false, true])("keeps ordinary navigation outside only the framed receiver (%s)", async framed => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    if (framed) Object.defineProperty(window, "parent", { configurable: true, value: fixture.sender });
    await receive();
    for (const path of ["/pairs", "/pair/" + pairId]) {
      const link = container.querySelector('a[href="' + path + '"]')!;
      expect(link.getAttribute("target")).toBe(framed ? "_blank" : null);
      expect(link.getAttribute("rel")).toBe(framed ? "noopener noreferrer" : null);
    }
    await click(container.querySelector(".user-badge") as HTMLElement);
    if (framed) expect(open).toHaveBeenCalledWith("http://localhost:3000/settings", "_blank", "noopener,noreferrer");
    else expect(open).not.toHaveBeenCalled();
    expect(fixture.actor.add_entry_batch).not.toHaveBeenCalled();
  });
  it.each([false, true])("runs close-sheet confirmation only in the ordinary sheet, not a frame (%s)", async framed => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const payload = localImportSheetDrafts([entry], [], importId)[0].initial as any;
    await render(<LocalImportNavigationProvider enabled={framed}><PreferencesProvider><ToastProvider>
      <CloseSheetButton sheetId={sheetId} pairId={pairId} closingDays={30} entries={[payload]} />
    </ToastProvider></PreferencesProvider></LocalImportNavigationProvider>);
    await click(button("🔒 Close & start new"));
    if (framed) {
      expect(open).toHaveBeenCalledWith("http://localhost:3000/sheet/" + sheetId, "_blank", "noopener,noreferrer");
      expect(button("Yes, close & start new")).toBeUndefined();
    } else {
      expect(open).not.toHaveBeenCalled(); expect(button("Yes, close & start new")).toBeDefined();
    }
    // Even a blocked popup (or fresh top-level sign-in) cannot close a sheet first.
    expect(fixture.actor.close_sheet_encrypted).not.toHaveBeenCalled();
    expect(fixture.encrypt).not.toHaveBeenCalled();
  });
  it("loads the bound sheet through actual normal providers; receipt is not save", async () => {
    await receive([{ ...entry, typeId: template.id, typeName: template.name }]);
    expect(container.querySelector(".app-shell")).not.toBeNull();
    expect(container.textContent).toContain("Pending from chat");
    expect(container.textContent).not.toContain("Verified OpenChat");
    expect(container.querySelector('select[aria-label="Received draft"]')).toBeNull();
    expect(container.querySelector("pre")).toBeNull();
    expect(container.textContent).not.toContain("Load this sheet");
    expect(fixture.actor.get_sheet).toHaveBeenCalledWith(sheetId);
    expect(fixture.encrypt).not.toHaveBeenCalled();
    expect(fixture.actor.add_entry_batch).not.toHaveBeenCalled();
    await click(button("Review & add"));
    const form = container.querySelector(".entry-form")!;
    expect((form.querySelector('input[type="date"]') as HTMLInputElement).value).toBe(entry.date);
    expect(noteInput().value).toBe(entry.note);
    await submit(); await waitText("Saved in IOU.");
    expect(plaintexts()[0]).toMatchObject({ amount_minor: 9000, direction: "credit", note: entry.note,
      ts: Date.parse("2026-09-26T00:00:00Z"), fee: { gross_amount_minor: 10000, percent: 10 },
      draft_id: "local:" + importId + ":0", import_message_id: importId });
    expect(fixture.actor.add_entry_batch).toHaveBeenCalledOnce();
    expect(committed()).toHaveLength(1);
    expect(committed()[0][0]).toMatchObject({ status: "saved", acceptedCount: 1 });
    expect(fetch).not.toHaveBeenCalled();
    expect(getActionInboxConfig).not.toHaveBeenCalled();
    expect(pollActionInbox).not.toHaveBeenCalled();
    expect(acknowledgeActionInbox).not.toHaveBeenCalled();
  });
  it("allows ordinary final note edits in the existing EntryForm", async () => {
    await review();
    const textarea = noteInput();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(textarea, "User reviewed note");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await submit(); await waitText("Saved in IOU.");
    expect(plaintexts()[0].note).toBe("User reviewed note");
  });
  it.each(["missing-date", "stale-type"])("blocks %s with a precise correction, then accepts a corrected fresh handoff", async reason => {
    const rows = reason === "missing-date" ? [{ ...entry, date: undefined }] : [{ ...entry, typeId: "old", typeName: "Old" }];
    await render(); await offerRows(rows);
    await waitText(reason === "missing-date" ? "Set a date in the OpenChat card" : "Reconnect IOU in OpenChat and create a new proposal");
    expect(button("Review & add")).toBeUndefined(); expect(fixture.actor.add_entry_batch).not.toHaveBeenCalled();
    // A corrected card is a fresh user-initiated handoff; never overwrite a received request.
    await act(async () => { root.unmount(); }); root = createRoot(container);
    await render(); await offerRows([entry]); await waitText("Review & add");
    await click(button("Review & add")); expect(container.querySelector(".entry-form")).not.toBeNull();
  });
  it.each(["principal", "sheet", "archived"])("does not open a mismatched %s recipient", async mismatch => {
    if (mismatch === "principal") fixture.deliveryPrincipal = "synthetic-other";
    if (mismatch === "sheet") fixture.deliverySheet = "fedcba9876543210";
    if (mismatch === "archived") fixture.actor.get_my_pairs.mockResolvedValue([{ id: pairId, active_sheet_id: [sheetId], archived_at: [1n] }]);
    await render(); await offerRows([entry]); await waitText("could not be opened in the connected IOU account");
    expect(button("Review & add")).toBeUndefined(); expect(fixture.decryptions).toHaveLength(0);
    expect(fixture.actor.add_entry_batch).not.toHaveBeenCalled();
  });
  it("sanitizes arbitrary actor errors instead of printing identifiers", async () => {
    fixture.actor.get_my_pairs.mockRejectedValue(new Error("private-principal-and-raw-backend-id"));
    await render(); await offerRows([entry]); await waitText("could not be opened in the connected IOU account");
    expect(container.textContent).not.toContain("private-principal-and-raw-backend-id");
  });
  it("waits for readable current Types, never treating a failed slot as empty", async () => {
    fixture.decrypt.mockRejectedValue(new Error("opaque-private-slot"));
    await render(); await offerRows([entry]); await waitText("Types could not be loaded");
    expect(button("Review & add")).toBeUndefined(); expect(container.textContent).not.toContain("opaque-private-slot");
    expect(fixture.actor.add_entry_batch).not.toHaveBeenCalled();
  });
  it("ignores other sender windows, origins and nonces before accepting a valid browser offer", async () => {
    await render();
    for (const [origin, source, nonce] of [
      ["http://localhost:5191", fixture.sender, sessionNonce], [senderOrigin, {}, sessionNonce],
      [senderOrigin, fixture.sender, "C".repeat(42) + "A"],
    ] as const) await message({ type: "oc:app-import:hello", version: 2, sessionNonce: nonce }, origin, source);
    expect(fixture.sender.postMessage).not.toHaveBeenCalled();
    await offerRows([entry]); await waitText("Review & add");
    expect(fixture.sender.postMessage.mock.calls.every(([, origin]) => origin === senderOrigin)).toBe(true);
  });
  it.each([false, true])("closes an old form when ciphertext changes (conflict %s)", async changed => {
    await review();
    await offerRows([{ ...entry, amount: changed ? 999 : 100 }]);
    await flush(); expect(container.querySelector(".entry-form")).toBeNull();
    if (changed) { await waitText("could not be opened for the connected"); expect(button("Review & add")).toBeUndefined(); }
    else await waitText("Review & add");
    expect(fixture.actor.add_entry_batch).not.toHaveBeenCalled();
  });
  it.each(["identity", "actor", "principal", "navigation", "ciphertext"])("blocks a paused mutation after %s changes", async change => {
    await review(); const firstActor = fixture.actor, pending = deferred<typeof encrypted>();
    fixture.encrypt.mockReturnValueOnce(pending.promise);
    await submit(); expect(fixture.encrypt).toHaveBeenCalledOnce();
    if (change === "identity") { identity(); await render(); }
    if (change === "actor") { fixture.actor = actor(); await render(); }
    if (change === "principal") { identity("synthetic-b"); fixture.actor = actor(); await render(); }
    if (change === "navigation") await messagePageHide();
    if (change === "ciphertext") await offerRows([{ ...entry, amount: 999 }]);
    await act(async () => { pending.resolve(encrypted); }); await flush();
    expect(firstActor.add_entry_batch).not.toHaveBeenCalled(); expect(committed()).toHaveLength(0);
  });
  it("never retries an unknown single-entry save automatically and refuses changed fields", async () => {
    await review();
    fixture.actor.add_entry_batch.mockRejectedValueOnce(new Error("unknown result"));
    await submit(); await waitText("did not return a confirmed result"); await flush();
    expect(fixture.actor.add_entry_batch).toHaveBeenCalledOnce(); expect(committed()).toHaveLength(0);
    const textarea = noteInput();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(textarea, "Changed after attempt");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await submit(); expect(fixture.actor.add_entry_batch).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("save was already attempted");
  });
});

async function messagePageHide() { await act(async () => { window.dispatchEvent(new Event("pagehide")); }); }

describe("normal batch confirmation with real OpenChat sender", () => {
  const rows = [{ ...entry, kind: "iou" as const, amount: 11.11 }, { ...entry, kind: "settlement" as const, amount: 22.22 }];
  async function connectSender() {
    expect(localImportSheetDrafts(rows, [template], importId)).toHaveLength(2);
    await render(); const request = await encryptedRequest(rows), outcomes = vi.fn();
    const receiver = { postMessage: vi.fn((data: unknown, origin: string) => {
      expect(origin).toBe("http://localhost:3000");
      window.dispatchEvent(new MessageEvent("message", { data, origin: senderOrigin, source: fixture.sender as unknown as Window }));
    }) };
    const session = createLocalAppHandoffSession({ request, receiver, send: receiver.postMessage, sessionNonce, onOutcome: outcomes });
    fixture.sender.postMessage.mockImplementation((data: unknown, origin: string) => {
      expect(origin).toBe(senderOrigin); session.receive({ origin: "http://localhost:3000", source: receiver, data });
    });
    await act(async () => { session.start(); });
    await vi.waitFor(() => expect(fixture.decryptions.length).toBeGreaterThan(0));
    let decrypted: PromiseSettledResult<unknown>[] = [];
    await act(async () => { decrypted = await Promise.allSettled(fixture.decryptions); });
    expect(decrypted.filter(value => value.status === "rejected")).toEqual([]);
    await waitText("Review & add");
    expect(outcomes.mock.calls).toEqual([["received"]]); expect(fixture.actor.add_entry_batch).not.toHaveBeenCalled();
    await click(button("Review & add")); expect(button("Add all 2 entries")).toBeDefined();
    return { session, outcomes, receiver };
  }
  it("saves only after existing Add all, reuses one import identity after response loss, and reports Saved only on acknowledgment", async () => {
    const ledger: unknown[] = []; let attempted = false;
    fixture.actor.add_entry_batch.mockImplementation(async (request: any) => {
      if (!attempted) { attempted = true; ledger.push(...request.entries); throw new Error("response lost after commit"); }
      return { entry_ids: [501n, 502n], replayed: true };
    });
    const sender = await connectSender();
    try {
      await click(button("Add all 2 entries")); await waitText("did not return a confirmed result");
      expect(ledger).toHaveLength(2); expect(committed()).toHaveLength(0);
      await flush(); expect(fixture.actor.add_entry_batch).toHaveBeenCalledOnce();
      await click(button("Add all 2 entries")); await waitText("earlier save was already accepted");
      expect(ledger).toHaveLength(2); expect(fixture.actor.add_entry_batch).toHaveBeenCalledTimes(2);
      const requests = fixture.actor.add_entry_batch.mock.calls.map(([request]: any[]) => request);
      expect(requests[1].import_id).toEqual(requests[0].import_id);
      for (const request of requests) {
        expect(Object.keys(request).sort()).toEqual(["entries", "import_id", "sheet_id"]);
        for (const item of request.entries) expect(Object.keys(item).sort()).toEqual(["ciphertext", "entry_key", "iv"]);
      }
      expect(plaintexts().map(value => value.txn_type)).toEqual(["iou", "settlement", "iou", "settlement"]);
      expect(sender.outcomes.mock.calls).toEqual([["received"], ["saved"]]);
      expect(sender.receiver.postMessage).toHaveBeenCalledTimes(2); expect(committed()).toHaveLength(1);
    } finally { sender.session.close(); }
  });
  it("does not partially save or acknowledge when the second entry cannot encrypt", async () => {
    const sender = await connectSender();
    try {
      fixture.encrypt.mockResolvedValueOnce(encrypted).mockRejectedValueOnce(new Error("second row failed"));
      await click(button("Add all 2 entries")); await waitText("did not return a confirmed result");
      expect(fixture.encrypt).toHaveBeenCalledTimes(2); expect(fixture.actor.add_entry_batch).not.toHaveBeenCalled();
      expect(sender.outcomes.mock.calls).toEqual([["received"]]); expect(committed()).toHaveLength(0);
    } finally { sender.session.close(); }
  });
});

describe("native fullscreen parent binding", () => {
  const origin = "http://localhost:54621", connectionId = "C".repeat(42) + "A";
  const connect = () => message({ type: "oc:app-import:connect", version: 1, connectionId }, origin);
  const reply = () => fixture.sender.postMessage.mock.calls.find(([value]) => value.type === "oc:app-import:connected")?.[0];
  async function mountNative(framed = true) {
    fixture.nativeBootstrap = true; vi.stubEnv("VITE_LOCAL_IMPORT_SENDER_ORIGIN", undefined);
    if (framed) Object.defineProperty(window, "parent", { configurable: true, value: fixture.sender });
    await render(); await connect();
  }
  it("auto-binds ciphertext reception from the exact parent, with normal final review/save still required", async () => {
    await mountNative(); expect(reply()).toBeDefined();
    expect(button("Continue")).toBeUndefined(); expect(container.textContent).not.toContain("Requesting address");
    await offerRows([entry], reply().sessionNonce, origin); await waitText("Review & add");
    expect(fixture.actor.add_entry_batch).not.toHaveBeenCalled();
    await click(button("Review & add")); await submit(); await waitText("Saved in IOU.");
    expect(fixture.actor.add_entry_batch).toHaveBeenCalledOnce();
    expect(fixture.sender.postMessage.mock.calls.every(([, target]) => target === origin)).toBe(true);
  });
  it("keeps explicit consent for the legacy top-level opener route", async () => {
    await mountNative(false); expect(reply()).toBeUndefined(); expect(button("Continue")).toBeDefined();
    await click(button("Continue")); expect(reply()).toBeDefined();
    expect(fixture.actor.add_entry_batch).not.toHaveBeenCalled();
  });
  it("does not adopt a changed parent, unknown source or non-loopback sender", async () => {
    fixture.nativeBootstrap = true; vi.stubEnv("VITE_LOCAL_IMPORT_SENDER_ORIGIN", undefined);
    Object.defineProperty(window, "parent", { configurable: true, value: fixture.sender }); await render();
    const stranger = { postMessage: vi.fn(), closed: false };
    Object.defineProperty(window, "parent", { configurable: true, value: stranger });
    await message({ type: "oc:app-import:connect", version: 1, connectionId }, origin, stranger);
    await message({ type: "oc:app-import:connect", version: 1, connectionId }, "https://stranger.example");
    expect(reply()).toBeUndefined(); expect(stranger.postMessage).not.toHaveBeenCalled();
  });
  it.each(["expiry", "closed", "navigation", "logout"])("invalidates the receiver and paused save on %s", async reason => {
    let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
    await mountNative(); const nonce = reply().sessionNonce;
    await offerRows([entry], nonce, origin); await waitText("Review & add"); await click(button("Review & add"));
    const pending = deferred<typeof encrypted>(), oldActor = fixture.actor;
    fixture.encrypt.mockReturnValueOnce(pending.promise); await submit();
    if (reason === "expiry") now += 600_001;
    if (reason === "closed") fixture.sender.closed = true;
    if (reason === "navigation") await messagePageHide();
    if (reason === "logout") { fixture.identity = undefined; await render(); }
    await message({ type: "oc:app-import:hello", version: 2, sessionNonce: nonce }, origin);
    await act(async () => { pending.resolve(encrypted); }); await flush();
    expect(oldActor.add_entry_batch).not.toHaveBeenCalled(); expect(committed()).toHaveLength(0);
  });
});

describe("strict Type readiness hook", () => {
  let latest: PairTemplatesApi;
  function Probe() { latest = usePairTemplates(pairId, sheetId, { requireReadableSlots: true }); return null; }
  it("keeps readiness false until both private slots are loaded and invalidates on identity change", async () => {
    const pending = deferred<typeof slots>(); fixture.decrypt.mockReturnValue(pending.promise);
    await render(<Probe />); expect(latest!.ready).toBe(false);
    await act(async () => { pending.resolve(slots); }); expect(latest!.ready).toBe(true);
    const generation = latest!.readyGeneration;
    identity(); fixture.decrypt.mockReturnValue(new Promise(() => {})); await render(<Probe />);
    expect(latest!.ready).toBe(false); expect(latest!.readyGeneration).not.toBe(generation);
  });
});
