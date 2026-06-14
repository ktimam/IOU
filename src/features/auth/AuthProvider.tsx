import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { AuthClient } from "@dfinity/auth-client";
import { HttpAgent, type Identity } from "@dfinity/agent";
import { Secp256k1KeyIdentity } from "@dfinity/identity-secp256k1";
import { canisterId, host } from "./config";

type AuthState =
  | { kind: "loading" }
  | { kind: "anonymous" }
  | { kind: "authenticated"; identity: Identity; principal: string };

type AuthCtx = {
  state: AuthState;
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
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
        setState({ kind: "anonymous" });
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
        identityProvider: host === "https://icp-api.io" ? "https://identity.ic0.app" : `http://${host.replace(/^https?:\/\//, "")}`,
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
    // Clear any persisted dev identity too — a fresh "Sign in
    // (dev)" gets a new principal. The user can sign in with
    // II separately.
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(DEV_IDENTITY_KEY);
    }
    setState({ kind: "anonymous" });
  }

  return (
    <AuthContext.Provider value={{ state, signIn, signInDev, signOut }}>
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
