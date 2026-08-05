// ACCOUNT-SCOPED transaction types — the PURE core (no React, no actor,
// no crypto imports; fully unit-tested in pairTemplates.test.ts).
//
// Model: a transaction type belongs to the ACCOUNT (pair) where it was
// created. The manager writes it into the author's OWN slot on that Pair
// record (templates_a_* for members[0], templates_b_* for members[1] —
// set_pair_templates routes by caller), sealed under the active sheet's
// K_sheet. It is visible to BOTH members of that account, in that account
// ONLY — not in the author's other accounts, not to anyone else; there is
// no user-global type that follows you across accounts. Per-member slots
// make write conflicts structurally impossible: I only ever overwrite MY
// slot. Both members read both slots via get_pair and merge client-side
// with mergePairTemplates.
//
// Merge contract (commutative — merge(a,b) deep-equals merge(b,a), so both
// clients converge without coordination):
//   * union by template id;
//   * same id in both slots → higher `rev` wins;
//   * equal rev → higher `updatedAt` wins;
//   * full tie (both-edit conflict) → deterministic content tiebreak;
//   * `deleted: true` envelopes are tombstones (LEGACY: no longer written —
//     removal is absence from the slot — but old slots may still contain
//     them): they win like any other rev and hide the template from the
//     visible view; a later higher-rev republish resurrects it.
//
// CRUD is upsertMyTemplateSlot / removeTemplateFromSlot. Editing a
// PARTNER-authored template is copy-on-write: the SAME-id upsert lands the
// edited copy in MY slot at nextRev(...); their slot is untouched, and the
// merge shows my newer version on both sides. Removing my copy drops the id
// from my slot, so their original resurfaces; removing my own type removes
// it for both members.
//
// v2 payload: the encoded slot is a versioned envelope
// {v:2, templates:[...], dismissed:[...messageIds]} — `dismissed` syncs
// "✕ dismissed" pending-from-chat cards to ALL members (union across slots,
// capped at DISMISSED_CAP; inbox envelopes expire server-side anyway, so a
// pruned id at worst resurfaces an ancient card). The canister treats the
// blob as opaque bytes, so this evolution is entirely client-side; legacy
// bare-array (v1) blobs still decode.

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

/** Decoded slot payload: shared templates + cross-member dismissed card ids. */
export type PairSlotPayload = {
  templates: SharedTemplate[];
  /** OpenChat `context.messageId` strings of "✕ dismissed" pending cards,
   *  in insertion order (oldest first). Capped at DISMISSED_CAP. */
  dismissed: string[];
};

/**
 * Cap on the stored dismissed-id list (oldest pruned first). 300 ids of
 * ≤40 JSON bytes each ≈ 12 KB — comfortably inside the canister's 64 000-
 * byte check_templates_blob guard alongside the templates; and the inbox
 * envelopes a dismissal suppresses expire server-side anyway, so a pruned
 * id can at worst resurface a long-dead card.
 */
export const DISMISSED_CAP = 300;
const PAIR_SLOT_MAX_BYTES = 64_000;
const PAIR_TEMPLATE_CAP = 100;
const TEMPLATE_ID_MAX_LENGTH = 128;
const TEMPLATE_NAME_MAX_LENGTH = 200;
const TEMPLATE_NOTE_MAX_LENGTH = 2_000;
const TEMPLATE_KEYWORD_CAP = 50;
const TEMPLATE_KEYWORD_MAX_LENGTH = 64;
const TEMPLATE_SCHEDULE_CAP = 100;
const TEMPLATE_OFFSET_MAX_DAYS = 36_500;

/**
 * Encode a slot as bytes (JSON, v2 envelope). The caller encrypts under
 * K_sheet. Always writes {v:2, templates, dismissed}.
 */
export function encodePairSlot(
  templates: SharedTemplate[],
  dismissed: string[] = [],
): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ v: 2, templates, dismissed }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isBoundedNonEmptyString(
  value: unknown,
  maxLength: number,
): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength
  );
}

function isCurrency(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z]{3}$/.test(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function decodeTemplate(value: unknown): SharedTemplate | null {
  if (!isRecord(value)) return null;

  const id = value.id;
  const name = value.name;
  const direction = value.direction;
  const txnType = value.txn_type;
  const rev = value.rev;
  const updatedAt = value.updatedAt;

  if (
    !isBoundedNonEmptyString(id, TEMPLATE_ID_MAX_LENGTH) ||
    !isBoundedNonEmptyString(name, TEMPLATE_NAME_MAX_LENGTH) ||
    (direction !== "credit" && direction !== "debt") ||
    (txnType !== "settlement" && txnType !== "iou") ||
    typeof rev !== "number" ||
    !Number.isSafeInteger(rev) ||
    rev < 1 ||
    rev >= Number.MAX_SAFE_INTEGER ||
    !isNonNegativeSafeInteger(updatedAt) ||
    !Number.isFinite(new Date(updatedAt).getTime()) ||
    (value.deleted !== undefined && value.deleted !== true) ||
    (value.currency !== undefined && !isCurrency(value.currency)) ||
    (value.amount_minor !== undefined &&
      !isNonNegativeSafeInteger(value.amount_minor)) ||
    (value.fee_percent !== undefined &&
      (typeof value.fee_percent !== "number" ||
        !Number.isFinite(value.fee_percent) ||
        value.fee_percent < 0 ||
        value.fee_percent > 100)) ||
    (value.fee_fixed_minor !== undefined &&
      !isNonNegativeSafeInteger(value.fee_fixed_minor)) ||
    (value.fee_fixed_currency !== undefined &&
      !isCurrency(value.fee_fixed_currency)) ||
    (value.note !== undefined &&
      (typeof value.note !== "string" ||
        value.note.length > TEMPLATE_NOTE_MAX_LENGTH))
  ) {
    return null;
  }

  const hasFee =
    value.fee_percent !== undefined ||
    value.fee_fixed_minor !== undefined ||
    value.fee_fixed_currency !== undefined;
  if (
    (txnType === "settlement" &&
      (hasFee || value.schedule !== undefined)) ||
    (value.fee_fixed_currency !== undefined &&
      (value.fee_fixed_minor === undefined ||
        (value.fee_fixed_minor as number) <= 0))
  ) {
    return null;
  }

  let schedule: TxnTemplate["schedule"];
  if (value.schedule !== undefined) {
    if (
      !Array.isArray(value.schedule) ||
      value.schedule.length === 0 ||
      value.schedule.length > TEMPLATE_SCHEDULE_CAP
    ) {
      return null;
    }
    schedule = [];
    let percentTotal = 0;
    for (const row of value.schedule) {
      if (!isRecord(row)) return null;
      const offsetDays = row.offset_days;
      const percent = row.percent;
      const anchor = row.anchor;
      if (
        !isNonNegativeSafeInteger(offsetDays) ||
        offsetDays > TEMPLATE_OFFSET_MAX_DAYS ||
        typeof percent !== "number" ||
        !Number.isFinite(percent) ||
        percent < 0 ||
        percent > 100 ||
        (anchor !== undefined &&
          anchor !== "in_days" &&
          anchor !== "start_of_next_month") ||
        (anchor === "start_of_next_month" && offsetDays !== 0)
      ) {
        return null;
      }
      percentTotal += percent;
      schedule.push({
        offset_days: offsetDays,
        percent,
        ...(anchor === undefined ? {} : { anchor }),
      });
    }
    if (percentTotal !== 100) return null;
  }

  let keywords: string[] | undefined;
  if (value.keywords !== undefined) {
    if (
      !Array.isArray(value.keywords) ||
      value.keywords.length > TEMPLATE_KEYWORD_CAP
    ) {
      return null;
    }
    keywords = [];
    for (const keyword of value.keywords) {
      if (
        !isBoundedNonEmptyString(
          keyword,
          TEMPLATE_KEYWORD_MAX_LENGTH,
        )
      ) {
        return null;
      }
      keywords.push(keyword);
    }
  }

  const decoded: SharedTemplate = {
    id,
    name,
    direction,
    txn_type: txnType,
    rev,
    updatedAt,
  };
  if (value.deleted === true) decoded.deleted = true;
  if (value.currency !== undefined) {
    decoded.currency = value.currency as string;
  }
  if (value.amount_minor !== undefined) {
    decoded.amount_minor = value.amount_minor as number;
  }
  if (value.fee_percent !== undefined) {
    decoded.fee_percent = value.fee_percent as number;
  }
  if (value.fee_fixed_minor !== undefined) {
    decoded.fee_fixed_minor = value.fee_fixed_minor as number;
  }
  if (value.fee_fixed_currency !== undefined) {
    decoded.fee_fixed_currency = value.fee_fixed_currency as string;
  }
  if (schedule !== undefined) decoded.schedule = schedule;
  if (value.note !== undefined) decoded.note = value.note as string;
  if (keywords !== undefined) decoded.keywords = keywords;
  return decoded;
}

function decodeTemplates(values: unknown[]): SharedTemplate[] {
  const templates: SharedTemplate[] = [];
  for (const value of values) {
    const decoded = decodeTemplate(value);
    if (decoded !== null) templates.push(decoded);
    if (templates.length === PAIR_TEMPLATE_CAP) break;
  }
  return templates;
}

function decodeDismissed(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const valid: string[] = [];
  for (const id of value) {
    if (isBoundedNonEmptyString(id, TEMPLATE_ID_MAX_LENGTH)) {
      valid.push(id);
    }
  }
  return mergeDismissed([], valid);
}

function emptyPayload(): PairSlotPayload {
  return { templates: [], dismissed: [] };
}

/**
 * Decode a slot from bytes. Accepts BOTH formats: the legacy v1 bare array
 * (→ {templates, dismissed: []}) and the v2 {v, templates, dismissed}
 * envelope. TOLERANT by design: absent slots (pre-upgrade Pair records
 * decode the new fields as None), empty blobs, non-JSON, unrecognized JSON
 * and malformed items all degrade to the empty payload / get dropped — a
 * partner's unreadable slot must never break the sheet page.
 */
export function decodePairSlot(
  bytes: Uint8Array | number[] | null | undefined,
): PairSlotPayload {
  if (bytes == null) return emptyPayload();
  if (bytes.length === 0 || bytes.length > PAIR_SLOT_MAX_BYTES) {
    return emptyPayload();
  }
  const u8 = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(u8));
    // Legacy v1: a bare array of envelopes.
    if (Array.isArray(parsed)) {
      return { templates: decodeTemplates(parsed), dismissed: [] };
    }
    // v2 envelope: {v, templates, dismissed}.
    if (isRecord(parsed)) {
      if (parsed.v === 2 && Array.isArray(parsed.templates)) {
        return {
          templates: decodeTemplates(parsed.templates),
          dismissed: decodeDismissed(parsed.dismissed),
        };
      }
    }
    return emptyPayload();
  } catch {
    return emptyPayload();
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

// ── account-scoped slot CRUD ─────────────────────────────────────────

/**
 * Create / edit / copy-on-write a type in THIS account: envelope the
 * template's CONTENT (any stale rev/updatedAt/deleted bookkeeping on the
 * input is stripped) at nextRev(merged, id) with `updatedAt: now`, upserted
 * into MY slot. The same-id upsert covers all three flows — creating my own
 * type, editing it, and overriding a partner's type (copy-on-write: their
 * slot is untouched; my higher-rev copy wins the merge for both members).
 * Revs come from the MERGED view so the publish always lands above any
 * partner override of the same id (tombstones included — resurrect ABOVE).
 */
export function upsertMyTemplateSlot(
  mySlot: SharedTemplate[],
  merged: SharedTemplate[],
  t: TxnTemplate,
  now: number,
): SharedTemplate[] {
  const { rev: _rev, updatedAt: _up, deleted: _del, ...content } = t as SharedTemplate;
  return upsertSlot(mySlot, {
    ...(content as TxnTemplate),
    rev: nextRev(merged, t.id),
    updatedAt: now,
  });
}

/**
 * Delete a type from THIS account: drop the id from MY slot — absence, not
 * a tombstone. Removing my override of a partner's type resurfaces their
 * original via the merge; removing my own type removes it for both members.
 */
export function removeTemplateFromSlot(
  mySlot: SharedTemplate[],
  id: string,
): SharedTemplate[] {
  return mySlot.filter((t) => t.id !== id);
}

/**
 * De-duped union of two dismissed-id lists: a's insertion order first, then
 * b's ids not already present; capped at DISMISSED_CAP by dropping the
 * OLDEST (front). Pure and deterministic — both members converge on the
 * same union regardless of which slot each list came from.
 */
export function mergeDismissed(a: string[], b: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of [...a, ...b]) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out.slice(-DISMISSED_CAP);
}
