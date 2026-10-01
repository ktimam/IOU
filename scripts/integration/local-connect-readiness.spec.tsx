// @vitest-environment-options {"url":"http://localhost:3000/openchat/connect"}
// Actual setup page, consent state machine, app catalog builder and processor integrity check.
// Authentication, authenticated actor reads and the decrypted-Type hook are synthetic boundaries.
import { createHash, webcrypto } from "node:crypto";
import { act, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  identity: undefined as unknown,
  principal: "synthetic-a",
  actor: null as any,
  templates: null as any,
  templateHook: vi.fn(),
  opener: { closed: false, postMessage: vi.fn() },
  signIn: vi.fn(), signOut: vi.fn(),
  deliveryKey: undefined as any,
  loadDeliveryKey: vi.fn(),
}));
vi.mock("../../src/features/auth/AuthProvider", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => ({ identity: fixture.identity,
    state: fixture.identity ? { kind: "authenticated", principal: fixture.principal } : { kind: "anonymous" },
    signIn: fixture.signIn, signOut: fixture.signOut }),
}));
vi.mock("../../src/features/auth/config", () => ({ host: "http://127.0.0.1:4943", canisterId: "aaaaa-aa" }));
vi.mock("../../src/features/flows/useActor", () => ({
  useActor: () => ({ actor: fixture.actor, err: undefined }),
  unwrap: (value: unknown) => Array.isArray(value) ? value[0] ?? null : value ?? null,
}));
vi.mock("../../src/features/flows/SheetKeyContext", () => ({
  SheetKeyProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../src/features/openchat/LocalDeliveryKeyProvider", () => ({
  LocalDeliveryKeyProvider: ({ children }: { children: ReactNode }) => children,
  useLocalDeliveryKey: () => ({ ready: !!fixture.identity, load: fixture.loadDeliveryKey }),
}));
vi.mock("../../src/features/templates/PairTemplatesContext", () => ({
  usePairTemplates: (...args: unknown[]) => { fixture.templateHook(...args); return fixture.templates; },
}));
import { LocalConnectPage } from "../../src/features/openchat/LocalConnectPage";
import { LOCAL_APP_SETUP_MS } from "../../src/features/openchat/localAppSetupConsent";

const sheetId = "0123456789abcdef";
const otherSheetId = "fedcba9876543210";
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
  }, exportKey: webcrypto.subtle.exportKey.bind(webcrypto.subtle) } });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No network before explicit consent"); }));
  Object.defineProperty(window, "opener", { configurable: true, value: fixture.opener });
  window.history.replaceState(null, "", "/openchat/connect");
  fixture.identity = { privateMaterial: "private-key-material" }; fixture.principal = "synthetic-a";
  fixture.opener.closed = false; fixture.opener.postMessage.mockReset();
  fixture.signIn.mockResolvedValue(undefined); fixture.signOut.mockResolvedValue(undefined);
  fixture.templates = { shared: [type], ready: true, readyGeneration: {}, loading: false, error: undefined };
  fixture.actor = {
    get_my_pairs: vi.fn(async () => [sheetId, otherSheetId].map((id, index) => ({ id: index ? "2222222222222222" : "1111111111111111",
      active_sheet_id: [id], archived_at: [], other_principal: { toText: () => "synthetic-partner" } }))),
    get_my_user: vi.fn(async () => [{ default_currency: ["EGP"] }]),
    add_entry_batch: vi.fn(), set_pair_templates: vi.fn(),
  };
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
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
    expect(container.textContent).not.toContain("Connection closed or expired");
    expect(vi.getTimerCount()).toBe(1);
    await request();
    expect(container.textContent).toContain(clientOrigin);
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
    expect(container.textContent).toContain(`sheet ${sheetId}`);
    expect(container.textContent).toContain("Private Choice: You owe; keywords: private-keyword");
    expect(fixture.templateHook).toHaveBeenCalledWith("1111111111111111", sheetId, { requireReadableSlots: true });
    expect(fetch).not.toHaveBeenCalled();
    expect(fixture.opener.postMessage).not.toHaveBeenCalled();
    const fetcher = publicFetch();
    await click(button("Connect / share setup")!);
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
    expect(app.recipientLabel).toContain(sheetId);
    expect(app.deliveryEncryption).toMatchObject({ version: 1, scheme: "p256-hkdf-sha256-aes-256-gcm-v1", keyId: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(app.deliveryEncryption.publicKeySpki).toBeTruthy();
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
    expect(button("Connect / share setup")).toBeDefined();
    fixture.principal = "synthetic-b"; fixture.identity = {}; await render();
    expect(button("Connect / share setup")).toBeUndefined();
    expect(container.textContent).toContain("sign-in changed");
    expect(fixture.opener.postMessage).not.toHaveBeenCalled();
  });

  it.each(["origin", "nonce", "sheet", "cancel"])("invalidates the exact consent on %s change", async (reason) => {
    await ready();
    if (reason === "origin") await request({}, "https://other.example");
    if (reason === "nonce") await request({ connectionId: "B".repeat(42) + "A" });
    if (reason === "sheet") await select(otherSheetId);
    if (reason === "cancel") await click(button("Cancel connection")!);
    expect(button("Connect / share setup")).toBeUndefined();
    await request();
    expect(button("Connect / share setup")).toBeUndefined();
    expect(fixture.opener.postMessage).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["account", "identity", "actor", "types", "generation", "unreadable", "logout", "pagehide", "unmount", "closed", "expiry"])("blocks late async setup delivery after %s changes", async (reason) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      await ready();
      const gate = deferred<void>(); publicFetch({ wait: gate.promise });
      await click(button("Connect / share setup")!);
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
    } finally { clock.mockRestore(); }
  });

  it("requires readable private Types and never substitutes empty public setup", async () => {
    fixture.templates = { ...fixture.templates, ready: false, error: "could not decrypt" };
    await ready();
    expect(button("Connect / share setup")!.disabled).toBe(true);
    await click(button("Connect / share setup")!);
    expect(fetch).not.toHaveBeenCalled(); expect(fixture.opener.postMessage).not.toHaveBeenCalled();
  });

  it("rejects a processor integrity mismatch before sharing any private catalog", async () => {
    await ready(); publicFetch({ sha256: "f".repeat(64) });
    await click(button("Connect / share setup")!);
    await settledDigest();
    expect(container.textContent).toContain("could not be verified");
    expect(fixture.opener.postMessage).not.toHaveBeenCalled();
  });

  it("does not resend after a postMessage failure with unknown delivery outcome", async () => {
    await ready(); publicFetch(); fixture.opener.postMessage.mockImplementationOnce(() => { throw new Error("closed during send"); });
    await click(button("Connect / share setup")!);
    await settledDigest();
    expect(container.textContent).toContain("delivery outcome is unknown");
    await request();
    expect(fixture.opener.postMessage).toHaveBeenCalledOnce();
    expect(button("Connect / share setup")).toBeUndefined();
  });

  it.each(["no-opener", "query", "fragment"])("rejects an unbound %s launch", async (reason) => {
    if (reason === "no-opener") Object.defineProperty(window, "opener", { configurable: true, value: null });
    else window.history.replaceState(null, "", `/openchat/connect${reason === "query" ? "?code=not-accepted" : "#not-accepted"}`);
    await render(); await request();
    expect(container.textContent).toContain("plain URL");
    expect(fixture.actor.get_my_pairs).not.toHaveBeenCalled();
    expect(fixture.opener.postMessage).not.toHaveBeenCalled();
  });
});
