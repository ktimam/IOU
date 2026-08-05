// Shared sheet-creation + name-publishing helpers.
//
// Used by: NewPair (auto-create the first sheet), NewSheet (manual new
// sheet), and CloseSheetButton (rotate to a fresh sheet on archive). Each
// In dev it generates and wraps a fresh K_sheet before creation. In production
// it creates the sheet first, derives the authoritative id-bound vetKD key,
// then stores any encrypted name. Both paths return the same public result so
// callers can cache K_sheet and publish account/member names.

import type { Identity } from "@dfinity/agent";
import {
  deriveUserKeypair,
  newSheetKey,
  wrapSheetKey,
  wrapSheetKeyTagged,
  encryptName,
  importPublicKeyB64Wrap,
} from "../crypto/devVetkd";
import {
  isProdVetkd,
  prepareProdSheetKey,
  deriveProdSheetKeyWithRetry,
  type ProdSheetKeyContext,
} from "../crypto/prodVetkd";
import { unwrap } from "./useActor";

const ANON = "2vxsx-fae";

/** Register the caller's own P-256 wrap pubkey (best-effort) so a partner's read
 *  path can cross-unwrap a sheet slot the caller sealed for them. */
async function registerMyWrapPubkey(actor: any, publicKeyB64: string): Promise<void> {
  try {
    await actor.register_sheet_pubkey(
      Array.from(new TextEncoder().encode(publicKeyB64)),
    );
  } catch {
    // best-effort: a transient failure just means the partner may need a retry
  }
}

/** Fetch + import a member's registered P-256 wrap pubkey, or null if unregistered. */
async function fetchWrapPubkey(actor: any, principal: any): Promise<CryptoKey | null> {
  const raw = unwrap(await actor.get_sheet_pubkey(principal)) as number[] | null;
  if (!raw || raw.length === 0) return null;
  const b64 = new TextDecoder().decode(new Uint8Array(raw));
  return importPublicKeyB64Wrap(b64);
}

// A sheet carries NO currency. There is one default currency and it is a USER-level setting
// (prefs.defaultCurrency): it pre-selects the entry form, and balances are grouped by whatever
// currencies the entries actually use. v1.12.0 removed `enabled_currencies` from the canister's
// Sheet + CreateSheetReq entirely, so there is nothing here to pass.
export type CreateSheetOpts = {
  pairId: string;
  closingDays: number;
  name?: string;
};

type CreateSheetRuntime = {
  isProdVetkd: () => boolean;
  prepareProdSheetKey: (actor: any) => Promise<ProdSheetKeyContext>;
  deriveProdSheetKeyWithRetry: (
    actor: any,
    sheetId: string,
    prepared: ProdSheetKeyContext,
  ) => Promise<Uint8Array>;
};

const DEFAULT_CREATE_SHEET_RUNTIME: CreateSheetRuntime = {
  isProdVetkd,
  prepareProdSheetKey,
  deriveProdSheetKeyWithRetry,
};

/**
 * create_sheet succeeded, so callers must open the returned sheet instead of
 * issuing another create. SheetKeyContext will retry derivation on that page.
 */
export class SheetCreatedSetupError extends Error {
  constructor(
    readonly sheet: any,
    readonly K_sheet: Uint8Array | undefined,
    readonly stage: "key-derivation" | "name",
    cause: unknown,
  ) {
    super(
      stage === "key-derivation"
        ? "The sheet was created, but its encryption key could not be loaded. Opening the existing sheet to retry."
        : "The sheet was created, but its encrypted name could not be saved. Opening the existing sheet.",
      { cause },
    );
    this.name = "SheetCreatedSetupError";
  }
}

/** Create a sheet for a pair. Returns the new sheet + its K_sheet. */
export async function createSheetForPair(
  actor: any,
  identity: Identity,
  opts: CreateSheetOpts,
  runtime: CreateSheetRuntime = DEFAULT_CREATE_SHEET_RUNTIME,
): Promise<{ sheet: any; K_sheet: Uint8Array }> {
  const pair = unwrap(await actor.get_pair(opts.pairId)) as any;
  if (!pair) throw new Error("Pair not found or not a member.");
  const asText = (p: any) =>
    p && typeof p.toText === "function" ? p.toText() : String(p ?? "");
  const memberA = pair.members?.[0];
  const memberB = pair.members?.[1];
  const memberAText = asText(memberA);
  const memberBText = asText(memberB);
  const isSolo = memberBText === "" || memberBText === ANON;

  const prod = runtime.isProdVetkd();
  // Validate this session's ephemeral transport key and the canister's master
  // key before create_sheet. The returned sheet id is the only input unavailable
  // here.
  const prepared = prod ? await runtime.prepareProdSheetKey(actor) : undefined;
  let K_sheet: Uint8Array | undefined;

  // Wrap K_sheet for both member slots so each member can unwrap THEIR slot.
  //
  // Dev (P-256 ECDH): seal our own slot to ourselves (self-ECDH). For a shared
  // pair, seal the OTHER member's slot under THEIR registered wrap pubkey as a
  // TAGGED cross-wrap (embeds our pubkey) — a self-wrap would lock the partner out
  // of any sheet created AFTER they joined (we don't hold their private key), and
  // tagging keeps their slot readable even after we later leave and our member slot
  // is anonymized. We also (re)register our own pubkey so we can be a cross-wrap
  // RECIPIENT when the partner creates a sheet. Solo ⇒ empty placeholder for
  // member_b (filled by accept_invite when a partner joins).
  //
  // Prod (vetkd): the wrapped blobs are unused (the IC re-derives K_sheet per
  // member); use validated public transport material as the non-empty
  // wrapped_key_a placeholder.
  let wrapA: Uint8Array;
  let wrapB: Uint8Array;
  if (prod) {
    // These blobs are a legacy/dev storage field. Production authorization is
    // sheet membership and K_sheet is derived from the sheet id. Reuse the
    // validated public transport material as a non-secret placeholder rather
    // than wrapping a disposable random key.
    const placeholder = prepared!.transport.publicKey;
    wrapA = placeholder;
    wrapB = isSolo ? new Uint8Array(0) : placeholder;
  } else {
    const myPrincipal = identity.getPrincipal().toText();
    const myKp = await deriveUserKeypair(myPrincipal);
    K_sheet = newSheetKey();
    await registerMyWrapPubkey(actor, myKp.publicKeyB64);
    const selfWrap = await wrapSheetKey(K_sheet, myKp.publicKey, myKp.privateKey);
    if (isSolo) {
      wrapA = selfWrap;
      wrapB = new Uint8Array(0);
    } else {
      const iAmMemberA = myPrincipal === memberAText;
      const otherMember = iAmMemberA ? memberB : memberA;
      const otherPub = await fetchWrapPubkey(actor, otherMember);
      if (!otherPub) {
        throw new Error(
          "Your partner hasn't published their key yet — ask them to open this account once, then try again.",
        );
      }
      const crossWrap = await wrapSheetKeyTagged(
        K_sheet,
        otherPub,
        myKp.privateKey,
        myKp.publicKeyB64,
      );
      wrapA = iAmMemberA ? selfWrap : crossWrap;
      wrapB = iAmMemberA ? crossWrap : selfWrap;
    }
  }

  let encBytes: number[] | null = null;
  let ivBytes: number[] | null = null;
  // The authoritative production key contains the new sheet id, so production
  // names are encrypted only after create_sheet returns. Dev remains atomic.
  if (!prod && opts.name && opts.name.trim()) {
    const r = await encryptName(K_sheet!, opts.name.trim());
    encBytes = r.enc;
    ivBytes = r.iv;
  }

  const sheet = await actor.create_sheet({
    pair_id: opts.pairId,
    closing_window_days: Math.max(30, Math.min(730, opts.closingDays)),
    wrapped_key_a: Array.from(wrapA),
    wrapped_key_b: Array.from(wrapB),
    name_enc: encBytes ? [encBytes] : [],
    name_iv: ivBytes ? [ivBytes] : [],
  });

  if (prod) {
    try {
      K_sheet = await runtime.deriveProdSheetKeyWithRetry(actor, sheet.id, prepared!);
    } catch (error) {
      // create_sheet is never retried after success. Callers open this exact
      // sheet and the shared read path retries its key derivation there.
      throw new SheetCreatedSetupError(sheet, undefined, "key-derivation", error);
    }
    if (opts.name && opts.name.trim()) {
      try {
        const name = await encryptName(K_sheet, opts.name.trim());
        await actor.set_sheet_name(sheet.id, name.enc, name.iv);
      } catch (error) {
        throw new SheetCreatedSetupError(sheet, K_sheet, "name", error);
      }
    }
  }
  return { sheet, K_sheet: K_sheet! };
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
