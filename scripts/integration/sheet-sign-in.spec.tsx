// @vitest-environment-options {"url":"https://iou.example/sheet/0123456789abcdef?from=chat#pending"}
// Mount the real sheet route and shared SignInButtons. Only authentication and
// sheet/provider boundaries are synthetic; this test never starts an II flow.
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  state: { kind: "anonymous" } as any,
  actor: null as any,
  signIn: vi.fn(), signInDev: vi.fn(), signOut: vi.fn(),
  getKey: vi.fn(), unwrapFor: vi.fn(),
  templates: { shared: [], myIds: new Set(), dismissed: new Set(),
    ready: false, readyGeneration: {}, error: undefined, reload: vi.fn() },
}));
vi.mock("../../src/features/auth/AuthProvider", () => ({
  useAuth: () => ({ state: fixture.state, identity: fixture.state.identity,
    signIn: fixture.signIn, signInDev: fixture.signInDev, signOut: fixture.signOut }),
}));
vi.mock("../../src/backend/declarations", () => ({ createActor: () => fixture.actor }));
vi.mock("../../src/features/flows/useActor", () => ({
  useActor: () => ({ actor: fixture.actor }),
  unwrap: (value: unknown) => Array.isArray(value) ? value[0] ?? null : value ?? null,
  isActive: (value: unknown) => !!value && typeof value === "object" && "Active" in value,
}));
vi.mock("../../src/features/flows/SheetKeyContext", () => ({
  useSheetKey: () => ({ get: fixture.getKey, unwrapFor: fixture.unwrapFor }),
}));
vi.mock("../../src/features/templates/PairTemplatesContext", () => ({
  usePairTemplates: () => fixture.templates,
}));
vi.mock("../../src/features/settings/usePreferences", () => ({
  usePreferences: () => ({ prefs: { defaultCurrency: "USD", profileName: "",
    partnerNames: {}, sheetNames: {}, accountNames: {} },
    cacheSheetName: vi.fn(), cacheAccountName: vi.fn(), cachePartnerName: vi.fn() }),
}));
vi.mock("../../src/features/ui/Toasts", () => ({ useToasts: () => ({ show: vi.fn() }) }));
vi.mock("../../src/features/openchat/useDurableInbox", () => ({
  useDurableInbox: () => ({ active: undefined, pending: [], loading: false }),
}));
vi.mock("../../src/features/openchat/actionInboxClient", () => ({
  getActionInboxConfig: vi.fn(async () => null), pollActionInbox: vi.fn(), acknowledgeActionInbox: vi.fn(),
}));
vi.mock("../../src/features/relay/relay", () => ({
  getRelayConfig: vi.fn(() => null), fetchPending: vi.fn(), deletePending: vi.fn(),
}));
import { SheetPage } from "../../src/features/entries/SheetPage";

const sheetId = "0123456789abcdef";
const destination = `/sheet/${sheetId}?from=chat#pending`;
let root: Root;
let container: HTMLDivElement;
const iiButton = () => [...container.querySelectorAll("button")]
  .find(button => button.textContent === "Sign in with Internet Identity");
const render = async () => { await act(async () => {
  root.render(<StrictMode><BrowserRouter><Routes>
    <Route path="/sheet/:sheetId" element={<SheetPage />} />
  </Routes></BrowserRouter></StrictMode>);
}); };
const currentUrl = () => window.location.pathname + window.location.search + window.location.hash;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No live network in sheet sign-in regression"); }));
  fixture.state = { kind: "anonymous" };
  fixture.actor = null;
  fixture.signIn.mockResolvedValue(undefined);
  fixture.signInDev.mockResolvedValue(undefined);
  window.history.replaceState(null, "", destination);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("normal sheet-route sign-in", () => {
  it("offers a working Internet Identity button inline for a signed-out deep link", async () => {
    await render();
    expect(container.textContent).toContain("Please sign in");
    const button = iiButton();
    expect(button).toBeDefined();
    expect(button?.disabled).toBe(false);
    await act(async () => { button!.click(); });
    expect(fixture.signIn).toHaveBeenCalledTimes(1);
    expect(fixture.signInDev).not.toHaveBeenCalled();
    expect(fixture.signOut).not.toHaveBeenCalled();
    expect(currentUrl()).toBe(destination);
  });

  it("distinguishes session restoration from being signed out", async () => {
    fixture.state = { kind: "loading" };
    await render();
    expect(container.textContent).toMatch(/Loading|Checking|Restoring/i);
    expect(container.textContent).not.toContain("Please sign in");
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(fixture.signIn).not.toHaveBeenCalled();
    expect(fixture.signInDev).not.toHaveBeenCalled();
    expect(fixture.signOut).not.toHaveBeenCalled();
    expect(currentUrl()).toBe(destination);
  });

  it("loads the originally requested sheet after sign-in without changing route or identity", async () => {
    await render();
    const button = iiButton();
    expect(button).toBeDefined();
    await act(async () => { button!.click(); });
    const identity = { getPrincipal: () => ({ toText: () => "existing-user" }) };
    fixture.state = { kind: "authenticated", principal: "existing-user", identity };
    fixture.actor = { get_sheet: vi.fn(async () => []), chat_sheet_links: vi.fn(async () => []) };
    await render();
    expect(fixture.actor.get_sheet).toHaveBeenCalledWith(sheetId);
    expect(iiButton()).toBeUndefined();
    expect(container.textContent).not.toContain("Please sign in");
    expect(fixture.state.identity).toBe(identity);
    expect(fixture.signIn).toHaveBeenCalledTimes(1);
    expect(fixture.signInDev).not.toHaveBeenCalled();
    expect(fixture.signOut).not.toHaveBeenCalled();
    expect(currentUrl()).toBe(destination);
  });
});
