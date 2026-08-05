// Pure helpers for the on-chain inbox double-confirm dedupe (#5), extracted from SheetPage so the
// logic is unit-testable in isolation.
//
// A single chat message can, in a rare double-confirm race, produce two on-chain deposits with the
// SAME app-scoped context.messageHandle. We defend on two layers: collapse the VISIBLE
// cards to the first per handle, and guard the accept path with a persisted set of already-imported
// handles. Drafts without a handle (wrapper-less local compatibility deposits)
// are NEVER collapsed — collapsing an undefined key would hide distinct real drafts.

/**
 * Keep the first item for each `context.messageHandle`, preserving input order.
 */
import { scopedStorageKey } from "../storage/scopedStorage";

export function collapseByMessageHandle<T extends { context?: { messageHandle?: string } }>(
  items: T[],
): T[] {
  const seen = new Set<string>();
  return items.filter((p) => {
    const m = p.context?.messageHandle;
    if (m === undefined) return true;
    if (seen.has(m)) return false;
    seen.add(m);
    return true;
  });
}

/**
 * Cross-member "already imported" predicate: has ANY member of the sheet already imported this
 * pending card as an entry? Fan-out deposits carry the SAME app-scoped message handle; importing
 * writes that handle into the shared encrypted entry as
 * `payload.import_message_id`, so every member's decrypted entries carry the signal.
 *
 * Matching rules:
 *  - Card WITH a messageId → match ONLY non-deleted entries whose `import_message_id` equals it.
 *    Deliberately NO fallback to the content-hash `draft_id`: (a) per-user template sets make the
 *    derived hash diverge between members, and (b) two legitimately-distinct cards can share
 *    identical content (two same-price bookings) — a content match would falsely suppress a real
 *    card. Legacy entries imported before `import_message_id` existed therefore do NOT hide their
 *    card for the partner (acceptable: dismiss once).
 *  - Card WITHOUT a messageId (wrapper-less / pre-v4 local deposit) → fall back to `draft_id` equality
 *    against non-deleted entries (same rule as the paste path's isDuplicateDraft).
 *  - DELETED entries never match: deleting the imported entry resurrects the card for members who
 *    have not locally dismissed it.
 */
export function isImportedIntoSheet(
  entries: { deleted: boolean; payload: { draft_id?: string; import_message_id?: string } }[],
  messageHandle: string | undefined,
  draftId: string | undefined,
): boolean {
  if (messageHandle !== undefined) {
    return entries.some((e) => !e.deleted && e.payload.import_message_id === messageHandle);
  }
  if (draftId !== undefined) {
    return entries.some((e) => !e.deleted && e.payload.draft_id === draftId);
  }
  return false;
}

/**
 * Tolerantly parse the persisted importedMessageIds payload (a JSON string array) into a Set.
 * Anything malformed (non-JSON, non-array, non-string entries) degrades to an empty/filtered set —
 * a corrupt store must never throw and never block importing.
 */
export function parseImportedMessageIds(raw: string | null): Set<string> {
  try {
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

/**
 * Serialize the set for persistence, capped to the most-recent `cap` ids (insertion order) so the
 * store can't grow without bound. Returns the JSON string to write.
 */
export function serializeImportedMessageIds(ids: Iterable<string>, cap: number): string {
  return JSON.stringify([...ids].slice(-cap));
}

// ── Deployment-scoped dedup keys ──────────────────────────────────────────────────────────────
// Signed delivery identities and imported messageIds persist across reloads, but remain specific to
// one OpenChat deployment. Both stores are scoped by UserIndex so recreated local deployments do not
// inherit unrelated handled state. Numeric ActionInbox storage ids are never used as durable identity.

/** The scope tag: the user_index canister id (trimmed) or "default" when unknown. */
export function deriveDeployTag(userIndexId: string | undefined | null): string {
  const id = typeof userIndexId === "string" ? userIndexId.trim() : "";
  return id || "default";
}

export function inboxDedupeStorageKey(
  namespace: string,
  principal: string,
  openChatDeployment: string,
  iouDeployment?: string,
): string {
  return scopedStorageKey(
    namespace + "." + encodeURIComponent(openChatDeployment),
    principal,
    iouDeployment,
  );
}

export const OBSOLETE_INBOX_STORAGE_SCAN_CAP = 10_000;

/**
 * Return legacy inbox-dedupe keys which are safe to remove. Every v2 key is
 * obsolete now that v3 includes principal, IOU deployment, and OpenChat
 * deployment. Discovery is bounded so hostile local storage cannot cause an
 * unbounded startup scan.
 */
export function planObsoleteInboxStorageCleanup(
  existingKeys: Iterable<string>,
): string[] {
  const remove = new Set<string>([
    "iou.openchat.handledInboxDrafts.v1",
    "iou.openchat.importedMessageIds.v1",
  ]);
  const iterator = existingKeys[Symbol.iterator]();
  for (let scanned = 0; scanned < OBSOLETE_INBOX_STORAGE_SCAN_CAP; scanned++) {
    const next = iterator.next();
    if (next.done) break;
    const key = next.value;
    if (
      key.startsWith("iou.openchat.handledInboxDrafts.v2.") ||
      key.startsWith("iou.openchat.importedMessageIds.v2.") ||
      key.startsWith("iou.openchat.viewerUserId.v1.")
    ) {
      remove.add(key);
    }
  }
  iterator.return?.();
  return [...remove];
}

/**
 * Plan the deployment-scoped localStorage key. Pure so it is unit-testable; the caller performs the
 * removals. Returns the key to KEEP (`prefix.tag`) and the keys to REMOVE — the pre-scoping legacy
 * key plus any `prefix.*` key from a DIFFERENT deployment. A fresh deployment thus reads an empty set.
 */
export function planScopedInboxKey(
  prefix: string,
  deployTag: string,
  legacyKey: string,
  existingKeys: string[],
): { keep: string; remove: string[] } {
  const keep = `${prefix}.${deployTag}`;
  const remove = [legacyKey, ...existingKeys.filter((k) => k.startsWith(`${prefix}.`) && k !== keep)];
  return { keep, remove: [...new Set(remove)] };
}
