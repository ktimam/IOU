import {
  deriveUserKeypair,
  wrapSheetKey,
} from "../crypto/devVetkd";
import { isProdVetkd } from "../crypto/prodVetkd";
import { acceptVaultInvite } from "../crypto/vaultInvites";
import { b64uDecode, type InviteParams } from "../flows/inviteLink";

type AcceptInviteRuntime = {
  isProdVetkd: () => boolean;
  acceptVaultInvite: typeof acceptVaultInvite;
  deriveUserKeypair: typeof deriveUserKeypair;
  wrapSheetKey: typeof wrapSheetKey;
};

const DEFAULT_ACCEPT_INVITE_RUNTIME: AcceptInviteRuntime = {
  isProdVetkd,
  acceptVaultInvite,
  deriveUserKeypair,
  wrapSheetKey,
};

/**
 * Accept an invite and return its existing K_sheet. Production decrypts an
 * opaque invitation and submits a recipient-bound copy without paid derivation.
 */
export async function acceptInviteForSheet(
  actor: any,
  principal: string,
  invite: InviteParams,
  runtime: AcceptInviteRuntime = DEFAULT_ACCEPT_INVITE_RUNTIME,
  assertCurrent: () => void = () => undefined,
): Promise<{ K_sheet: Uint8Array | null }> {
  assertCurrent();
  if (runtime.isProdVetkd()) {
    return runtime.acceptVaultInvite(actor, principal, invite, assertCurrent);
  }

  const myKp = await runtime.deriveUserKeypair(principal);
  if (!invite.keyB64u) throw new Error("invite link is missing the sheet key");
  const K_sheet = b64uDecode(invite.keyB64u);
  const blob = await runtime.wrapSheetKey(
    K_sheet,
    myKp.publicKey,
    myKp.privateKey,
  );
  const pubkey = Array.from(new TextEncoder().encode(myKp.publicKeyB64));
  try {
    assertCurrent();
    await actor.accept_invite(
      invite.code,
      [{ sheet_id: invite.sheetId, wrapped_key_for_partner: Array.from(blob) }],
      pubkey,
    );
    assertCurrent();
    return { K_sheet };
  } catch (error) { K_sheet.fill(0); throw error; }
}
