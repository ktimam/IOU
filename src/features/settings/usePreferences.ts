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

const PREFS_KEY = "iou:prefs:v1";

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

function load(): Preferences {
  if (typeof localStorage === "undefined") return { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Preferences>) };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(p: Preferences) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
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
  const [prefs, setPrefs] = useState<Preferences>(load);

  const update = useCallback((patch: Partial<Preferences>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      save(next);
      return next;
    });
  }, []);

  const mergeMap = useCallback(
    (key: "accountNames" | "sheetNames" | "partnerNames", id: string, name: string) => {
      setPrefs((prev) => {
        if (prev[key][id] === name) return prev; // no-op, avoid re-render churn
        const next = { ...prev, [key]: { ...prev[key], [id]: name } };
        save(next);
        return next;
      });
    },
    [],
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
