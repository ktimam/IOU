import type { DurableInboxActor } from "./durableInboxService";
import { localImportRecipient } from "./localImportSheet";
import { IOU_LOCAL_APP_REVISION, type IouDeliveryContext } from "./localImportEncryption";

/** Owner-authenticated metadata resolves navigation only, never consent or a ledger write. */
export async function resolveDurableInboxSheet(options: {
  actor: Pick<DurableInboxActor, "list_encrypted_inbox_grants">;
  inboxId: string;
  context: Pick<IouDeliveryContext, "principal" | "backendHost" | "backendCanisterId">;
  destination: string;
  assertCurrent: () => void;
}): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(options.inboxId)) throw new Error("Invalid inbox selector");
  let after: [] | [string] = [];
  for (let page = 0; page < 64; page++) {
    options.assertCurrent();
    const result = await options.actor.list_encrypted_inbox_grants(after);
    options.assertCurrent();
    if (!result || !("Ok" in result) || "Err" in result || !Array.isArray(result.Ok.grants)) throw new Error("Inbox unavailable");
    const grant = result.Ok.grants.find(value => value.inbox_id === options.inboxId);
    if (grant) {
      if (grant.app_id !== "iou" || grant.app_revision !== IOU_LOCAL_APP_REVISION ||
        grant.action_id !== "iou.entry.import" || grant.destination !== options.destination) throw new Error("Inbox destination changed");
      const recipient = localImportRecipient(grant.recipient_context, options.context);
      return `/sheet/${encodeURIComponent(recipient.sheetId)}`;
    }
    const next = result.Ok.next;
    if (!Array.isArray(next) || next.length > 1) throw new Error("Invalid inbox page");
    if (!next.length) break;
    if (!/^[a-f0-9]{64}$/.test(next[0]) || (after.length && next[0] <= after[0])) throw new Error("Invalid inbox cursor");
    after = [next[0]];
  }
  throw new Error("The connected inbox is unavailable for this account");
}
