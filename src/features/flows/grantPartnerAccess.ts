// Grant a joined partner access to the pair's current (solo-created) sheet.
//
// Production wraps the existing key to the partner's published account-vault
// key. Missing legacy keys require explicit migration, never paid fallback.
//
// Dev (P-256 ECDH): the partner needs K_sheet sealed to *their* key. We
// unwrap K_sheet locally (the creator self-wrapped it), fetch the partner's
// canister-attested wrap pubkey (register_sheet_pubkey, not a pasted string),
// re-wrap to it, and submit. The canister never sees plaintext K_sheet.

import { Principal } from "@dfinity/principal";
import {
  isProdVetkd,
  deriveUserKeypair,
  importPublicKeyB64Wrap,
  wrapSheetKey,
} from "../crypto/devVetkd";
import { sheetKeyInfo, wrapSheetKeyForMember } from "../crypto/vaultSheets";
import { assertAccountVaultSessionGeneration, readAccountVaultSessionGeneration } from "../crypto/accountVault";

function optUnwrap<T>(opt: T | T[] | null | undefined): T | null {
  if (opt == null) return null;
  if (Array.isArray(opt)) return (opt[0] as T) ?? null;
  return opt;
}

export async function grantPartnerAccess(opts: {
  actor: any;
  identity: { getPrincipal: () => { toText: () => string } };
  pairId: string;
  partnerPrincipalText: string;
  activeSheetId: string;
  getKSheet: (sheetId: string) => Promise<Uint8Array>;
}): Promise<number> {
  const partner = Principal.fromText(opts.partnerPrincipalText);

  if (isProdVetkd()) {
    const generation = readAccountVaultSessionGeneration();
    const info = await sheetKeyInfo(opts.actor, opts.activeSheetId);
    const K_sheet = await opts.getKSheet(opts.activeSheetId);
    const wrapped = await wrapSheetKeyForMember(opts.actor, K_sheet, opts.pairId, info.key_id, opts.partnerPrincipalText);
    assertAccountVaultSessionGeneration(generation);
    const n = await opts.actor.grant_partner_access(opts.pairId, partner, [
      { sheet_id: opts.activeSheetId, wrapped_key_for_partner: wrapped },
    ]);
    assertAccountVaultSessionGeneration(generation);
    return Number(n);
  }

  const K_sheet = await opts.getKSheet(opts.activeSheetId);
  const raw = optUnwrap<number[] | Uint8Array>(
    await opts.actor.get_sheet_pubkey(partner),
  );
  if (!raw) {
    throw new Error(
      "Your partner hasn't published their key yet — ask them to open the pair page, then retry.",
    );
  }
  const partnerB64 = new TextDecoder().decode(new Uint8Array(raw as number[]));
  const partnerPub = await importPublicKeyB64Wrap(partnerB64);
  const myKp = await deriveUserKeypair(opts.identity.getPrincipal().toText());
  const wrapped = await wrapSheetKey(K_sheet, partnerPub, myKp.privateKey);
  const n = await opts.actor.grant_partner_access(opts.pairId, partner, [
    {
      sheet_id: opts.activeSheetId,
      wrapped_key_for_partner: Array.from(wrapped),
    },
  ]);
  return Number(n);
}
