// Shared sheet-creation + name-publishing helpers.
//
// Used by: NewPair (auto-create the first sheet), NewSheet (manual new
// sheet), and CloseSheetButton (rotate to a fresh sheet on archive). Each
// generates a fresh K_sheet, wraps it for the member(s), creates the sheet
// (optionally with an E2E-encrypted name), and returns both so the caller
// can cache K_sheet and publish account/member names.

import type { Identity } from "@dfinity/agent";
import {
  deriveUserKeypair,
  newSheetKey,
  wrapSheetKey,
  encryptName,
} from "../crypto/devVetkd";
import { unwrap } from "./useActor";

const ANON = "2vxsx-fae";

export type CreateSheetOpts = {
  pairId: string;
  currencies: string[];
  closingDays: number;
  name?: string;
};

/** Create a sheet for a pair. Returns the new sheet + its K_sheet. */
export async function createSheetForPair(
  actor: any,
  identity: Identity,
  opts: CreateSheetOpts,
): Promise<{ sheet: any; K_sheet: Uint8Array }> {
  const pair = unwrap(await actor.get_pair(opts.pairId));
  if (!pair) throw new Error("Pair not found or not a member.");
  const memberB = pair.members?.[1];
  const memberBText =
    memberB && typeof memberB.toText === "function"
      ? memberB.toText()
      : String(memberB ?? "");
  const isSolo = memberBText === "" || memberBText === ANON;

  const myPrincipal = identity.getPrincipal().toText();
  const myKp = await deriveUserKeypair(myPrincipal);
  const K_sheet = newSheetKey();
  // Dev collapse: wrap for both members with our own keypair (the partner
  // re-derives via the same symmetric scheme). Solo ⇒ empty placeholder.
  const wrapA = await wrapSheetKey(K_sheet, myKp.publicKey, myKp.privateKey);
  const wrapB = isSolo
    ? new Uint8Array(0)
    : await wrapSheetKey(K_sheet, myKp.publicKey, myKp.privateKey);

  let encBytes: number[] | null = null;
  let ivBytes: number[] | null = null;
  if (opts.name && opts.name.trim()) {
    const r = await encryptName(K_sheet, opts.name.trim());
    encBytes = r.enc;
    ivBytes = r.iv;
  }

  const sheet = await actor.create_sheet({
    pair_id: opts.pairId,
    enabled_currencies: opts.currencies.map((c) => c.toUpperCase()),
    closing_window_days: Math.max(30, Math.min(730, opts.closingDays)),
    wrapped_key_a: Array.from(wrapA),
    wrapped_key_b: Array.from(wrapB),
    name_enc: encBytes ? [encBytes] : [],
    name_iv: ivBytes ? [ivBytes] : [],
  });
  return { sheet, K_sheet };
}

/**
 * Publish E2E-encrypted account + member names for a pair, encrypted under
 * the given K_sheet. No-ops for empty names. Used after creating a sheet
 * and on sheet rotation (re-encrypt with the new K_sheet).
 */
export async function publishAccountNames(
  actor: any,
  K_sheet: Uint8Array,
  opts: { pairId: string; accountName?: string; profileName?: string },
): Promise<void> {
  if (opts.accountName && opts.accountName.trim()) {
    const { enc, iv } = await encryptName(K_sheet, opts.accountName.trim());
    await actor.set_pair_name(opts.pairId, enc, iv);
  }
  if (opts.profileName && opts.profileName.trim()) {
    const { enc, iv } = await encryptName(K_sheet, opts.profileName.trim());
    await actor.set_member_name(opts.pairId, enc, iv);
  }
}

/**
 * EAGERLY publish the caller's username as their member name to EVERY account they're in — one
 * set_member_name per active sheet, encrypted under that sheet's K_sheet (so only the partner can
 * read it). This is what makes "set your username once" propagate globally (instead of the lazy
 * publish-on-next-open in SheetPage). Best-effort per pair: a pair whose sheet key can't be unwrapped
 * (e.g. archived-only, or a transient decrypt failure) is skipped, not fatal. Returns counts so the
 * UI can report "published to N of M accounts".
 */
export async function publishUsernameToAllPairs(
  actor: any,
  unwrapFor: (sheetId: string) => Promise<Uint8Array>,
  username: string,
): Promise<{ published: number; total: number }> {
  const name = username.trim();
  const pairs: Array<{ id: string; active_sheet_id?: [] | [string] }> = await actor.get_my_pairs();
  if (!name) return { published: 0, total: pairs.length };
  let published = 0;
  for (const p of pairs) {
    const sheetId = p.active_sheet_id && p.active_sheet_id.length > 0 ? p.active_sheet_id[0] : undefined;
    if (!sheetId) continue;
    try {
      const K_sheet = await unwrapFor(sheetId);
      const { enc, iv } = await encryptName(K_sheet, name);
      await actor.set_member_name(p.id, enc, iv);
      published++;
    } catch {
      // best-effort: skip pairs we can't currently key/reach
    }
  }
  return { published, total: pairs.length };
}
