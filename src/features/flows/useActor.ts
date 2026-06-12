// Shared hooks for the PWA flows. Mostly thin wrappers around the
// actor (from the auth state) and the candid types.

import { useEffect, useState } from "react";
import { useAuth, buildAgent } from "../auth/AuthProvider";
import { createActor } from "../../backend/declarations";

/** Get an authenticated actor for the current user. */
export function useActor() {
  const { state } = useAuth();
  const [actor, setActor] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (state.kind !== "authenticated") {
      setActor(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const agent = await buildAgent(state.identity);
        const a = createActor(agent);
        if (!cancelled) setActor(a);
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state]);
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
