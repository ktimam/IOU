// Pure helpers for the on-chain inbox double-confirm dedupe (#5), extracted from SheetPage so the
// logic is unit-testable in isolation.
//
// A single chat message can, in a rare double-confirm race, produce two on-chain deposits with the
// SAME context.messageId (different confirmedBy). We defend on two layers: collapse the VISIBLE
// cards to the first per messageId, and (in the component) guard the accept path with a persisted
// set of already-imported messageIds. Drafts without a messageId (wrapper-less / pre-v2 deposits)
// are NEVER collapsed — collapsing an undefined key would hide distinct real drafts.

/**
 * Keep the first item for each `context.messageId`, preserving input order. Items whose
 * `context.messageId` is undefined all pass through (never collapsed).
 */
export function collapseByMessageId<T extends { context?: { messageId?: string } }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((p) => {
    const m = p.context?.messageId;
    if (m === undefined) return true;
    if (seen.has(m)) return false;
    seen.add(m);
    return true;
  });
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
// Both inbox dedup sets (dismissed inbox ids; imported messageIds) persist across reloads, but they
// are SPECIFIC TO ONE OpenChat deployment: inbox action ids (`oc-<id>`) restart from 1 on every
// clean redeploy, and messageIds come from a specific OpenChat instance. A set carried over from an
// EARLIER deployment would wrongly suppress a fresh deployment's low-/reused-id deposits — the
// "confirmed in OpenChat but never imported after an environment restart" bug. So both are SCOPED by
// the OpenChat user_index canister id (which changes on every clean redeploy).

/** The scope tag: the user_index canister id (trimmed) or "default" when unknown. */
export function deriveDeployTag(userIndexId: string | undefined | null): string {
  const id = typeof userIndexId === "string" ? userIndexId.trim() : "";
  return id || "default";
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
