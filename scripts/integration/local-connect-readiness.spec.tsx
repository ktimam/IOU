// @vitest-environment-options {"url":"http://localhost:3000/openchat/connect.html"}
// Actual setup page, consent state machine, app catalog builder and processor integrity check.
// Authentication, authenticated actor reads and the decrypted-Type hook are synthetic boundaries.
import { createHash, webcrypto } from "node:crypto";
import { act, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Principal } from "@dfinity/principal";
import { IDL } from "@dfinity/candid";

const fixture = vi.hoisted(() => ({
  identity: undefined as unknown,
  principal: "synthetic-a",
  actor: null as any,
  templates: null as any,
  templateHook: vi.fn(),
  opener: { closed: false, postMessage: vi.fn() },
  parent: { closed: false, postMessage: vi.fn() },
  keyring: { get: vi.fn(), unwrapFor: vi.fn() },
  signIn: vi.fn(), signOut: vi.fn(),
  deliveryKey: undefined as any,
  loadDeliveryKey: vi.fn(),
  loadSetupSheet: vi.fn(),
}));
vi.mock("../../src/features/auth/AuthProvider", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => ({ identity: fixture.identity,
    state: fixture.identity ? { kind: "authenticated", principal: fixture.principal } : { kind: "anonymous" },
    signIn: fixture.signIn, signOut: fixture.signOut }),
}));
vi.mock("../../src/features/auth/config", () => ({ host: "http://127.0.0.1:4943", canisterId: "rrkah-fqaaa-aaaaa-aaaaq-cai" }));
vi.mock("../../src/features/flows/useActor", () => ({
  useActor: () => ({ actor: fixture.actor, err: undefined }),
  unwrap: (value: unknown) => Array.isArray(value) ? value[0] ?? null : value ?? null,
}));
vi.mock("../../src/features/flows/SheetKeyContext", () => ({
  SheetKeyProvider: ({ children }: { children: ReactNode }) => children,
  useSheetKey: () => fixture.keyring,
}));
vi.mock("../../src/features/openchat/LocalDeliveryKeyProvider", () => ({
  LocalDeliveryKeyProvider: ({ children }: { children: ReactNode }) => children,
  useLocalDeliveryKey: () => ({ ready: !!fixture.identity, load: fixture.loadDeliveryKey }),
}));
// Connect uses the already mocked authenticated key provider. Receiving/listing is a
// separate service test boundary; do not instantiate a second key/backend session here.
vi.mock("../../src/features/openchat/consumerKeypair", () => ({
  captureConsumerKeypairSession: vi.fn(() => { throw new Error("Connect must not own the receiving key session"); }),
  loadExistingConsumerKeypair: vi.fn(() => { throw new Error("Connect must use its existing key provider"); }),
}));
vi.mock("../../src/features/templates/PairTemplatesContext", () => ({
  usePairTemplates: (...args: unknown[]) => { fixture.templateHook(...args); return fixture.templates; },
}));
// The read-only sheet loader has separate real-crypto unit coverage. Keep this
// mounted suite focused on scope, parent binding, consent and session invalidation.
vi.mock("../../src/features/openchat/localSetupSheet", () => ({
  loadLocalSetupSheet: (...args: unknown[]) => fixture.loadSetupSheet(...args),
}));
import { LocalConnectPage } from "../../src/features/openchat/LocalConnectPage";
import { LOCAL_APP_SETUP_MS } from "../../src/features/openchat/localAppSetupConsent";
import { localSetupAccountId } from "../../src/features/openchat/localAppSetupV2";
import { createLocalProcessorContext } from "../../src/features/openchat/localProcessorContext";

const sheetId = "0123456789abcdef";
const otherSheetId = "fedcba9876543210";
// Use the real wire decoder: vec nat64 is a BigUint64Array, not a normal JS array.
const decodedSheetIds = (ids: readonly string[]) => IDL.decode([IDL.Vec(IDL.Nat64)],
  IDL.encode([IDL.Vec(IDL.Nat64)], [ids.map(id => BigInt(`0x${id}`))]))[0] as BigUint64Array;
const connectionId = "A".repeat(43);
const clientOrigin = "https://client.example";
const source = new TextEncoder().encode("// synthetic public processor; never executed");
const metadata = { sha256: createHash("sha256").update(source).digest("hex"), byteLength: source.byteLength };
const type = { id: "type-1", name: "Private Choice", direction: "debt", txn_type: "iou", keywords: ["private-keyword"], fee_percent: 8, rev: 1, updatedAt: 1 };
let root: Root;
let container: HTMLDivElement;
let digests: Promise<ArrayBuffer>[];
// Match bootstrapApp.tsx: development replays effects under StrictMode. A plain mount can hide
// a cleanup that permanently closes a session subsequently reused by the replayed setup.
const render = async (child: ReactNode = <LocalConnectPage />) => { await act(async () => { root.render(<StrictMode>{child}</StrictMode>); }); };
const click = async (element: HTMLElement) => { await act(async () => { element.click(); }); };
const button = (label: string) => [...container.querySelectorAll("button")].find(item => item.textContent === label);
const select = async (value: string) => { await act(async () => {
  const element = container.querySelector("select")!;
  element.value = value; element.dispatchEvent(new Event("change", { bubbles: true }));
}); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function request(patch: Record<string, unknown> = {}, origin = clientOrigin, sender: unknown = fixture.opener) {
  await act(async () => { window.dispatchEvent(new MessageEvent("message", { origin, source: sender as Window,
    data: { type: "oc:app-setup:connect", version: 1, connectionId, appId: "iou", ...patch } })); });
}
async function ready() { await render(); await request(); await select(sheetId); }
function publicFetch(overrides: { sha256?: string; wait?: Promise<void> } = {}) {
  const fetch = vi.fn(async (url: string) => {
    await overrides.wait;
    if (url.endsWith(".sha256.json")) return { ok: true, json: async () => ({ ...metadata, sha256: overrides.sha256 ?? metadata.sha256 }) };
    if (url.endsWith(".js")) return { ok: true, arrayBuffer: async () => source.slice().buffer };
    throw new Error("Unexpected fetch");
  });
  vi.stubGlobal("fetch", fetch); return fetch;
}
async function settledDigest() {
  await act(async () => {
    await vi.waitFor(() => expect(digests.length).toBeGreaterThanOrEqual(1));
    await Promise.all(digests);
    // Public-key export/fingerprint is another real crypto turn after processor validation.
    await new Promise(resolve => setTimeout(resolve, 20));
  });
}
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  digests = [];
  fixture.deliveryKey = await webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  fixture.loadDeliveryKey.mockResolvedValue(fixture.deliveryKey);
  vi.stubGlobal("crypto", { subtle: { digest: (algorithm: string, bytes: BufferSource) => {
    const pending = webcrypto.subtle.digest(algorithm, bytes); digests.push(pending); return pending;
  }, exportKey: webcrypto.subtle.exportKey.bind(webcrypto.subtle) }, getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No network before explicit consent"); }));
  Object.defineProperty(window, "opener", { configurable: true, value: fixture.opener });
  Object.defineProperty(window, "parent", { configurable: true, value: window });
  window.history.replaceState(null, "", "/openchat/connect.html");
  fixture.identity = { privateMaterial: "private-key-material" }; fixture.principal = "synthetic-a";
  fixture.opener.closed = false; fixture.opener.postMessage.mockReset();
  fixture.parent.closed = false; fixture.parent.postMessage.mockReset();
  fixture.keyring.get.mockReturnValue(undefined); fixture.keyring.unwrapFor.mockResolvedValue(undefined);
  fixture.signIn.mockResolvedValue(undefined); fixture.signOut.mockResolvedValue(undefined);
  fixture.templates = { shared: [type], ready: true, readyGeneration: {}, loading: false, error: undefined };
  fixture.loadSetupSheet.mockImplementation(async ({ sheetId: selectedSheet }: { sheetId: string }) => ({
    sheetId: selectedSheet, pairId: selectedSheet === sheetId ? "1111111111111111" : "2222222222222222",
    label: selectedSheet === sheetId ? "First account — Current sheet" : "Second account — Current sheet",
    processorContext: createLocalProcessorContext([type as any], "EGP"),
  }));
  fixture.actor = {
    get_my_pairs: vi.fn(async () => [sheetId, otherSheetId].map((id, index) => ({ id: index ? "2222222222222222" : "1111111111111111",
      active_sheet_id: [id], archived_at: [], other_principal: { toText: () => "synthetic-partner" } }))),
    get_my_user: vi.fn(async () => [{ default_currency: ["EGP"] }]),
    get_sheet: vi.fn(async () => []), get_pair: vi.fn(async () => []),
    add_entry_batch: vi.fn(), set_pair_templates: vi.fn(),
    create_encrypted_inbox_grant: vi.fn(async (input: Record<string, unknown>) => ({ Ok: {
      ...input, inbox_id: "a".repeat(64), created_at_ms: BigInt(Date.now() - 1), revoked: false,
    } })),
  };
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});

describe("scoped account and per-chat setup in the existing iframe page", () => {
  const handle = "B".repeat(42) + "A";
  async function scopeFixture(mapped = sheetId) {
    fixture.principal = Principal.selfAuthenticating(new Uint8Array([1, 2, 3])).toText();
    const links = new Map(mapped ? [[handle, mapped]] : []);
    fixture.actor.chat_sheet_links = vi.fn(async () => [...links].map(([chat_key, id]) => ({ chat_key, sheet_id: BigInt(`0x${id}`) })));
    fixture.actor.chat_routable_sheet_ids = vi.fn(async () => decodedSheetIds([sheetId, otherSheetId]));
    fixture.actor.set_chat_sheet_link = vi.fn(async (key: string, id: bigint) => { links.set(key, id.toString(16).padStart(16, "0")); });
    fixture.actor.list_encrypted_inbox_grants = vi.fn(async () => ({ Ok: { grants: [], next: [] } }));
    Object.defineProperty(window, "parent", { configurable: true, value: fixture.parent });
    const accountId = await localSetupAccountId({ principal: fixture.principal, backendHost: "http://127.0.0.1:4943", backendCanisterId: "rrkah-fqaaa-aaaaa-aaaaq-cai" });
    return { accountId, links };
  }
  async function requestScope(setupContext: unknown) {
    await render(); await request({ version: 2, setupContext }, clientOrigin, fixture.parent);
  }
  async function waitForCommit(assertion: () => void) {
    // Each act must finish to commit state after real WebCrypto resolves. Polling
    // DOM inside one long act can hold that render until its own timeout.
    const deadline = performance.now() + 1000;
    while (performance.now() < deadline) {
      try { assertion(); return; } catch { /* Preserve the same bounded retry as waitFor. */ }
      const remaining = deadline - performance.now();
      if (remaining > 0) await act(async () => { await new Promise(resolve => setTimeout(resolve, Math.min(20, remaining))); });
    }
    assertion();
  }
  async function waitEnabled(label: string) {
    await waitForCommit(() => expect(button(label)?.disabled).toBe(false));
  }
  async function waitShared() {
    await waitForCommit(() => expect(fixture.parent.postMessage).toHaveBeenCalledOnce());
    return JSON.parse(fixture.parent.postMessage.mock.calls[0][0].catalogJson);
  }
  it("connects the IOU account without a sheet picker or sheet reads", async () => {
    const { accountId } = await scopeFixture();
    await requestScope({ version: 2, scope: "account", routes: [] }); await waitEnabled("Connect");
    expect(container.textContent).toContain("Connect your IOU account. Each chat keeps its separately selected sheet.");
    expect(container.querySelector("select")).toBeNull();
    expect(fixture.actor.get_my_pairs).not.toHaveBeenCalled();
    expect(fixture.actor.chat_sheet_links).not.toHaveBeenCalled();
    expect(container.textContent).toContain("encrypted drafts for 90 days");
    expect(container.textContent).toContain("up to 30 days and still need your review and Save");
    expect(fixture.loadDeliveryKey).not.toHaveBeenCalled();
    expect(fixture.parent.postMessage).not.toHaveBeenCalled();
    publicFetch(); await click(button("Connect")!);
    const result = await waitShared();
    expect(container.textContent).toContain("Setup was sent to the requesting client.");
    expect(container.textContent).toContain("Connect IOU to OpenChat without sharing entries, sign-in or private keys.");
    expect(container.textContent).not.toContain("Choose the sheet to use with OpenChat.");
    expect(container.querySelector("select")).toBeNull();
    expect(result).toMatchObject({ version: 2, scope: "account", accountId, routes: [] });
    expect(JSON.parse(result.catalogJson).apps[0].deliveryEncryption).toBeUndefined();
    expect(fixture.actor.set_chat_sheet_link).not.toHaveBeenCalled();
    expect(fixture.actor.create_encrypted_inbox_grant).not.toHaveBeenCalled();
    expect(fixture.parent.postMessage.mock.calls[0]).toEqual([expect.objectContaining({ version: 2, connectionId }), clientOrigin]);
    expect(fixture.opener.postMessage).not.toHaveBeenCalled();
  });
  it("preselects this chat's existing sheet and saves only after explicit consent", async () => {
    const { accountId } = await scopeFixture(otherSheetId);
    await requestScope({ version: 2, scope: "chat", accountId, handle }); await waitEnabled("Save setup");
    expect(container.textContent).toContain("Choose the sheet to use with OpenChat.");
    expect(container.querySelector("select")?.value).toBe(otherSheetId);
    expect(container.textContent).toContain("Private Choice: You owe; keywords: private-keyword");
    expect(container.textContent).toContain("Currency: EGP");
    expect(container.textContent).toContain("up to 30 days and still need your review and Save");
    expect(fixture.actor.set_chat_sheet_link).not.toHaveBeenCalled();
    expect(fixture.actor.create_encrypted_inbox_grant).not.toHaveBeenCalled();
    publicFetch(); await click(button("Save setup")!);
    const result = await waitShared();
    expect(result.routes).toHaveLength(1); expect(result.routes[0].handle).toBe(handle);
    expect(JSON.parse(result.routes[0].catalogJson).apps[0].recipientLabel).toContain("Second account");
    expect(fixture.actor.set_chat_sheet_link).not.toHaveBeenCalled();
    expect(fixture.actor.create_encrypted_inbox_grant).toHaveBeenCalledOnce();
  });
  it.each([sheetId, "1234567890123456"])("loads Candid nat64 routing IDs for sheet %s without coercing hexadecimal strings", async id => {
    const { accountId } = await scopeFixture(id);
    const routed = decodedSheetIds([id]);
    expect(routed).toBeInstanceOf(BigUint64Array);
    fixture.actor.chat_routable_sheet_ids.mockResolvedValue(routed);
    fixture.actor.get_my_pairs.mockResolvedValue([{ id: "1111111111111111", active_sheet_id: [id], archived_at: [],
      other_principal: { toText: () => "synthetic-partner" } }]);
    await requestScope({ version: 2, scope: "chat", accountId, handle }); await waitEnabled("Save setup");
    expect([...container.querySelectorAll("option")].map(option => option.value)).toEqual(["", id]);
    expect(container.querySelector("select")?.value).toBe(id);
    expect(fixture.actor.set_chat_sheet_link).not.toHaveBeenCalled();
    expect(fixture.actor.create_encrypted_inbox_grant).not.toHaveBeenCalled();
    expect(fixture.parent.postMessage).not.toHaveBeenCalled();
  });
  it("does not choose a sheet for an unconfigured chat and writes only its explicit choice", async () => {
    const { accountId, links } = await scopeFixture("");
    await requestScope({ version: 2, scope: "chat", accountId, handle });
    await waitForCommit(() => expect(container.querySelectorAll("option"), container.textContent ?? "").toHaveLength(3));
    expect(container.querySelector("select")?.value).toBe(""); expect(button("Save setup")?.disabled).toBe(true);
    await select(sheetId); await waitEnabled("Save setup"); publicFetch(); await click(button("Save setup")!); await waitShared();
    expect(fixture.actor.set_chat_sheet_link).toHaveBeenCalledExactlyOnceWith(handle, BigInt(`0x${sheetId}`));
    expect([...links]).toEqual([[handle, sheetId]]);
  });
  it("rejects another IOU account before sheet reads, key recovery or mutation", async () => {
    await scopeFixture();
    await requestScope({ version: 2, scope: "chat", accountId: "D".repeat(42) + "A", handle });
    await waitForCommit(() => expect(container.textContent).toContain("Sign in to the IOU account already connected"));
    expect(button("Save setup")?.disabled).toBe(true);
    expect(fixture.actor.get_my_pairs).not.toHaveBeenCalled(); expect(fixture.loadDeliveryKey).not.toHaveBeenCalled();
    expect(fixture.actor.set_chat_sheet_link).not.toHaveBeenCalled(); expect(fixture.actor.create_encrypted_inbox_grant).not.toHaveBeenCalled();
  });
  it("keeps the Type preview and disables sharing when either private slot is unreadable", async () => {
    const { accountId } = await scopeFixture(); fixture.loadSetupSheet.mockRejectedValueOnce(new Error("unreadable Types"));
    await requestScope({ version: 2, scope: "chat", accountId, handle });
    await waitForCommit(() => expect(container.textContent).toContain("This sheet’s private Types could not be read. Sharing is disabled."));
    expect(button("Save setup")?.disabled).toBe(true); expect(fixture.loadDeliveryKey).not.toHaveBeenCalled();
    expect(fixture.actor.create_encrypted_inbox_grant).not.toHaveBeenCalled();
  });
  it("rejects Type changes between the visible preview and explicit Save setup", async () => {
    const { accountId } = await scopeFixture();
    await requestScope({ version: 2, scope: "chat", accountId, handle }); await waitEnabled("Save setup");
    const load = fixture.loadSetupSheet.getMockImplementation()!;
    fixture.loadSetupSheet.mockImplementationOnce(async (...args: unknown[]) => {
      const sheet = await load(...args); return { ...sheet, processorContext: { ...sheet.processorContext, types: [] } };
    });
    publicFetch(); await click(button("Save setup")!);
    await waitForCommit(() => expect(container.textContent).toContain("setup changed after its preview"));
    expect(fixture.parent.postMessage).not.toHaveBeenCalled(); expect(fixture.actor.create_encrypted_inbox_grant).not.toHaveBeenCalled();
    expect(fixture.actor.set_chat_sheet_link).not.toHaveBeenCalled();
  });
  it("cannot share or write a mapping after its authenticated session changes during grant creation", async () => {
    const { accountId } = await scopeFixture(), gate = deferred<any>();
    fixture.actor.create_encrypted_inbox_grant.mockImplementationOnce(() => gate.promise);
    await requestScope({ version: 2, scope: "chat", accountId, handle }); await waitEnabled("Save setup");
    publicFetch(); await click(button("Save setup")!);
    await waitForCommit(() => expect(fixture.actor.create_encrypted_inbox_grant).toHaveBeenCalledOnce());
    const submitted = fixture.actor.create_encrypted_inbox_grant.mock.calls[0][0];
    fixture.identity = { privateMaterial: "new-session" }; await render();
    await act(async () => { gate.resolve({ Ok: { ...submitted, inbox_id: "a".repeat(64), created_at_ms: BigInt(Date.now() - 1), revoked: false } }); });
    expect(fixture.parent.postMessage).not.toHaveBeenCalled(); expect(fixture.actor.set_chat_sheet_link).not.toHaveBeenCalled();
  });
});
afterEach(async () => {
  await act(async () => { root.unmount(); }); container.remove();
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

describe("no-file IOU setup consent", () => {
  it("keeps one live consent after Strict Mode effect replay", async () => {
    vi.useFakeTimers();
    await render();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(container.textContent).toContain("Waiting for a setup request");
    expect(container.textContent).toContain("Connect IOU to OpenChat without sharing entries, sign-in or private keys.");
    expect(container.textContent).not.toContain("Choose the sheet to use with OpenChat.");
    expect(container.textContent).not.toContain("Connection closed or expired");
    expect(vi.getTimerCount()).toBe(1);
    await request();
    expect(container.textContent).toContain(clientOrigin);
    expect(container.textContent).toContain("Choose the sheet to use with OpenChat.");
    expect(container.querySelector("select")).not.toBeNull();
    expect(fixture.opener.postMessage).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("waits for its original requester and shares one exact setup only after visible consent", async () => {
    await render();
    expect(fixture.actor.get_my_pairs).not.toHaveBeenCalled();
    await request({}, clientOrigin, {});
    await request({ connectionId: "not-a-nonce" });
    expect(container.querySelector("select")).toBeNull();
    await request(); await select(sheetId);
    expect(container.textContent).toContain(clientOrigin);
    expect(container.textContent).toContain("Account 1 — Current sheet");
    for (const privateId of [sheetId, otherSheetId, "1111111111111111", "synthetic-a", "synthetic-partner"]) {
      expect(container.textContent).not.toContain(privateId);
    }
    expect(container.textContent).toContain("Private Choice: You owe; keywords: private-keyword");
    expect(fixture.templateHook).toHaveBeenCalledWith("1111111111111111", sheetId, { requireReadableSlots: true });
    expect(fetch).not.toHaveBeenCalled();
    expect(fixture.opener.postMessage).not.toHaveBeenCalled();
    expect(fixture.actor.create_encrypted_inbox_grant).not.toHaveBeenCalled();
    const fetcher = publicFetch();
    await click(button("Connect")!);
    // Wait for the real asynchronous WebCrypto digest, not a mocked verification result.
    await settledDigest();
    expect(fixture.opener.postMessage).toHaveBeenCalledOnce();
    const [message, target] = fixture.opener.postMessage.mock.calls[0];
    expect(target).toBe(clientOrigin);
    expect(Object.keys(message).sort()).toEqual(["appId", "catalogJson", "connectionId", "type", "version"]);
    expect(message).toMatchObject({ type: "oc:app-setup:result", version: 1, connectionId, appId: "iou" });
    const app = JSON.parse(message.catalogJson).apps[0];
    expect(app.destination).toBe("http://localhost:3000/openchat/import");
    expect(app.processor).toEqual(metadata);
    expect(app.recipientLabel).toBe("Account 1 — Current sheet");
    expect(app.deliveryEncryption).toMatchObject({ version: 1, scheme: "p256-hkdf-sha256-aes-256-gcm-v1", keyId: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(app.deliveryEncryption.publicKeySpki).toBeTruthy();
    expect(app.deliveryInbox).toMatchObject({ version: 1, kind: "ic-canister", host: "http://127.0.0.1:4943",
      canisterId: "rrkah-fqaaa-aaaaa-aaaaq-cai", inboxId: "a".repeat(64), writeCapability: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    expect(fixture.actor.create_encrypted_inbox_grant).toHaveBeenCalledOnce();
    const submittedGrant = fixture.actor.create_encrypted_inbox_grant.mock.calls[0][0];
    expect(submittedGrant).not.toHaveProperty("write_capability");
    expect(submittedGrant.recipient_key_id).toBe(app.deliveryEncryption.keyId);
    expect(fixture.loadDeliveryKey).toHaveBeenCalledWith(true);
    expect(app.actions[0].processorContext).toMatchObject({ defaultCurrency: "EGP", draftEditorDefaults: "host-v1",
      types: [{ id: type.id, name: type.name, direction: "debt", keywords: type.keywords, txn_type: "iou" }] });
    expect(app.actions[0].draftEditor.choices[0].options[0]).toMatchObject({ value: type.id, label: type.name,
      defaults: [{ field: "direction", value: "debt" }] });
    expect(message.catalogJson).not.toContain("fee_percent");
    expect(message.catalogJson).not.toContain("synthetic-a");
    expect(message.catalogJson).not.toContain("private-key-material");
    expect(fetcher.mock.calls).toEqual([
      ["/openchat/local-processor-v1.sha256.json", { credentials: "omit", cache: "no-store" }],
      ["/openchat/local-processor-v1.js", { credentials: "omit", cache: "no-store" }],
    ]);
    expect(container.querySelector("a[download]")).toBeNull();
    expect(fixture.actor.add_entry_batch).not.toHaveBeenCalled();
    expect(fixture.actor.set_pair_templates).not.toHaveBeenCalled();
    await request(); expect(fixture.opener.postMessage).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Setup was sent");
    expect(container.textContent).toContain("No entry was saved");
  });

  it("permits initial sign-in but rejects an authenticated account replacement", async () => {
    fixture.identity = undefined; await render(); await request();
    expect(button("Sign in to IOU")).toBeDefined();
    expect(fixture.actor.get_my_pairs).not.toHaveBeenCalled();
    fixture.identity = {}; await render(); await select(sheetId);
    expect(button("Connect")).toBeDefined();
    fixture.principal = "synthetic-b"; fixture.identity = {}; await render();
    expect(button("Connect")).toBeUndefined();
    expect(container.textContent).toContain("sign-in changed");
    expect(fixture.opener.postMessage).not.toHaveBeenCalled();
  });

  it.each(["origin", "nonce", "sheet", "cancel"])("invalidates the exact consent on %s change", async (reason) => {
    await ready();
    if (reason === "origin") await request({}, "https://other.example");
    if (reason === "nonce") await request({ connectionId: "B".repeat(42) + "A" });
    if (reason === "sheet") await select(otherSheetId);
    if (reason === "cancel") {
      await click(button("Cancel connection")!);
      expect(container.textContent).toContain("Connect IOU to OpenChat without sharing entries, sign-in or private keys.");
      expect(container.textContent).not.toContain("Choose the sheet to use with OpenChat.");
    }
    expect(button("Connect")).toBeUndefined();
    await request();
    expect(button("Connect")).toBeUndefined();
    expect(fixture.opener.postMessage).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["account", "identity", "actor", "types", "generation", "unreadable", "logout", "pagehide", "unmount", "closed", "expiry"])("blocks late async setup delivery after %s changes", async (reason) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      await ready();
      const gate = deferred<void>(); publicFetch({ wait: gate.promise });
      await click(button("Connect")!);
      expect(fetch).toHaveBeenCalledTimes(2);
      if (reason === "account") { fixture.principal = "synthetic-b"; fixture.identity = {}; await render(); }
      if (reason === "identity") { fixture.identity = {}; await render(); }
      if (reason === "actor") { fixture.actor = { ...fixture.actor }; await render(); }
      if (reason === "types") { fixture.templates = { ...fixture.templates, shared: [{ ...type, name: "Changed" }] }; await render(); }
      if (reason === "generation") { fixture.templates = { ...fixture.templates, readyGeneration: {} }; await render(); }
      if (reason === "unreadable") { fixture.templates = { ...fixture.templates, ready: false, loading: true }; await render(); }
      if (reason === "logout") await click(button("Sign out")!);
      if (reason === "pagehide") await act(async () => { window.dispatchEvent(new Event("pagehide")); });
      if (reason === "unmount") await act(async () => { root.render(null); });
      if (reason === "closed") fixture.opener.closed = true;
      if (reason === "expiry") clock.mockReturnValue(1000 + LOCAL_APP_SETUP_MS);
      await act(async () => { gate.resolve(); });
      // Await both public byte reads and a real digest completion before asserting non-delivery.
      await settledDigest();
      expect(fixture.opener.postMessage).not.toHaveBeenCalled();
      expect(fixture.actor.add_entry_batch).not.toHaveBeenCalled();
      expect(fixture.actor.create_encrypted_inbox_grant).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });

  it("requires readable private Types and never substitutes empty public setup", async () => {
    fixture.templates = { ...fixture.templates, ready: false, error: "could not decrypt" };
    await ready();
    expect(button("Connect")!.disabled).toBe(true);
    await click(button("Connect")!);
    expect(fetch).not.toHaveBeenCalled(); expect(fixture.opener.postMessage).not.toHaveBeenCalled();
  });

  it("rejects a processor integrity mismatch before sharing any private catalog", async () => {
    await ready(); publicFetch({ sha256: "f".repeat(64) });
    await click(button("Connect")!);
    await settledDigest();
    expect(container.textContent).toContain("could not be verified");
    expect(fixture.opener.postMessage).not.toHaveBeenCalled();
  });

  it("does not resend after a postMessage failure with unknown delivery outcome", async () => {
    await ready(); publicFetch(); fixture.opener.postMessage.mockImplementationOnce(() => { throw new Error("closed during send"); });
    await click(button("Connect")!);
    await settledDigest();
    expect(container.textContent).toContain("delivery outcome is unknown");
    await request();
    expect(fixture.opener.postMessage).toHaveBeenCalledOnce();
    expect(button("Connect")).toBeUndefined();
  });

  it("does not share a private capability after Types change during the grant update", async () => {
    await ready(); publicFetch();
    const gate = deferred<unknown>();
    fixture.actor.create_encrypted_inbox_grant.mockImplementationOnce(() => gate.promise);
    await click(button("Connect")!); await settledDigest();
    await vi.waitFor(() => expect(fixture.actor.create_encrypted_inbox_grant).toHaveBeenCalledOnce());
    const submitted = fixture.actor.create_encrypted_inbox_grant.mock.calls[0][0];
    fixture.templates = { ...fixture.templates, shared: [{ ...type, name: "Changed after consent" }], readyGeneration: {} };
    await render();
    await act(async () => { gate.resolve({ Ok: { ...submitted, inbox_id: "a".repeat(64), created_at_ms: BigInt(Date.now() - 1), revoked: false } }); });
    expect(fixture.opener.postMessage).not.toHaveBeenCalled();
    expect(fixture.actor.add_entry_batch).not.toHaveBeenCalled();
  });

  it.each(["no-opener", "query", "fragment"])("rejects an unbound %s launch", async (reason) => {
    if (reason === "no-opener") Object.defineProperty(window, "opener", { configurable: true, value: null });
    else window.history.replaceState(null, "", `/openchat/connect.html${reason === "query" ? "?code=not-accepted" : "#not-accepted"}`);
    await render(); await request();
    expect(container.textContent).toContain("Open Apps in OpenChat and choose Connect to start.");
    expect(fixture.actor.get_my_pairs).not.toHaveBeenCalled();
    expect(fixture.opener.postMessage).not.toHaveBeenCalled();
  });

  it.each(["/openchat/connect/", "/openchat/connect.html/", "/openchat/connect.html/other", "/sheet/example"])("does not mount setup for another path or alias: %s", async (path) => {
    window.history.replaceState(null, "", path);
    await render(); await request();
    expect(container.textContent).toContain("Open Apps in OpenChat and choose Connect to start.");
    expect(fixture.actor.get_my_pairs).not.toHaveBeenCalled();
    expect(fixture.opener.postMessage).not.toHaveBeenCalled();
  });

  it("retains the exact stable publisher setup URL for existing clients", async () => {
    window.history.replaceState(null, "", "/openchat/connect");
    await ready();
    expect(button("Connect")).toBeDefined();
    expect(fixture.opener.postMessage).not.toHaveBeenCalled();
  });

  it("binds embedded setup to its exact parent and shares only after Connect", async () => {
    Object.defineProperty(window, "parent", { configurable: true, value: fixture.parent });
    await render();
    await request(); // An opener cannot claim an embedded page's parent-bound connection.
    expect(container.querySelector("select")).toBeNull();
    expect(fixture.actor.get_my_pairs).not.toHaveBeenCalled();
    await request({}, clientOrigin, fixture.parent); await select(sheetId);
    expect(container.textContent).toContain(clientOrigin);
    expect(container.textContent).toContain("Account 1 — Current sheet");
    expect(container.textContent).not.toContain(sheetId);
    expect(container.textContent).not.toContain(fixture.principal);
    expect(fetch).not.toHaveBeenCalled();
    expect(fixture.parent.postMessage).not.toHaveBeenCalled();
    publicFetch(); await click(button("Connect")!); await settledDigest();
    expect(fixture.parent.postMessage).toHaveBeenCalledOnce();
    expect(fixture.parent.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "oc:app-setup:result", version: 1, appId: "iou", connectionId,
    }), clientOrigin);
    expect(fixture.opener.postMessage).not.toHaveBeenCalled();
    expect(fixture.actor.add_entry_batch).not.toHaveBeenCalled();
    expect(fixture.actor.set_pair_templates).not.toHaveBeenCalled();
    await request({}, clientOrigin, fixture.parent);
    expect(fixture.parent.postMessage).toHaveBeenCalledOnce();
  });

  it("invalidates an embedded connection when its bound parent changes origin", async () => {
    Object.defineProperty(window, "parent", { configurable: true, value: fixture.parent });
    await render(); await request({}, clientOrigin, fixture.parent); await select(sheetId);
    expect(button("Connect")).toBeDefined();
    await request({}, "https://other.example", fixture.parent);
    expect(button("Connect")).toBeUndefined();
    await request({}, clientOrigin, fixture.parent);
    expect(button("Connect")).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(fixture.parent.postMessage).not.toHaveBeenCalled();
    expect(fixture.opener.postMessage).not.toHaveBeenCalled();
  });
});
