// User-level transaction templates ("Reservation" = 20% + 1000 EGP fixed,
// etc.). Stored as one AES-GCM blob on the caller's UserRecord, encrypted
// under a self-derived user key, so they're available across every sheet
// and account. Decrypted into memory here and exposed via useTemplates().

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
import { syncManifestWithTypes } from "../openchat/syncManifest";

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
  // Trigger words that route on-device extraction to this template's id: IOU folds them into the
  // registered OpenChat manifest (a keyword_map on a `template` field), so a chat message matching
  // one is classified as this type. Absent === not routable from chat.
  keywords?: string[];
};

type Ctx = {
  templates: TxnTemplate[];
  loading: boolean;
  error: string | null;
  /** Add a template. An explicit `id` (normally absent — one is generated)
   *  lets "Edit a copy" of a partner-shared type store MY personal copy
   *  under the SAME id, which the pair-slot mirror then publishes as my
   *  copy-on-write override. */
  addTemplate: (t: Omit<TxnTemplate, "id"> & { id?: string }) => Promise<void>;
  updateTemplate: (t: TxnTemplate) => Promise<void>;
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
      // Re-sync the manifest with the just-loaded types ON APP LOAD: a fresh deploy re-registers the
      // BASE manifest (no template rules), so without this a participating user's existing types stay
      // unmapped until their next edit. No-op unless the user participates in OpenChat.
      if (!cancelled) void syncManifestWithTypes(identity, loaded);
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

  const addTemplate = useCallback(
    async (t: Omit<TxnTemplate, "id"> & { id?: string }) => {
      const id =
        t.id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const next = [...templates.filter((x) => x.id !== id), { ...t, id }];
      await persist(next);
      setTemplates(next);
      // Keep the registered OpenChat manifest in lock-step with the user's types (no-op unless the
      // user participates in OpenChat — connected via the 6-digit Connect or explicitly linked).
      void syncManifestWithTypes(identity, next);
    },
    [templates, persist, identity],
  );

  const updateTemplate = useCallback(
    async (t: TxnTemplate) => {
      const next = templates.map((x) => (x.id === t.id ? t : x));
      await persist(next);
      setTemplates(next);
      // Keep the registered OpenChat manifest in lock-step with the user's types (no-op unless the
      // user participates in OpenChat — connected via the 6-digit Connect or explicitly linked).
      void syncManifestWithTypes(identity, next);
    },
    [templates, persist, identity],
  );

  const removeTemplate = useCallback(
    async (id: string) => {
      const next = templates.filter((t) => t.id !== id);
      await persist(next);
      setTemplates(next);
      // Keep the registered OpenChat manifest in lock-step with the user's types (no-op unless the
      // user participates in OpenChat — connected via the 6-digit Connect or explicitly linked).
      void syncManifestWithTypes(identity, next);
    },
    [templates, persist, identity],
  );

  return (
    <TemplatesContext.Provider
      value={{ templates, loading, error, addTemplate, updateTemplate, removeTemplate }}
    >
      {children}
    </TemplatesContext.Provider>
  );
}

export function useTemplates(): Ctx {
  const ctx = useContext(TemplatesContext);
  if (!ctx) throw new Error("useTemplates must be used inside <TemplatesProvider>");
  return ctx;
}
