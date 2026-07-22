// Actor-level (non-React) helpers for SHARED transaction types per account.
// Kept free of React/context imports so the Node e2e suite and non-hook
// callers (CloseSheetButton's rotation step, ActionInboxSettings' manifest
// fold) can use them directly. The React wiring lives in
// PairTemplatesContext.tsx; the pure merge core in pairTemplates.ts.

import { encryptWithSheetKey, decryptWithSheetKey } from "../crypto/devVetkd";
import {
  type SharedTemplate,
  decodePairSlot,
  mergePairTemplates,
  visibleTemplates,
} from "./pairTemplates";

/** Candid opt (`[] | [T]` or plain nullable) → bytes or null. */
export function optBytes(o: unknown): Uint8Array | null {
  const v = Array.isArray(o) ? o[0] : o;
  return v == null ? null : v instanceof Uint8Array ? v : new Uint8Array(v as number[]);
}

function unwrapOpt<T>(opt: T | T[] | null | undefined): T | null {
  if (opt == null) return null;
  if (Array.isArray(opt)) return (opt as T[])[0] ?? null;
  return opt;
}

function principalText(p: unknown): string {
  return p != null && typeof (p as { toText?: unknown }).toText === "function"
    ? (p as { toText: () => string }).toText()
    : String(p ?? "");
}

/** 0 = a-slot, 1 = b-slot, null = not a member (mirrors lib.rs member_slot). */
export function myMemberIndex(pair: any, myPrincipal: string): 0 | 1 | null {
  if (principalText(pair?.members?.[0]) === myPrincipal) return 0;
  if (principalText(pair?.members?.[1]) === myPrincipal) return 1;
  return null;
}

/** Decrypt one slot; ANY failure (stale key after rotation, garbage) → []. */
export async function decryptSlot(
  K: Uint8Array,
  enc: unknown,
  iv: unknown,
): Promise<SharedTemplate[]> {
  const e = optBytes(enc);
  const i = optBytes(iv);
  if (!e || !i) return [];
  try {
    return decodePairSlot(await decryptWithSheetKey(K, i, e));
  } catch {
    return []; // degrade — self-heals when that member next republishes
  }
}

/**
 * Sheet-rotation follow-up (CloseSheetButton): re-encrypt the CALLER's own
 * templates slot under the NEW K_sheet, mirroring how publishAccountNames
 * re-publishes the names. Best-effort by design — on any failure the slot
 * is simply stale under the old key, which the loader already degrades on,
 * and it self-heals on the next publish. The partner's slot is theirs to
 * re-seal (same standing limitation the encrypted names have).
 */
export async function rotateMyPairTemplates(
  actor: any,
  myPrincipal: string,
  pairId: string,
  getOldKey: () => Promise<Uint8Array>,
  newKey: Uint8Array,
): Promise<void> {
  try {
    const pair = unwrapOpt(await actor.get_pair(pairId)) as any;
    if (!pair) return;
    const idx = myMemberIndex(pair, myPrincipal);
    if (idx == null) return;
    const enc = optBytes(idx === 0 ? pair.templates_a_enc : pair.templates_b_enc);
    const iv = optBytes(idx === 0 ? pair.templates_a_iv : pair.templates_b_iv);
    if (!enc || !iv) return; // nothing shared — nothing to rotate
    const plaintext = await decryptWithSheetKey(await getOldKey(), iv, enc);
    const sealed = await encryptWithSheetKey(newKey, plaintext);
    await actor.set_pair_templates(
      pairId,
      Array.from(sealed.ciphertext),
      Array.from(sealed.iv),
    );
  } catch {
    /* best-effort — see doc comment */
  }
}

/**
 * All shared templates across every account the user is in (merged view per
 * pair, then deduped by id, first pair wins). Used by ActionInboxSettings to
 * fold partner-authored types into the OpenChat manifest on Connect.
 * Best-effort per pair: an account whose sheet key can't currently be
 * unwrapped is skipped, never fatal.
 */
export async function loadAllSharedTemplates(
  actor: any,
  unwrapFor: (sheetId: string) => Promise<Uint8Array>,
): Promise<SharedTemplate[]> {
  const out: SharedTemplate[] = [];
  const seen = new Set<string>();
  let pairs: Array<{ id: string; active_sheet_id?: [] | [string] }> = [];
  try {
    pairs = await actor.get_my_pairs();
  } catch {
    return out;
  }
  for (const p of pairs) {
    const sheetId =
      p.active_sheet_id && p.active_sheet_id.length > 0 ? p.active_sheet_id[0] : undefined;
    if (!sheetId) continue;
    try {
      const pair = unwrapOpt(await actor.get_pair(p.id)) as any;
      if (!pair) continue;
      const K = await unwrapFor(sheetId);
      const a = await decryptSlot(K, pair.templates_a_enc, pair.templates_a_iv);
      const b = await decryptSlot(K, pair.templates_b_enc, pair.templates_b_iv);
      for (const t of visibleTemplates(mergePairTemplates(a, b))) {
        if (!seen.has(t.id)) {
          seen.add(t.id);
          out.push(t);
        }
      }
    } catch {
      /* skip this account */
    }
  }
  return out;
}
