import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { AuthClient } from "@dfinity/auth-client";
import { HttpAgent, type Identity } from "@dfinity/agent";
import { canisterId, host } from "./config";

type AuthState =
  | { kind: "loading" }
  | { kind: "anonymous" }
  | { kind: "authenticated"; identity: Identity; principal: string };

type AuthCtx = {
  state: AuthState;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthCtx | null>(null);

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

  async function signOut() {
    const client = await AuthClient.create();
    await client.logout();
    setState({ kind: "anonymous" });
  }

  return (
    <AuthContext.Provider value={{ state, signIn, signOut }}>
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
