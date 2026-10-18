// @vitest-environment-options {"url":"http://localhost:3000/openchat/connect.html"}
// Mounted production code UI, real setup service, wire crypto and processor integrity.
// Synthetic boundaries: authentication/vault readiness, actor responses, decrypted sheet loader.
import { createHash, webcrypto } from "node:crypto";
import { act, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Principal } from "@dfinity/principal";
import { IDL } from "@dfinity/candid";
const fixture = vi.hoisted(() => ({ identity: undefined as unknown, principal: "", actor: null as any,
  keyring: { get: vi.fn(), unwrapFor: vi.fn() }, signIn: vi.fn(), signOut: vi.fn(), loadDeliveryKey: vi.fn(), loadSetupSheet: vi.fn() }));
vi.mock("../../src/features/auth/AuthProvider", () => ({ AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => ({ identity: fixture.identity, state: fixture.identity ? { kind: "authenticated", principal: fixture.principal } : { kind: "anonymous" }, signIn: fixture.signIn, signOut: fixture.signOut }) }));
vi.mock("../../src/features/auth/config", () => ({ host: "http://127.0.0.1:4943", canisterId: "rrkah-fqaaa-aaaaa-aaaaq-cai" }));
vi.mock("../../src/features/flows/useActor", () => ({ useActor: () => ({ actor: fixture.actor, err: undefined }), unwrap: (value: unknown) => Array.isArray(value) ? value[0] ?? null : value ?? null }));
vi.mock("../../src/features/flows/SheetKeyContext", () => ({ SheetKeyProvider: ({ children }: { children: ReactNode }) => children, useSheetKey: () => fixture.keyring }));
vi.mock("../../src/features/crypto/AccountVaultControls", () => ({ AccountVaultGate: ({ children }: { children: ReactNode }) => children }));
vi.mock("../../src/features/openchat/LocalDeliveryKeyProvider", () => ({ LocalDeliveryKeyProvider: ({ children }: { children: ReactNode }) => children, useLocalDeliveryKey: () => ({ ready: !!fixture.identity, load: fixture.loadDeliveryKey }) }));
vi.mock("../../src/features/openchat/localSetupSheet", () => ({ loadLocalSetupSheet: (...args: unknown[]) => fixture.loadSetupSheet(...args) }));
// The setup uses its authenticated key provider; it must never create a receiving-side actor/session.
vi.mock("../../src/features/openchat/consumerKeypair", () => ({
  captureConsumerKeypairSession: vi.fn(() => { throw new Error("Connect must not own the receiving key session"); }),
  loadExistingConsumerKeypair: vi.fn(() => { throw new Error("Connect must use its existing key provider"); }),
}));
import { LocalConnectPage } from "../../src/features/openchat/LocalConnectPage";
import { createSetupCode, decryptSetupCode, encryptSetupCode } from "../../src/features/openchat/appSetupCodeCrypto";
import { localSetupAccountId } from "../../src/features/openchat/localAppSetupV2";
import { createLocalProcessorContext } from "../../src/features/openchat/localProcessorContext";
const sheetId = "0123456789abcdef", otherSheetId = "fedcba9876543210", handle = "B".repeat(42) + "A";
const clientOrigin = "https://client.example", source = new TextEncoder().encode("// synthetic public processor; never executed");
const metadata = { sha256: createHash("sha256").update(source).digest("hex"), byteLength: source.byteLength };
const type = { id: "type-1", name: "Private Choice", direction: "debt", txn_type: "iou", keywords: ["private-keyword"], fee_percent: 8, rev: 1, updatedAt: 1 };
const decodedSheetIds = (ids: readonly string[]) => IDL.decode([IDL.Vec(IDL.Nat64)], IDL.encode([IDL.Vec(IDL.Nat64)], [ids.map(id => BigInt(`0x${id}`))]))[0] as BigUint64Array;
let root: Root, container: HTMLDivElement, accountId: string, links: Map<string, string>;
let code: Awaited<ReturnType<typeof createSetupCode>>, expiresAtMs: number, completionBytes: Uint8Array[];
const render = async (child: ReactNode = <LocalConnectPage />) => { await act(async () => { root.render(<StrictMode>{child}</StrictMode>); }); };
const click = async (element: HTMLElement) => { await act(async () => { element.click(); }); };
const button = (label: string) => [...container.querySelectorAll("button")].find(item => item.textContent === label);
async function input(value: string) { await act(async () => { const element = container.querySelector("input")!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); }); }
async function select(value: string) { await act(async () => { const element = container.querySelector("select")!; element.value = value; element.dispatchEvent(new Event("change", { bubbles: true })); }); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function waitForCommit(assertion: () => void) {
  // Separate act turns allow real WebCrypto to settle and React to commit under StrictMode.
  const deadline = performance.now() + 2000;
  while (performance.now() < deadline) { try { assertion(); return; } catch { /* bounded polling */ }
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); }); } assertion();
}
const waitEnabled = (label: string) => waitForCommit(() => expect(button(label)?.disabled).toBe(false));
function publicFetch(patch: { sha256?: string; wait?: Promise<void> } = {}) {
  const fetcher = vi.fn(async (url: string) => { await patch.wait;
    if (url.endsWith(".sha256.json")) return { ok: true, json: async () => ({ ...metadata, sha256: patch.sha256 ?? metadata.sha256 }) };
    if (url.endsWith(".js")) return { ok: true, arrayBuffer: async () => source.slice().buffer }; throw new Error("Unexpected network");
  }); vi.stubGlobal("fetch", fetcher); return fetcher;
}
async function issue(context: unknown, patch: Record<string, unknown> = {}) {
  code = await createSetupCode(); expiresAtMs = Date.now() + 590000;
  const encrypted_context = await encryptSetupCode(code.code, "context", JSON.stringify({ version: 1, appId: "iou",
    setupUrl: `${location.origin}${location.pathname}`, clientOrigin, expiresAtMs, setupContext: context, ...patch }));
  fixture.actor.claim_app_setup_code.mockResolvedValue({ Ok: { encrypted_context, expires_at_ms: BigInt(expiresAtMs) } });
}
async function claim(context: unknown, patch: Record<string, unknown> = {}) { await issue(context, patch); await render(); await input(code.code); await click(button("Continue")!); }
async function account() { await claim({ version: 2, scope: "account", routes: [] }); await waitEnabled("Connect"); }
async function chat(mapped = sheetId) { links.clear(); if (mapped) links.set(handle, mapped);
  await claim({ version: 2, scope: "chat", accountId, handle }); await waitForCommit(() => expect(container.querySelectorAll("option")).toHaveLength(3));
  if (!mapped) await select(sheetId); await waitEnabled("Save setup");
}
async function shared() { await waitForCommit(() => expect(container.textContent).toContain("Connected. Return to OpenChat and choose Check connection."));
  const wrapper = JSON.parse(await decryptSetupCode(code.code, "result", completionBytes.at(-1)!));
  expect(wrapper).toMatchObject({ version: 1, appId: "iou", setupUrl: `${location.origin}${location.pathname}`, requestId: code.requestId }); return JSON.parse(wrapper.catalogJson);
}
beforeEach(async () => {
  vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No fetch before explicit Connect"); }));
  Object.defineProperty(window, "parent", { configurable: true, value: window }); Object.defineProperty(window, "opener", { configurable: true, value: null });
  window.history.replaceState(null, "", "/openchat/connect.html"); fixture.identity = { privateMaterial: "private-key-material" };
  fixture.principal = Principal.selfAuthenticating(new Uint8Array([1, 2, 3])).toText(); fixture.signIn.mockResolvedValue(undefined); fixture.signOut.mockResolvedValue(undefined);
  fixture.keyring.get.mockReturnValue(undefined); fixture.keyring.unwrapFor.mockResolvedValue(undefined);
  fixture.loadDeliveryKey.mockResolvedValue(await webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]));
  fixture.loadSetupSheet.mockImplementation(async ({ sheetId: id }: { sheetId: string }) => ({ sheetId: id,
    pairId: id === sheetId ? "1111111111111111" : "2222222222222222", label: id === sheetId ? "First account — Current sheet" : "Second account — Current sheet",
    processorContext: createLocalProcessorContext([type as any], "EGP") }));
  links = new Map([[handle, sheetId]]); completionBytes = [];
  fixture.actor = {
    claim_app_setup_code: vi.fn(), complete_app_setup_code: vi.fn(async (_id, _proof, bytes: Uint8Array) => { completionBytes.push(bytes.slice()); return { Ok: { expires_at_ms: BigInt(expiresAtMs) } }; }),
    get_my_pairs: vi.fn(async () => [sheetId, otherSheetId].map((id, i) => ({ id: i ? "2222222222222222" : "1111111111111111", active_sheet_id: [id], archived_at: [] }))),
    get_my_user: vi.fn(async () => [{ default_currency: ["EGP"] }]), get_sheet: vi.fn(async () => []), get_pair: vi.fn(async () => []),
    chat_sheet_links: vi.fn(async () => [...links].map(([chat_key, id]) => ({ chat_key, sheet_id: BigInt(`0x${id}`) }))),
    chat_routable_sheet_ids: vi.fn(async () => decodedSheetIds([sheetId, otherSheetId])),
    set_chat_sheet_link: vi.fn(async (key: string, id: bigint) => { links.set(key, id.toString(16).padStart(16, "0")); }),
    list_encrypted_inbox_grants: vi.fn(async () => ({ Ok: { grants: [], next: [] } })),
    create_encrypted_inbox_grant: vi.fn(async (record: Record<string, unknown>) => ({ Ok: { ...record, inbox_id: "a".repeat(64), created_at_ms: BigInt(Date.now() - 1), revoked: false } })),
    add_entry_batch: vi.fn(), set_pair_templates: vi.fn(),
  };
  accountId = await localSetupAccountId({ principal: fixture.principal, backendHost: "http://127.0.0.1:4943", backendCanisterId: "rrkah-fqaaa-aaaaa-aaaaq-cai" });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("top-level code connection: production UI and real encrypted transport", () => {
  it("starts without opener, iframe, downloads, message exchange or automatic sharing", async () => {
    await render(); expect(button("Continue")?.disabled).toBe(true); expect(container.querySelector("input")?.getAttribute("autocomplete")).toBe("off");
    expect(container.querySelector("iframe, a[download]")).toBeNull(); expect(fetch).not.toHaveBeenCalled(); expect(fixture.actor.claim_app_setup_code).not.toHaveBeenCalled();
    await act(async () => { window.dispatchEvent(new MessageEvent("message", { origin: clientOrigin, data: { type: "oc:app-setup:connect", version: 2 } })); }); expect(button("Connect")).toBeUndefined();
  });
  it("permits ordinary sign-in before code entry", async () => {
    fixture.identity = undefined; await render(); await click(button("Sign in to IOU")!); expect(fixture.signIn).toHaveBeenCalledOnce();
    expect(container.querySelector("input")).toBeNull(); fixture.identity = {}; await render(); expect(button("Continue")).toBeDefined();
  });
  it("rejects malformed code locally without an actor call", async () => {
    await render(); await input("123456"); await click(button("Continue")!); await waitForCommit(() => expect(container.textContent).toContain("code could not be verified")); expect(fixture.actor.claim_app_setup_code).not.toHaveBeenCalled();
  });
  it.each(["expired", "wrong publisher"])("shows a recoverable code error for %s without preparing setup", async reason => {
    await issue({ version: 2, scope: "account", routes: [] }, reason === "wrong publisher" ? { setupUrl: "https://other.example/openchat/connect" } : {});
    if (reason === "expired") fixture.actor.claim_app_setup_code.mockResolvedValue({ Err: "Expired" }); await render(); await input(code.code); await click(button("Continue")!);
    await waitForCommit(() => expect(container.textContent).toContain("code could not be verified")); expect(button("Continue")?.disabled).toBe(false);
    expect(fixture.loadDeliveryKey).not.toHaveBeenCalled(); expect(fixture.actor.complete_app_setup_code).not.toHaveBeenCalled();
  });
  it.each(["account", "chat"])("cancels %s before consent without key, grant, mapping or entry writes", async scope => {
    if (scope === "account") await account(); else await chat(); await click(button("Cancel connection")!);
    expect(button("Connect")).toBeUndefined(); expect(button("Save setup")).toBeUndefined(); expect(container.querySelector("input")?.value).toBe("");
    expect(fixture.loadDeliveryKey).not.toHaveBeenCalled(); expect(fixture.actor.complete_app_setup_code).not.toHaveBeenCalled(); expect(fixture.actor.create_encrypted_inbox_grant).not.toHaveBeenCalled();
    expect(fixture.actor.set_chat_sheet_link).not.toHaveBeenCalled(); expect(fixture.actor.add_entry_batch).not.toHaveBeenCalled();
  });
  it("connects account without choosing or changing any chat's sheet", async () => {
    await account(); expect(container.querySelector("select")).toBeNull(); expect(container.textContent).toContain("without changing any chat's sheet");
    expect(container.textContent).toContain("encrypted drafts for 90 days"); expect(container.textContent).toContain("up to 30 days");
    expect(fixture.actor.get_my_pairs).not.toHaveBeenCalled(); expect(fixture.loadDeliveryKey).not.toHaveBeenCalled(); publicFetch(); await click(button("Connect")!);
    const result = await shared(); expect(result).toMatchObject({ version: 2, scope: "account", accountId, routes: [] });
    expect(JSON.parse(result.catalogJson).apps[0].deliveryEncryption).toBeUndefined(); expect(fixture.actor.create_encrypted_inbox_grant).not.toHaveBeenCalled();
    expect(fixture.actor.set_chat_sheet_link).not.toHaveBeenCalled(); expect(button("Continue")).toBeUndefined();
  });
  it("previews exact private Types and sheet; shares only encrypted scoped setup after consent", async () => {
    await chat(otherSheetId); expect(container.querySelector("select")?.value).toBe(otherSheetId); expect(container.textContent).toContain("Private Choice: You owe; keywords: private-keyword"); expect(container.textContent).toContain("Currency: EGP");
    expect(fixture.actor.create_encrypted_inbox_grant).not.toHaveBeenCalled(); const fetcher = publicFetch(); await click(button("Save setup")!);
    const result = await shared(), app = JSON.parse(result.routes[0].catalogJson).apps[0]; expect(result).toMatchObject({ scope: "chat", accountId, routes: [{ handle }] }); expect(app.recipientLabel).toContain("Second account");
    expect(app.processor).toEqual(metadata); expect(app.deliveryEncryption).toMatchObject({ scheme: "p256-hkdf-sha256-aes-256-gcm-v1" });
    expect(app.deliveryInbox).toMatchObject({ inboxId: "a".repeat(64), writeCapability: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    expect(app.actions[0].processorContext).toMatchObject({ defaultCurrency: "EGP", types: [{ id: type.id, name: type.name, direction: "debt" }] });
    expect(JSON.stringify(result)).not.toContain("private-key-material"); expect(JSON.stringify(result)).not.toContain("fee_percent"); expect(new TextDecoder().decode(completionBytes[0])).not.toContain("Private Choice");
    expect(fixture.actor.set_chat_sheet_link).not.toHaveBeenCalled(); expect(fixture.actor.add_entry_batch).not.toHaveBeenCalled(); expect(fixture.actor.set_pair_templates).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.map(row => row[0])).toEqual(["/openchat/local-processor-v1.sha256.json", "/openchat/local-processor-v1.js"]); expect(location.href).not.toContain(code.code); expect(location.hash).toBe(""); expect(location.search).toBe("");
  });
  it("changes only the explicitly selected chat route", async () => {
    await chat(); links.set("C".repeat(42) + "A", sheetId); await select(otherSheetId); await waitEnabled("Save setup"); publicFetch(); await click(button("Save setup")!); await shared();
    expect(fixture.actor.set_chat_sheet_link).toHaveBeenCalledExactlyOnceWith(handle, BigInt(`0x${otherSheetId}`)); expect(links.get("C".repeat(42) + "A")).toBe(sheetId);
  });
  it.each([sheetId, "1234567890123456"])("preserves decoded nat64 sheet ID %s", async id => {
    links.set(handle, id); fixture.actor.chat_routable_sheet_ids.mockResolvedValue(decodedSheetIds([id])); fixture.actor.get_my_pairs.mockResolvedValue([{ id: "1111111111111111", active_sheet_id: [id], archived_at: [] }]);
    await claim({ version: 2, scope: "chat", accountId, handle }); await waitEnabled("Save setup"); expect(container.querySelector("select")?.value).toBe(id);
  });
  it("rejects a different connected account before keys or sheet reads", async () => {
    await claim({ version: 2, scope: "chat", accountId: "A".repeat(43), handle }); await waitForCommit(() => expect(container.textContent).toContain("Sign in to the IOU account already connected"));
    expect(button("Save setup")?.disabled).toBe(true); expect(fixture.loadDeliveryKey).not.toHaveBeenCalled(); expect(fixture.actor.get_my_pairs).not.toHaveBeenCalled();
  });
  it("does not substitute empty Types when the preview cannot be read", async () => {
    fixture.loadSetupSheet.mockRejectedValue(new Error("unreadable")); await claim({ version: 2, scope: "chat", accountId, handle }); await waitForCommit(() => expect(fixture.loadSetupSheet).toHaveBeenCalled());
    expect(button("Save setup")?.disabled).toBe(true); expect(fixture.actor.create_encrypted_inbox_grant).not.toHaveBeenCalled();
  });
  it("rejects changed sheet context after visible preview before grant creation", async () => {
    await chat(); const preview = await fixture.loadSetupSheet.mock.results.at(-1)!.value;
    fixture.loadSetupSheet.mockResolvedValue({ ...preview, processorContext: createLocalProcessorContext([{ ...type, name: "Changed after preview" } as any], "EGP") });
    publicFetch(); await click(button("Save setup")!); await waitForCommit(() => expect(container.textContent).toContain("changed after its preview"));
    expect(fixture.actor.create_encrypted_inbox_grant).not.toHaveBeenCalled(); expect(fixture.actor.complete_app_setup_code).not.toHaveBeenCalled();
  });
  it("rejects processor integrity mismatch before sharing or grant creation", async () => {
    await chat(); publicFetch({ sha256: "f".repeat(64) }); await click(button("Save setup")!); await waitForCommit(() => expect(container.textContent).toContain("could not finish this setup"));
    expect(fixture.actor.create_encrypted_inbox_grant).not.toHaveBeenCalled(); expect(fixture.actor.complete_app_setup_code).not.toHaveBeenCalled();
  });
  it.each(["principal", "identity", "actor", "logout", "pagehide", "unmount", "expiry", "cancel"])("blocks late preparation after %s change", async reason => {
    const clock = vi.spyOn(Date, "now"); await chat(); const gate = deferred<void>(), savedActor = fixture.actor; publicFetch({ wait: gate.promise }); await click(button("Save setup")!); await waitForCommit(() => expect(fetch).toHaveBeenCalledTimes(2));
    if (reason === "principal") { fixture.principal = Principal.selfAuthenticating(new Uint8Array([4, 5, 6])).toText(); await render(); }
    if (reason === "identity") { fixture.identity = {}; await render(); } if (reason === "actor") { fixture.actor = { ...fixture.actor }; await render(); }
    if (reason === "logout") await click(button("Sign out")!); if (reason === "cancel") await click(button("Cancel connection")!);
    if (reason === "pagehide") await act(async () => { window.dispatchEvent(new Event("pagehide")); }); if (reason === "unmount") await render(null); if (reason === "expiry") clock.mockReturnValue(expiresAtMs);
    await act(async () => { gate.resolve(); await new Promise(resolve => setTimeout(resolve, 50)); }); expect(savedActor.create_encrypted_inbox_grant).not.toHaveBeenCalled(); expect(savedActor.complete_app_setup_code).not.toHaveBeenCalled(); expect(savedActor.add_entry_batch).not.toHaveBeenCalled();
  });
  it("cancellation after grant submission never sends a late result or writes a mapping", async () => {
    await chat(""); const gate = deferred<any>(); fixture.actor.create_encrypted_inbox_grant.mockReturnValueOnce(gate.promise); publicFetch(); await click(button("Save setup")!);
    await waitForCommit(() => expect(fixture.actor.create_encrypted_inbox_grant).toHaveBeenCalledOnce()); const grant = fixture.actor.create_encrypted_inbox_grant.mock.calls[0][0]; await click(button("Cancel connection")!);
    await act(async () => { gate.resolve({ Ok: { ...grant, inbox_id: "a".repeat(64), created_at_ms: BigInt(Date.now()), revoked: false } }); }); expect(fixture.actor.set_chat_sheet_link).not.toHaveBeenCalled(); expect(fixture.actor.complete_app_setup_code).not.toHaveBeenCalled();
    // A submitted grant may exist; cancellation is not falsely asserted to roll it back.
  });
  it("retries identical prepared ciphertext after unknown completion without reminting or rewriting the route", async () => {
    await chat(""); const first: Uint8Array[] = []; fixture.actor.complete_app_setup_code.mockImplementationOnce(async (_id, _proof, bytes: Uint8Array) => { first.push(bytes.slice()); throw new Error("response lost"); });
    publicFetch(); await click(button("Save setup")!); await waitEnabled("Retry same connection"); expect(container.textContent).toContain("response was not confirmed"); expect(container.querySelector("select")?.disabled).toBe(true);
    const reads = fixture.loadSetupSheet.mock.calls.length; await click(button("Retry same connection")!); await shared(); expect(completionBytes[0]).toEqual(first[0]);
    expect(fixture.actor.create_encrypted_inbox_grant).toHaveBeenCalledOnce(); expect(fixture.actor.set_chat_sheet_link).toHaveBeenCalledOnce(); expect(fixture.loadSetupSheet).toHaveBeenCalledTimes(reads); expect(fixture.actor.complete_app_setup_code).toHaveBeenCalledTimes(2);
  });
  it.each(["query", "fragment", "iframe"])("rejects %s setup so codes never enter URLs or embedded storage", async reason => {
    if (reason === "iframe") Object.defineProperty(window, "parent", { configurable: true, value: {} }); else window.history.replaceState(null, "", `/openchat/connect.html${reason === "query" ? "?code=not-accepted" : "#not-accepted"}`);
    await render(); expect(container.textContent).toContain("Open Apps in OpenChat and choose Connect to start."); expect(container.querySelector("input")).toBeNull();
  });
  it.each(["/openchat/connect/", "/openchat/connect.html/", "/openchat/connect.html/other", "/sheet/example"])("rejects another path or alias %s", async path => { window.history.replaceState(null, "", path); await render(); expect(container.querySelector("input")).toBeNull(); });
  it("retains exact stable publisher setup URL without requiring an opener", async () => { window.history.replaceState(null, "", "/openchat/connect"); await account(); publicFetch(); await click(button("Connect")!); await shared(); });
});
