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
