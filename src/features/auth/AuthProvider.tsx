import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AuthClient } from "@dfinity/auth-client";
import { HttpAgent, type Identity } from "@dfinity/agent";
import { Secp256k1KeyIdentity } from "@dfinity/identity-secp256k1";
import { shouldFetchLocalRootKey } from "../../config/devLanQcRuntime";
import { canisterId, host, internetIdentityUrl } from "./config";
import { clearAccountVaultDevice, clearAccountVaultMemory } from "../crypto/accountVault";
import { AuthSession, REQUESTED_DELEGATION_TTL, type AuthState } from "./authSession";
import { AUTH_LOGOUT_CHANNEL, readAuthLogoutSignal, type AuthLogoutSignal } from "./authLogoutSignal";

type AuthCtx = {
  state: AuthState;
  /**
   * Convenience accessor for the current identity. Defined iff
   * `state.kind === "authenticated"`; undefined otherwise. v1.1.5:
   * SheetKeyContext needs this to wire the actor for the prod
   * vetkd path. Previously the consumer would do
   * `state.kind === 'authenticated' ? state.identity : null`
   * inline; this avoids the boilerplate.
   */
  identity?: Identity;
  signIn: () => Promise<void>;
  signInDev: () => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthCtx | null>(null);

const DEV_IDENTITY_KEY = "iou:dev:identity:v1";

function loadOrCreateDevIdentity(): Secp256k1KeyIdentity {
  if (typeof localStorage === "undefined") {
    throw new Error("localStorage required for dev identity");
  }
  const stored = localStorage.getItem(DEV_IDENTITY_KEY);
  if (stored) {
    return Secp256k1KeyIdentity.fromJSON(stored);
  }
  // Secp256k1KeyIdentity.generate() returns a fresh keypair. We
  // persist it as a JSON blob so the principal is stable across
  // reloads (this is the "remember me" experience for the dev
  // path — your principal stays the same every time you open
  // the tab, so anything you created earlier is still there).
  const id = Secp256k1KeyIdentity.generate();
  localStorage.setItem(DEV_IDENTITY_KEY, JSON.stringify(id.toJSON()));
  return id;
}

/**
 * loadDevIdentityIfPresent: returns the persisted dev identity if one
 * exists, else null. Unlike loadOrCreateDevIdentity it never *creates*
 * one — used on app load to re-hydrate a dev session without minting an
 * identity for a first-time / anonymous visitor. Without this, a page
 * reload after "Sign in (dev)" dropped back to anonymous because the
 * mount effect only restored the II delegation, never the dev identity.
 */
function loadDevIdentityIfPresent(): Secp256k1KeyIdentity | null {
  if (typeof localStorage === "undefined") return null;
  const stored = localStorage.getItem(DEV_IDENTITY_KEY);
  if (!stored) return null;
  try {
    return Secp256k1KeyIdentity.fromJSON(stored);
  } catch {
    return null;
  }
}

/** Development-only live-test bridge; production builds always return null. */
export function loadDevIdentityForDiagnostics(): Secp256k1KeyIdentity | null {
  return import.meta.env.DEV ? loadDevIdentityIfPresent() : null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ kind: "loading" });
  const logoutChannel = useRef<BroadcastChannel | null>(null);
  const sessionRef = useRef<AuthSession>();
  if (!sessionRef.current) sessionRef.current = new AuthSession({
    createClient: options => AuthClient.create(options),
    onState: setState,
    restoreDevIdentity: () => import.meta.env.DEV ? loadDevIdentityIfPresent() : null,
    createDevIdentity: () => {
      if (!import.meta.env.DEV) throw new Error("Development sign-in is unavailable.");
      return loadOrCreateDevIdentity();
    },
    forgetDevIdentity: () => {
      if (typeof localStorage !== "undefined") localStorage.removeItem(DEV_IDENTITY_KEY);
    },
    clearMemory: clearAccountVaultMemory,
    clearDevice: clearAccountVaultDevice,
  });
  const session = sessionRef.current;

  useEffect(() => {
    // Preserve the development-only loading-state fixture without changing production auth.
    const requestedDelay = import.meta.env.DEV
      ? Number(new URLSearchParams(globalThis.location?.search ?? "").get("e2eDelayAuth")) : 0;
    void session.restore(Number.isFinite(requestedDelay) ? requestedDelay : 0);
    const check = () => session.checkExpiry();
    const receive = (value: unknown) => {
      const signal = readAuthLogoutSignal(value);
      if (signal) void session.refreshAfterRemoteSignOut(signal.principal).catch(() => {
        // A failed remote vault purge stays locked; do not restore persisted auth.
      });
    };
    const storage = (event: StorageEvent) => {
      if (event.key === AUTH_LOGOUT_CHANNEL && event.newValue) receive(event.newValue);
    };
    try {
      if (typeof BroadcastChannel !== "undefined") {
        const channel = new BroadcastChannel(AUTH_LOGOUT_CHANNEL);
        channel.onmessage = event => receive(event.data);
        logoutChannel.current = channel;
      }
    } catch { /* Storage events remain available when BroadcastChannel is unavailable. */ }
    window.addEventListener("focus", check);
    window.addEventListener("storage", storage);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.removeEventListener("focus", check);
      window.removeEventListener("storage", storage);
      document.removeEventListener("visibilitychange", check);
      logoutChannel.current?.close();
      logoutChannel.current = null;
      session.suspend();
    };
  }, [session]);

  async function signIn() {
    await session.signIn({
      identityProvider: internetIdentityUrl,
      maxTimeToLive: REQUESTED_DELEGATION_TTL,
    });
  }

  /**
   * signInDev: signs in with a local Secp256k1 identity, bypassing
   * Internet Identity. Used for local development when II isn't
   * deployed. The principal is stable across reloads (persisted
   * in localStorage). This is NOT a production path — II is the
   * real auth. v1.1.4 ships this so the user can drive the
   * local replica without setting up II.
   */
  async function signInDev() {
    session.signInDev();
  }

  async function signOut() {
    const principal = session.state.kind === "authenticated" ? session.state.principal : undefined;
    try {
      await session.signOut();
    } finally {
      if (principal) {
        const signal: AuthLogoutSignal = { version: 1, principal, nonce: crypto.randomUUID() };
        try { logoutChannel.current?.postMessage(signal); } catch { /* The storage fallback remains available. */ }
        // Compatibility fallback for browsers without BroadcastChannel; no secrets are persisted.
        try {
          localStorage.setItem(AUTH_LOGOUT_CHANNEL, JSON.stringify(signal));
          localStorage.removeItem(AUTH_LOGOUT_CHANNEL);
        } catch { /* Auth and vault cleanup do not depend on the notification fallback. */ }
      }
    }
  }

  return (
    <AuthContext.Provider
      value={{
        state,
        identity: state.kind === "authenticated" ? state.identity : undefined,
        signIn,
        signInDev,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthCtx {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

// Build an HttpAgent for the current identity. Re-exported for features
// that need to make canister calls.
export async function buildAgent(identity: Identity): Promise<HttpAgent> {
  const agent = new HttpAgent({ identity, host });
  if (shouldFetchLocalRootKey()) {
    await agent.fetchRootKey();
  }
  return agent;
}

export function getCanisterId() {
  return canisterId;
}
