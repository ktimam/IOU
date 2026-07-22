// SHARED transaction types per account — the PURE core (no React, no actor,
// no crypto imports; fully unit-tested in pairTemplates.test.ts).
//
// Model: each pair member publishes the templates they chose to share into
// THEIR OWN encrypted slot on the Pair record (templates_a_* for members[0],
// templates_b_* for members[1] — set_pair_templates routes by caller), sealed
// under the active sheet's K_sheet. Per-member slots make write conflicts
// structurally impossible: I only ever overwrite MY slot. Both members read
// both slots via get_pair and merge client-side with mergePairTemplates.
//
// Merge contract (commutative — merge(a,b) deep-equals merge(b,a), so both
// clients converge without coordination):
//   * union by template id;
//   * same id in both slots → higher `rev` wins;
//   * equal rev → higher `updatedAt` wins;
//   * full tie (both-edit conflict) → deterministic content tiebreak;
//   * `deleted: true` envelopes are tombstones: they win like any other rev
//     and hide the template from the visible view; a later higher-rev
//     republish resurrects it.
//
// Editing a PARTNER-authored template is copy-on-write: publish an override
// with the SAME id at nextRev(...) into MY slot — their slot is untouched,
// and the merge shows my newer version on both sides.

import type { TxnTemplate } from "./TemplatesContext";

/** A shared template envelope: the template + merge bookkeeping. */
export type SharedTemplate = TxnTemplate & {
  /** Per-template edit revision; starts at 1, bumped on every republish. */
  rev: number;
  /** ms epoch of the publish (rev tiebreak only — no clock trust needed). */
  updatedAt: number;
  /** Tombstone: unshared/deleted. Hidden from the visible view. */
  deleted?: true;
};

// ── codec ────────────────────────────────────────────────────────────

/** Encode a slot as bytes (JSON). The caller encrypts under K_sheet. */
export function encodePairSlot(slot: SharedTemplate[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(slot));
}

function isValidEnvelope(x: unknown): x is SharedTemplate {
  if (x == null || typeof x !== "object" || Array.isArray(x)) return false;
  const t = x as Record<string, unknown>;
  return (
    typeof t.id === "string" &&
    t.id.length > 0 &&
    typeof t.rev === "number" &&
    Number.isFinite(t.rev)
  );
}

/**
 * Decode a slot from bytes. TOLERANT by design: absent slots (pre-upgrade
 * Pair records decode the new fields as None), empty blobs, non-JSON,
 * non-array JSON and malformed items all degrade to `[]` / get dropped —
 * a partner's unreadable slot must never break the sheet page.
 */
export function decodePairSlot(
  bytes: Uint8Array | number[] | null | undefined,
): SharedTemplate[] {
  if (bytes == null) return [];
  const u8 = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  if (u8.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(u8));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidEnvelope);
  } catch {
    return [];
  }
}

// ── merge ────────────────────────────────────────────────────────────

/**
 * Deterministic, ORDER-INDEPENDENT winner between two envelopes with the
 * same id. Higher rev → higher updatedAt → content tiebreak (canonical
 * JSON compare over sorted keys), so merge(a,b) === merge(b,a) even when
 * both members edited the same rev at the same millisecond.
 */
function pickWinner(x: SharedTemplate, y: SharedTemplate): SharedTemplate {
  if (x.rev !== y.rev) return x.rev > y.rev ? x : y;
  if ((x.updatedAt ?? 0) !== (y.updatedAt ?? 0)) {
    return (x.updatedAt ?? 0) > (y.updatedAt ?? 0) ? x : y;
  }
  return canonical(x) >= canonical(y) ? x : y;
}

/** Canonical JSON (sorted keys) so the content tiebreak is stable. */
function canonical(t: SharedTemplate): string {
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(t).sort()) {
    sorted[k] = (t as Record<string, unknown>)[k];
  }
  return JSON.stringify(sorted);
}

/**
 * Merge the two member slots. Returns ALL surviving envelopes — including
 * tombstones (callers need them for rev bookkeeping via nextRev) — sorted
 * stably by name (case-insensitive), then id. Never mutates its inputs.
 */
export function mergePairTemplates(
  slotA: SharedTemplate[],
  slotB: SharedTemplate[],
): SharedTemplate[] {
  const byId = new Map<string, SharedTemplate>();
  for (const t of [...slotA, ...slotB]) {
    const seen = byId.get(t.id);
    byId.set(t.id, seen ? pickWinner(seen, t) : t);
  }
  return [...byId.values()].sort((a, b) => {
    const an = (a.name ?? "").toLowerCase();
    const bn = (b.name ?? "").toLowerCase();
    if (an !== bn) return an < bn ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** The user-visible shared templates: merged, tombstones hidden. */
export function visibleTemplates(merged: SharedTemplate[]): SharedTemplate[] {
  return merged.filter((t) => !t.deleted);
}

// ── publish helpers ──────────────────────────────────────────────────

/**
 * The rev to publish for `id`: one past the highest rev either member has
 * for it (tombstones count — resurrect ABOVE the tombstone), or 1 when new.
 */
export function nextRev(merged: SharedTemplate[], id: string): number {
  let max = 0;
  for (const t of merged) if (t.id === id && t.rev > max) max = t.rev;
  return max + 1;
}

/** Replace-by-id (or append) into a slot. Returns a new array. */
export function upsertSlot(
  slot: SharedTemplate[],
  t: SharedTemplate,
): SharedTemplate[] {
  const i = slot.findIndex((x) => x.id === t.id);
  if (i === -1) return [...slot, t];
  const next = slot.slice();
  next[i] = t;
  return next;
}

/**
 * The template list a pair-scoped consumer (entry-form picker, manifest
 * keyword map) actually uses: the user's PERSONAL templates plus the
 * account's SHARED ones. Personal order is preserved, shared follow; on an
 * id collision the shared version wins (in a pair context the shared copy
 * is the account's agreed shape). Tombstoned shared envelopes are ignored
 * — they never shadow a personal template.
 */
export function combineTemplates(
  personal: TxnTemplate[],
  shared: SharedTemplate[],
): TxnTemplate[] {
  const live = visibleTemplates(shared);
  const sharedById = new Map(live.map((t) => [t.id, t]));
  const out: TxnTemplate[] = personal.map((p) => sharedById.get(p.id) ?? p);
  const personalIds = new Set(personal.map((p) => p.id));
  for (const s of live) if (!personalIds.has(s.id)) out.push(s);
  return out;
}
