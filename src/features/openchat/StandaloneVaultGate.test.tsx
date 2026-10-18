import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalConnectPage } from "./LocalConnectPage";
import { LocalImportPage } from "./LocalImportPage";

const session = vi.hoisted(() => ({
  kind: "authenticated" as "authenticated" | "anonymous" | "loading",
  ready: false,
  configured: true,
  gate: vi.fn(),
  encryptedChild: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  sender: { closed: false, postMessage: vi.fn() },
}));

vi.mock("../auth/AuthProvider", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useAuth: () => ({
    state: session.kind === "authenticated" ? { kind: session.kind, principal: "synthetic-user" } : { kind: session.kind },
    identity: null, signIn: session.signIn, signOut: session.signOut,
  }),
}));
vi.mock("../auth/SignInButtons", () => ({ SignInButtons: () => <button>Sign in with Internet Identity</button> }));
vi.mock("../crypto/AccountVaultControls", () => ({
  AccountVaultGate: ({ children }: { children: ReactNode }) => {
    session.gate(session.kind);
    return session.kind === "authenticated" && !session.ready
      ? <h1>Save your recovery entry</h1> : <>{children}</>;
  },
}));
vi.mock("../flows/SheetKeyContext", () => ({
  SheetKeyProvider: ({ children }: { children: ReactNode }) => {
    session.encryptedChild();
    return <>{children}</>;
  },
  useSheetKey: () => ({}),
}));
vi.mock("../flows/useActor", () => ({ useActor: () => ({ actor: null, err: null }), unwrap: (value: unknown) => value }));
vi.mock("../templates/TemplatesContext", () => ({ TemplatesProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("../templates/PairTemplatesContext", () => ({ usePairTemplates: () => ({}) }));
vi.mock("../settings/usePreferences", () => ({ PreferencesProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("../ui/Toasts", () => ({ ToastProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("../../app/Layout", () => ({ Layout: ({ children }: { children: ReactNode }) => <main>{children}</main> }));
vi.mock("../entries/SheetPage", () => ({ SheetPage: () => <div>Imported sheet</div> }));
vi.mock("./LocalDeliveryKeyProvider", () => ({
  LocalDeliveryKeyProvider: ({ children }: { children: ReactNode }) => <>{children}</>, useLocalDeliveryKey: () => ({}),
}));
vi.mock("./LocalImportNavigation", () => ({ LocalImportNavigationProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("./localAppSender", () => ({ localAppSenderWindow: () => session.sender }));
vi.mock("./localImportLaunch", () => ({
  localImportSenderOrigin: () => session.configured ? "https://sender.test" : undefined,
  localImportSessionNonce: () => session.configured ? "synthetic-session-nonce" : undefined,
  localImportNativeBootstrap: () => false,
}));
vi.mock("./LocalSetupV2Panel", () => ({ LocalSetupV2Panel: () => <div>Connected setup</div> }));

beforeEach(() => {
  vi.clearAllMocks();
  session.kind = "authenticated"; session.ready = false; session.configured = true;
  const testWindow: { parent?: unknown } = {};
  testWindow.parent = testWindow;
  vi.stubGlobal("window", testWindow);
  vi.stubGlobal("location", { pathname: "/openchat/connect", origin: "https://iou.test", search: "", hash: "" });
});
afterEach(() => vi.unstubAllGlobals());

describe("standalone authenticated routes use the account recovery gate", () => {
  it("gates a signed-in connection before any pending setup request exists", () => {
    const html = renderToStaticMarkup(<LocalConnectPage />);
    expect(session.gate).toHaveBeenCalledOnce();
    expect(html).toContain("Save your recovery entry");
    expect(html).not.toContain("Signed in to IOU.");
    expect(session.encryptedChild).not.toHaveBeenCalled();
  });
  it.each([true, false])("gates a signed-in import with no draft (configured transport: %s)", (configured) => {
    session.configured = configured;
    const html = renderToStaticMarkup(<LocalImportPage />);
    expect(session.gate).toHaveBeenCalledOnce();
    expect(html).toContain("Save your recovery entry");
    expect(html).not.toMatch(/Opening your draft|Open the card with Add to IOU/);
    expect(session.encryptedChild).not.toHaveBeenCalled();
  });
  it("keeps anonymous connection sign-in accessible without starting it automatically", () => {
    session.kind = "anonymous";
    const html = renderToStaticMarkup(<LocalConnectPage />);
    expect(html).toContain("Sign in to IOU</button>");
    expect(html).not.toContain("Save your recovery entry");
    expect(session.signIn).not.toHaveBeenCalled();
  });
  it("keeps anonymous import sign-in accessible without starting it automatically", () => {
    session.kind = "anonymous";
    const html = renderToStaticMarkup(<LocalImportPage />);
    expect(html).toContain("Sign in with Internet Identity</button>");
    expect(html).not.toContain("Save your recovery entry");
    expect(session.signIn).not.toHaveBeenCalled();
  });
  it("keeps the normal waiting connection screen after recovery is ready", () => {
    session.ready = true;
    const html = renderToStaticMarkup(<LocalConnectPage />);
    expect(html).toContain("Signed in to IOU.");
    expect(html).toContain("Connection code");
    expect(session.gate).toHaveBeenCalledOnce();
  });
  it("keeps the normal draft waiting screen after recovery is ready", () => {
    session.ready = true;
    const html = renderToStaticMarkup(<LocalImportPage />);
    expect(html).toContain("Opening your draft");
    expect(session.gate).toHaveBeenCalledOnce();
  });
});
