// LEGACY user-level transaction templates — a READ-ONLY migration source.
//
// Before types became ACCOUNT-SCOPED (owned by the pair they were created
// in — see pairTemplates.ts), templates were user-global: one AES-GCM blob
// on the caller's UserRecord, encrypted under a self-derived user key.
// This provider still decrypts that blob so TemplatesManager can offer
// "Add to this account" on each pre-rework type (an upsert into the pair
// slot that KEEPS the personal id, so partners' same-id copies merge
// sanely) — plus a legacy Remove to clear migrated entries. Nothing else
// reads this store: pickers, chat-draft routing, and the OpenChat manifest
// are all sourced from the account slots now, and no new personal
// templates are ever written.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useAuth, buildAgent } from "../auth/AuthProvider";
import { createActor } from "../../backend/declarations";
import {
  deriveUserKey,
  encryptWithSheetKey,
  decryptWithSheetKey,
} from "../crypto/devVetkd";
import { unwrap } from "../flows/useActor";
import type { Direction, TxnType } from "../entries/types";

// How a template portion's due date is anchored, relative to the
// transaction date (so the template stays reusable):
//   "in_days"             → offset_days after the transaction date
//   "start_of_next_month" → the 1st of the month after the transaction date
export type DueAnchor = "in_days" | "start_of_next_month";

// One slice of a template's default due schedule. Converted to an absolute
// due date when applied. percents across the schedule must total 100.
export type TemplatePortion = {
  offset_days: number; // used when anchor is "in_days"
  percent: number;
  anchor?: DueAnchor; // default "in_days"
};

export type TxnTemplate = {
  id: string;
  name: string;
  direction: Direction;
  txn_type: TxnType;
  currency?: string; // default currency (else the form's default is used)
  amount_minor?: number; // optional default face/gross amount
  fee_percent?: number; // IOU fee %
  fee_fixed_minor?: number; // IOU flat fee
  // Currency of the fixed fee, when it differs from the entry currency. Absent ⇒ the fixed fee is in
  // the entry currency (folds into the net). When set to a different currency, the fixed fee becomes
  // its own balance line in that currency (see FeePayload.fixed_currency / balance.ts).
  fee_fixed_currency?: string;
  schedule?: TemplatePortion[]; // IOU default due schedule (relative)
  note?: string;
  // Private trigger words used only after the viewer-authorized account roster
  // is decrypted locally. They are never published in the OpenChat manifest.
  keywords?: string[];
};

type Ctx = {
  /** LEGACY pre-rework personal types (decrypted read-only). */
  templates: TxnTemplate[];
  loading: boolean;
  error: string | null;
  /** Remove a LEGACY personal type (the only remaining write — clears a
   *  migrated/stale entry from the legacy list; account slots are never
   *  touched by this). */
  removeTemplate: (id: string) => Promise<void>;
};

const TemplatesContext = createContext<Ctx | null>(null);

function optBytes(o: any): Uint8Array | null {
  const v = Array.isArray(o) ? o[0] : o;
  return v == null ? null : new Uint8Array(v);
}

export function TemplatesProvider({ children }: { children: ReactNode }) {
  const { identity, state } = useAuth();
  const [templates, setTemplates] = useState<TxnTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!identity || state.kind !== "authenticated") {
      setTemplates([]);
      return;
    }
    (async () => {
      setLoading(true);
      setError(null);
      let loaded: TxnTemplate[] = [];
      try {
        const principal = identity.getPrincipal().toText();
        const agent = await buildAgent(identity);
        const actor = createActor(agent) as any;
        const user = unwrap(await actor.get_my_user());
        const enc = optBytes(user?.templates_enc);
        const iv = optBytes(user?.templates_iv);
        if (user && enc && iv) {
          const K = await deriveUserKey(principal);
          const bytes = await decryptWithSheetKey(K, iv, enc);
          const parsed = JSON.parse(new TextDecoder().decode(bytes));
          if (Array.isArray(parsed)) loaded = parsed;
        }
        if (!cancelled) setTemplates(loaded);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [identity, state.kind]);

  const persist = useCallback(
    async (next: TxnTemplate[]) => {
      if (!identity) throw new Error("not signed in");
      const principal = identity.getPrincipal().toText();
      const agent = await buildAgent(identity);
      const actor = createActor(agent) as any;
      const K = await deriveUserKey(principal);
      const json = new TextEncoder().encode(JSON.stringify(next));
      const { iv, ciphertext } = await encryptWithSheetKey(K, json);
      await actor.set_user_templates(Array.from(ciphertext), Array.from(iv));
    },
    [identity],
  );

  const removeTemplate = useCallback(
    async (id: string) => {
      const next = templates.filter((t) => t.id !== id);
      await persist(next);
      setTemplates(next);
      // No manifest sync: legacy personal types no longer feed the OpenChat
      // manifest — it's sourced from the account slots (ManifestTypesSync,
      // the pair-slot publish path).
    },
    [templates, persist],
  );

  return (
    <TemplatesContext.Provider value={{ templates, loading, error, removeTemplate }}>
      {children}
    </TemplatesContext.Provider>
  );
}

export function useTemplates(): Ctx {
  const ctx = useContext(TemplatesContext);
  if (!ctx) throw new Error("useTemplates must be used inside <TemplatesProvider>");
  return ctx;
}
