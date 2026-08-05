// Browser-local user preferences.
//
// Holds UI-only settings (default currency, your profile name) plus a
// plaintext *cache* of decrypted Account/Sheet/partner names so the
// accounts list and headers render instantly without re-decrypting. The
// cache is not the source of truth — the canister holds the E2E-encrypted
// names; this is just a fast local mirror, populated when a sheet is
// opened (and the names are decrypted with K_sheet).

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  createElement,
  type ReactNode,
} from "react";
import { useAuth } from "../auth/AuthProvider";
import { scopedStorageKey } from "../storage/scopedStorage";

const PREFS_KEY_PREFIX = "iou:prefs:v2";

export type Preferences = {
  defaultCurrency: string;
  profileName: string;
  accountNames: Record<string, string>; // pairId   -> plaintext name
  sheetNames: Record<string, string>;   // sheetId  -> plaintext name
  partnerNames: Record<string, string>; // pairId   -> partner's display name
};

const DEFAULTS: Preferences = {
  defaultCurrency: "USD",
  profileName: "",
  accountNames: {},
  sheetNames: {},
  partnerNames: {},
};

function defaultPreferences(): Preferences {
  return {
    ...DEFAULTS,
    accountNames: {},
    sheetNames: {},
    partnerNames: {},
  };
}

function stringMap(value: unknown): Record<string, string> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function normalizePreferences(value: unknown): Preferences {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return defaultPreferences();
  }
  const candidate = value as Record<string, unknown>;
  const currency =
    typeof candidate.defaultCurrency === "string" &&
    /^[A-Za-z]{3}$/.test(candidate.defaultCurrency.trim())
      ? candidate.defaultCurrency.trim().toUpperCase()
      : DEFAULTS.defaultCurrency;
  return {
    defaultCurrency: currency,
    profileName: typeof candidate.profileName === "string" ? candidate.profileName : "",
    accountNames: stringMap(candidate.accountNames),
    sheetNames: stringMap(candidate.sheetNames),
    partnerNames: stringMap(candidate.partnerNames),
  };
}

export function preferencesStorageKey(principal: string | null | undefined): string {
  return scopedStorageKey(PREFS_KEY_PREFIX, principal);
}

export function loadPreferences(principal: string | null | undefined): Preferences {
  if (typeof localStorage === "undefined") return defaultPreferences();
  try {
    const raw = localStorage.getItem(preferencesStorageKey(principal));
    if (!raw) return defaultPreferences();
    return normalizePreferences(JSON.parse(raw) as unknown);
  } catch {
    return defaultPreferences();
  }
}

export function savePreferences(principal: string | null | undefined, p: Preferences) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(preferencesStorageKey(principal), JSON.stringify(p));
  } catch {
    /* quota / disabled — non-fatal */
  }
}

type PrefsCtx = {
  prefs: Preferences;
  setDefaultCurrency: (c: string) => void;
  setProfileName: (n: string) => void;
  cacheAccountName: (pairId: string, name: string) => void;
  cacheSheetName: (sheetId: string, name: string) => void;
  cachePartnerName: (pairId: string, name: string) => void;
};

const Ctx = createContext<PrefsCtx | null>(null);

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const principal = state.kind === "authenticated" ? state.principal : null;
  const scope = preferencesStorageKey(principal);
  const [stored, setStored] = useState<{ scope: string; prefs: Preferences }>(() => ({
    scope,
    prefs: loadPreferences(principal),
  }));
  // Auth changes must not expose the previous principal's values even for one render.
  const prefs = stored.scope === scope ? stored.prefs : loadPreferences(principal);

  const update = useCallback((patch: Partial<Preferences>) => {
    setStored((previous) => {
      const prev = previous.scope === scope ? previous.prefs : loadPreferences(principal);
      const next = { ...prev, ...patch };
      savePreferences(principal, next);
      return { scope, prefs: next };
    });
  }, [principal, scope]);

  const mergeMap = useCallback(
    (key: "accountNames" | "sheetNames" | "partnerNames", id: string, name: string) => {
      setStored((previous) => {
        const prev = previous.scope === scope ? previous.prefs : loadPreferences(principal);
        if (prev[key][id] === name) return { scope, prefs: prev }; // no-op, but adopt the new auth scope
        const next = { ...prev, [key]: { ...prev[key], [id]: name } };
        savePreferences(principal, next);
        return { scope, prefs: next };
      });
    },
    [principal, scope],
  );

  const value = useMemo<PrefsCtx>(
    () => ({
      prefs,
      setDefaultCurrency: (c) => update({ defaultCurrency: c }),
      setProfileName: (n) => update({ profileName: n }),
      cacheAccountName: (pairId, name) => mergeMap("accountNames", pairId, name),
      cacheSheetName: (sheetId, name) => mergeMap("sheetNames", sheetId, name),
      cachePartnerName: (pairId, name) => mergeMap("partnerNames", pairId, name),
    }),
    [prefs, update, mergeMap],
  );

  return createElement(Ctx.Provider, { value }, children);
}

export function usePreferences(): PrefsCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("usePreferences must be used inside <PreferencesProvider>");
  return ctx;
}
