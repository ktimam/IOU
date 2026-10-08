// Real App route composition + real React Router + real durable redirect. Synthetic auth/metadata
// boundaries only; no backend calls, key provisioning, account operations, or ledger mutations.
import { act, StrictMode, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useParams } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ identity: {} as unknown, authenticated: true, actor: {},
  providerMounted: vi.fn(), providerUnmounted: vi.fn(), keySync: vi.fn(), resolve: vi.fn() }));
vi.mock("../../src/features/auth/AuthProvider", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => {
    useEffect(() => { fixture.providerMounted(); return () => { fixture.providerUnmounted(); }; }, []);
    return children;
  },
  useAuth: () => ({ identity: fixture.identity, state: fixture.authenticated
    ? { kind: "authenticated", principal: "synthetic-user", identity: fixture.identity }
    : { kind: "anonymous" } }),
}));
vi.mock("../../src/features/flows/useActor", () => ({ useActor: () => ({ actor: fixture.actor }) }));
vi.mock("../../src/features/auth/config", () => ({ host: "https://icp-api.io", canisterId: "rrkah-fqaaa-aaaaa-aaaaq-cai" }));
vi.mock("../../src/features/openchat/durableInboxNavigation", () => ({ resolveDurableInboxSheet: fixture.resolve }));
vi.mock("../../src/features/auth/SignInButtons", () => ({ SignInButtons: () => <button>Normal sign-in buttons</button> }));
vi.mock("../../src/features/auth/SignIn", () => ({ SignIn: () => <p>Sign in</p> }));
vi.mock("../../src/features/auth/SetDisplayName", () => ({ SetDisplayName: () => null }));
vi.mock("../../src/features/auth/Hello", () => ({ Hello: () => <p>Normal home</p> }));
vi.mock("../../src/app/Layout", () => ({ Layout: ({ children }: { children: ReactNode }) => <main>{children}</main> }));
vi.mock("../../src/app/ErrorBoundary", () => ({ ErrorBoundary: ({ children }: { children: ReactNode }) => children }));
vi.mock("../../src/features/flows/Pairs", () => ({ Pairs: () => <p>Normal accounts</p> }));
vi.mock("../../src/features/flows/NewPair", () => ({ NewPair: () => null }));
vi.mock("../../src/features/flows/Pair", () => ({ Pair: () => null }));
vi.mock("../../src/features/flows/NewSheet", () => ({ NewSheet: () => null }));
vi.mock("../../src/features/flows/SheetKeyContext", () => ({ SheetKeyProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("../../src/features/entries/SheetPage", () => ({ SheetPage: () => <p>Normal sheet {useParams().sheetId}</p> }));
vi.mock("../../src/features/backup/SheetTransferPage", () => ({ SheetTransferPage: () => null }));
vi.mock("../../src/features/entries/ArchivedSheetsPage", () => ({ ArchivedSheetsPage: () => null }));
vi.mock("../../src/features/ui/Toasts", () => ({ ToastProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("../../src/features/settings/usePreferences", () => ({ PreferencesProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("../../src/features/settings/SettingsPage", () => ({ SettingsPage: () => null }));
vi.mock("../../src/features/templates/TemplatesContext", () => ({ TemplatesProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("../../src/features/openchat/ConsumerKeypairSync", () => ({ ConsumerKeypairSync: () => {
  useEffect(() => { fixture.keySync(); }, []); return null;
} }));
vi.mock("../../src/features/settings/DefaultCurrencySync", () => ({ DefaultCurrencySync: () => null }));
vi.mock("../../src/features/settings/ProfileNameSync", () => ({ ProfileNameSync: () => null }));
vi.mock("../../src/features/openchat/ManifestTypesSync", () => ({ ManifestTypesSync: () => null }));
vi.mock("../../src/features/openchat/EmbeddedBanner", () => ({ EmbeddedBanner: () => null }));
vi.mock("../../src/features/openchat/OpenChatCardPage", () => ({ OpenChatCardPage: () => null }));
vi.mock("../../src/features/openchat/OpenChatLocalProcessorPage", () => ({ OpenChatLocalProcessorPage: () => null }));
vi.mock("../../src/features/openchat/OpenChatPrivateMatchPage", () => ({ OpenChatPrivateMatchPage: () => null }));
vi.mock("../../src/features/openchat/LocalImportPage", () => ({ LocalImportPage: () => <p>Legacy handoff receiver</p> }));
vi.mock("../../src/features/openchat/LocalConnectPage", () => ({ LocalConnectPage: () => <p>Existing Connect</p> }));
vi.mock("../../src/features/invite/AcceptInvitePage", () => ({ AcceptInvitePage: () => null }));
vi.mock("../../src/features/deeplinks/deepLink", () => ({ useDeepLinks: () => undefined }));

import { App } from "../../src/app/App";
import { captureLocalImportLaunch } from "../../src/features/openchat/localImportLaunch";
const inboxId = "a".repeat(64), requestId = "A".repeat(43);
let root: Root, container: HTMLDivElement;
function launch(fragment = `#oc-inbox=${inboxId}&oc-request=${requestId}`, pathname = "/openchat/import") {
  captureLocalImportLaunch({ location: { pathname, hash: fragment, search: "" },
    history: { state: null, replaceState: vi.fn() } } as unknown as Pick<Window, "location" | "history">);
}
async function render(pathname = "/openchat/import") {
  await act(async () => { root.render(<StrictMode><MemoryRouter initialEntries={[pathname]}><App /></MemoryRouter></StrictMode>); });
}
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.identity = {}; fixture.authenticated = true;
  fixture.resolve.mockReset().mockResolvedValue("/sheet/0123456789abcdef");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); launch("", "/"); });

describe("durable inbox uses the existing normal app route", () => {
  it("resolves the captured inbox then mounts the normal sheet without a second provider lifecycle", async () => {
    let finish!: (path: string) => void;
    fixture.resolve.mockReturnValue(new Promise<string>(resolve => { finish = resolve; }));
    launch(); await render();
    expect(container.textContent).toContain("Opening the connected sheet");
    expect(container.textContent).not.toContain("Normal home");
    expect(container.textContent).not.toContain("Legacy handoff");
    const mounts = fixture.providerMounted.mock.calls.length, keySyncs = fixture.keySync.mock.calls.length;
    expect(mounts).toBeGreaterThan(0);
    expect(fixture.resolve).toHaveBeenCalledWith(expect.objectContaining({ inboxId }));
    await act(async () => { finish("/sheet/0123456789abcdef"); });
    expect(container.textContent).toContain("Normal sheet 0123456789abcdef");
    expect(fixture.providerMounted).toHaveBeenCalledTimes(mounts);
    expect(fixture.keySync).toHaveBeenCalledTimes(keySyncs);
  });
  it.each(["", `#sessionNonce=${requestId}`])("preserves the legacy import branch for %s", async fragment => {
    launch(fragment); await render();
    expect(container.textContent).toContain("Legacy handoff receiver");
    expect(fixture.providerMounted).not.toHaveBeenCalled(); expect(fixture.resolve).not.toHaveBeenCalled();
  });
  it("waits for normal sign-in without resolving another user's inbox", async () => {
    fixture.authenticated = false; fixture.identity = null; launch(); await render();
    expect(container.textContent).toContain("Sign in to IOU");
    expect(container.textContent).toContain("Normal sign-in buttons");
    expect(fixture.resolve).not.toHaveBeenCalled();
  });
  it("keeps normal sheet navigation on the original route", async () => {
    launch("", "/sheet/0123456789abcdef"); await render("/sheet/0123456789abcdef");
    expect(container.textContent).toContain("Normal sheet 0123456789abcdef");
    expect(fixture.resolve).not.toHaveBeenCalled();
  });
});
