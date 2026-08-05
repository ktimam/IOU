import {
  deriveUserKeypair,
  wrapSheetKey,
} from "../crypto/devVetkd";
import {
  isProdVetkd,
  prepareProdSheetKey,
  deriveProdSheetKeyWithRetry,
  type ProdSheetKeyContext,
} from "../crypto/prodVetkd";
import { b64uDecode, type InviteParams } from "../flows/inviteLink";

type AcceptInviteRuntime = {
  isProdVetkd: () => boolean;
  prepareProdSheetKey: (actor: any) => Promise<ProdSheetKeyContext>;
  deriveProdSheetKeyWithRetry: (
    actor: any,
    sheetId: string,
    prepared: ProdSheetKeyContext,
  ) => Promise<Uint8Array>;
  deriveUserKeypair: typeof deriveUserKeypair;
  wrapSheetKey: typeof wrapSheetKey;
};

const DEFAULT_ACCEPT_INVITE_RUNTIME: AcceptInviteRuntime = {
  isProdVetkd,
  prepareProdSheetKey,
  deriveProdSheetKeyWithRetry,
  deriveUserKeypair,
  wrapSheetKey,
};

/**
 * Accept an invite and return a warm K_sheet when available. Production sends
 * an explicit empty rewrap record: its blob is unused, but the record is what
 * establishes sheet.member_b and authorizes the partner's first derivation.
 */
export async function acceptInviteForSheet(
  actor: any,
  principal: string,
  invite: InviteParams,
  runtime: AcceptInviteRuntime = DEFAULT_ACCEPT_INVITE_RUNTIME,
): Promise<{ K_sheet: Uint8Array | null }> {
  if (runtime.isProdVetkd()) {
    const prepared = await runtime.prepareProdSheetKey(actor);
    await actor.accept_invite(
      invite.code,
      [{ sheet_id: invite.sheetId, wrapped_key_for_partner: [] }],
      Array.from(prepared.transport.publicKey),
    );
    try {
      return {
        K_sheet: await runtime.deriveProdSheetKeyWithRetry(
          actor,
          invite.sheetId,
          prepared,
        ),
      };
    } catch {
      // Membership is already committed and the single-use invite consumed.
      // Do not report acceptance as failed; SheetKeyContext retries the same
      // derivation when the newly joined sheet opens.
      return { K_sheet: null };
    }
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
  await actor.accept_invite(
    invite.code,
    [{ sheet_id: invite.sheetId, wrapped_key_for_partner: Array.from(blob) }],
    pubkey,
  );
  return { K_sheet };
}
