// Keeps the user's ONE default currency in step between the canister and this browser.
//
// The default used to live only in localStorage, so it did not follow the user to another device.
// On load this pulls `UserRecord.default_currency` and adopts it; if the canister has none yet, it
// pushes the browser's cached value up once (the migration for existing users). Renders nothing;
// mounted once in App inside AuthProvider + PreferencesProvider, mirroring ConsumerKeypairSync.

import { useEffect, useRef } from "react";
import { useAuth } from "../auth/AuthProvider";
import { useActor, unwrap } from "../flows/useActor";
import { usePreferences } from "./usePreferences";
import { currencyFromUserRecord, reconcileDefaultCurrency } from "./defaultCurrency";

export function DefaultCurrencySync() {
  const { state } = useAuth();
  const { actor } = useActor();
  const { prefs, setDefaultCurrency } = usePreferences();
  // Run the reconcile ONCE per session. Without this the effect would re-fire on its own
  // setDefaultCurrency (prefs changes) and fight a user who edits the setting right after load.
  const done = useRef(false);
  // Read the cache without depending on it, so editing the setting never re-triggers the sync.
  const cachedRef = useRef(prefs.defaultCurrency);
  cachedRef.current = prefs.defaultCurrency;

  useEffect(() => {
    if (done.current) return;
    if (state.kind !== "authenticated" || !actor) return;
    done.current = true;
    void (async () => {
      try {
        const rec = unwrap(await actor.get_my_user());
        const { use, push } = reconcileDefaultCurrency(
          currencyFromUserRecord(rec),
          cachedRef.current,
        );
        // Materialize the cache even when it already agrees. Leaving it absent would mean the
        // browser is relying on the DEFAULTS constant rather than on the user's own choice — so a
        // future change to that constant would silently move their default on an offline load.
        setDefaultCurrency(use);
        if (push) await actor.set_default_currency(push);
      } catch (e) {
        // Offline, an un-upgraded canister (no such method), or a brand-new user with no record —
        // all non-fatal: the cached value keeps working and the next load retries.
        done.current = false;
        console.warn("[DefaultCurrencySync] could not sync the default currency:", e);
      }
    })();
  }, [actor, state.kind, setDefaultCurrency]);

  return null;
}
