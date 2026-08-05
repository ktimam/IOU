// Shared hooks for the PWA flows. Mostly thin wrappers around the
// actor (from the auth state) and the candid types.

import { useEffect, useState } from "react";
import { useAuth, buildAgent } from "../auth/AuthProvider";
import { createActor } from "../../backend/declarations";

export function actorForPrincipal<T>(
  session: { principal: string; actor: T } | null,
  principal: string | null,
): T | null {
  return principal && session?.principal === principal ? session.actor : null;
}

/** Get an authenticated actor for the current user. */
export function useActor() {
  const { state } = useAuth();
  const [session, setSession] = useState<{ principal: string; actor: any } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (state.kind !== "authenticated") {
      setSession(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const agent = await buildAgent(state.identity);
        const a = createActor(agent);
        if (!cancelled) setSession({ principal: state.principal, actor: a });
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state]);
  // React effects run after render. Never expose principal A's actor during the render in which
  // authentication has already changed to principal B.
  const actor = actorForPrincipal(
    session,
    state.kind === "authenticated" ? state.principal : null,
  );
  return { actor, err };
}

/** Unwrap a Candid opt<T> (sometimes null, sometimes [T]). */
export function unwrap<T>(opt: T | T[] | null | undefined): T | null {
  if (opt == null) return null;
  if (Array.isArray(opt)) return (opt as T[])[0] ?? null;
  return opt;
}

/** Unwrap a Candid variant {Active:null} or {Closed:null}. */
export function isActive(s: any): boolean {
  return s && typeof s === "object" && "Active" in s;
}
export function isClosed(s: any): boolean {
  return s && typeof s === "object" && "Closed" in s;
}
