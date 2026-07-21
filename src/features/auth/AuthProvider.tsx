import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { AuthClient } from "@dfinity/auth-client";
import { HttpAgent, type Identity } from "@dfinity/agent";
import { Secp256k1KeyIdentity } from "@dfinity/identity-secp256k1";
import { canisterId, host, internetIdentityUrl } from "./config";

type AuthState =
  | { kind: "loading" }
  | { kind: "anonymous" }
  | { kind: "authenticated"; identity: Identity; principal: string };

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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // DEV-only test hook (?e2eDelayAuth=<ms>): hold the "loading" state for a beat so a UI test
      // can assert transient loading renders (no premature redirect) before auth resolves. The
      // whole branch tree-shakes out of production builds.
      if (import.meta.env.DEV) {
        const delay = Number(new URLSearchParams(globalThis.location?.search ?? "").get("e2eDelayAuth"));
        if (Number.isFinite(delay) && delay > 0) {
          await new Promise((r) => setTimeout(r, Math.min(delay, 10_000)));
        }
      }
      const client = await AuthClient.create();
      if (cancelled) return;
      if (await client.isAuthenticated()) {
        const identity = client.getIdentity();
        setState({
          kind: "authenticated",
          identity,
          principal: identity.getPrincipal().toText(),
        });
      } else {
        // No II delegation. Re-hydrate a persisted dev identity if one
        // exists (the "Sign in (dev)" path stores it in localStorage).
        // Gated on DEV so a production build never auto-restores a dev
        // identity — there the branch tree-shakes away.
        const dev = import.meta.env.DEV ? loadDevIdentityIfPresent() : null;
        if (dev) {
          setState({
            kind: "authenticated",
            identity: dev,
            principal: dev.getPrincipal().toText(),
          });
        } else {
          setState({ kind: "anonymous" });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function signIn() {
    const client = await AuthClient.create();
    await new Promise<void>((resolve, reject) => {
      client.login({
        // v1.3.2: use the II URL from config instead of the
        // inline ternary. The inline version was wrong on local
        // (it pointed at the bare replica host instead of the
        // II-canister subdomain `http://<II_ID>.127.0.0.1:4943`).
        // internetIdentityUrl already does the right thing.
        identityProvider: internetIdentityUrl,
        maxTimeToLive: BigInt(30) * BigInt(24) * BigInt(60) * BigInt(60) * BigInt(1_000_000_000),
        onSuccess: () => resolve(),
        onError: (e) => reject(e),
      });
    });
    const identity = client.getIdentity();
    setState({
      kind: "authenticated",
      identity,
      principal: identity.getPrincipal().toText(),
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
    const identity = loadOrCreateDevIdentity();
    setState({
      kind: "authenticated",
      identity,
      principal: identity.getPrincipal().toText(),
    });
  }

  async function signOut() {
    // v1.3.2: also log out of the II delegation. Without this,
    // the II delegation persists in IndexedDB across signOut,
    // and the next mount effect (`isAuthenticated()`) re-hydrates
    // the user — "sign out" didn't actually sign the user out.
    const client = await AuthClient.create();
    await client.logout();
    // Clear any persisted dev identity too — a fresh "Sign in
    // (dev)" gets a new principal. The user can sign in with
    // II separately.
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(DEV_IDENTITY_KEY);
    }
    setState({ kind: "anonymous" });
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
  if (host.includes("127.0.0.1") || host.includes("localhost")) {
    await agent.fetchRootKey();
  }
  return agent;
}

export function getCanisterId() {
  return canisterId;
}
