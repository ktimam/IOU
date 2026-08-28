// Hydrates the locally cached profile name from the caller-scoped encrypted UserRecord and migrates
// the old browser-only / plaintext-sentinel states. A failed/empty read never clears local state.

import { useEffect, useRef } from "react";
import { useAuth } from "../auth/AuthProvider";
import { useActor } from "../flows/useActor";
import {
  profileNameHydrationIsCurrent,
  synchronizeProfileName,
  type ProfileNameActor,
} from "./profileName";
import { usePreferences } from "./usePreferences";

export function ProfileNameSync() {
  const { state } = useAuth();
  const { actor } = useActor();
  const { prefs, setProfileName } = usePreferences();
  const donePrincipal = useRef<string | null>(null);
  const cachedRef = useRef(prefs.profileName);
  cachedRef.current = prefs.profileName;

  useEffect(() => {
    if (state.kind !== "authenticated" || !actor) return;
    const principal = state.principal;
    if (donePrincipal.current === principal) return;
    donePrincipal.current = principal;
    const localAtStart = cachedRef.current;
    let cancelled = false;

    void (async () => {
      try {
        const reconciliation = await synchronizeProfileName(
          actor as ProfileNameActor,
          principal,
          localAtStart,
          () => profileNameHydrationIsCurrent(localAtStart, cachedRef.current, cancelled),
        );
        if (cancelled) return;
        // Do not let a slow hydration overwrite a name the user edited while the query was running.
        if (!profileNameHydrationIsCurrent(localAtStart, cachedRef.current)) return;
        if (reconciliation.use !== cachedRef.current) setProfileName(reconciliation.use);
      } catch (error) {
        if (donePrincipal.current === principal) donePrincipal.current = null;
        console.warn("[ProfileNameSync] could not sync the encrypted profile name:", error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [actor, state, setProfileName]);

  return null;
}
