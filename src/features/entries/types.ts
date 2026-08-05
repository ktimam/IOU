// Plaintext entry shape (stored encrypted in the canister).
//
// v1 keeps the payload small. The timestamp is client-side. The
// canister stamps created_at_server / updated_at_server separately.
//
// Convert is optional: when present, the entry represents a credit
// or debt that originated in a different currency and was recorded
// here as a converted amount.

export type Direction = "credit" | "debt";
// "credit" = the OTHER member owes me.
// "debt"   = I owe the OTHER member.

export type ConvertPayload = {
  from_currency: string;
  from_amount_minor: number;
  to_currency: string;
  to_amount_minor: number;
  rate: number;        // from -> to
  rate_source: string; // e.g. "frankfurter.app"
  rate_fetched_at: number; // ms epoch
};

// Transaction type:
//   "settlement" = an actual money transfer. Matures instantly (no due
//                  date) and nets the balance immediately.
//   "iou"        = a debt that comes due on one or more dates. Each
//                  portion of the amount matures on its own due date.
// Absent ⇒ treat as a single-portion "iou" due at `ts` (back-compat for
// entries written before this field existed).
export type TxnType = "settlement" | "iou";

// One slice of an IOU's amount, due on a specific date. `percent` values
// across an entry's schedule must sum to 100.
export type DuePortion = {
  due_ts: number; // ms epoch this portion is due
  percent: number; // 0..100
};

// Fee/deduction on an IOU. The IOU's face value is `gross_amount_minor`;
// a `percent` of it AND a `fixed_minor` amount are deducted, and the
// entry's `amount_minor` is the NET (what counts toward the balance and is
// split across the due schedule). Either component may be zero.
// e.g. gross 1000, percent 20, fixed 0 ⇒ net 800; gross 5000, percent 20,
// fixed 1000 ⇒ net 3000.
//
// `fixed_currency`: the fixed fee may be charged in a DIFFERENT currency than the
// entry. When it is, the fixed fee cannot net against the entry's amount — it
// becomes a separate balance line in `fixed_currency` (opposite direction, i.e. a
// deduction) that totals with other entries of that currency, and `amount_minor`
// is then only the percent-net (gross − percent%). The `percent` fee always
// deducts from the entry currency. Absent/equal-to-entry ⇒ classic same-currency
// behaviour (both components fold into `amount_minor`).
export type FeePayload = {
  percent: number; // 0..100 of the gross
  fixed_minor?: number; // flat fee amount; absent ⇒ 0
  fixed_currency?: string; // currency of `fixed_minor` when it differs from the entry; absent ⇒ entry currency
  gross_amount_minor: number; // face value before the fee
};

export type EntryPayload = {
  ts: number;             // ms epoch
  kind: "expense" | "payment";
  currency: string;
  amount_minor: number;
  direction: Direction;
  note: string;
  txn_type?: TxnType;       // settlement | iou (default iou when absent)
  schedule?: DuePortion[];  // IOU split across due dates; absent ⇒ one portion due at `ts`
  fee?: FeePayload;         // IOU fee/deduction; amount_minor is the net (post-fee)
  convert?: ConvertPayload; // present iff this entry is a conversion
  // Optional idempotency key for entries created from an imported "draft"
  // (e.g. an AI-extracted transfer screenshot via the chat bridge). Stable per
  // draft, so the same draft imported twice maps to one entry. Absent for
  // manually-entered entries. See src/features/entries/draft.ts.
  draft_id?: string;
  // OpenChat context.messageId of the confirmable-action card this entry was
  // imported from. The fan-out deposits one envelope PER member all carrying the
  // SAME messageId, so this is the CROSS-MEMBER "already imported" key: once any
  // member imports, every member's pending list hides the card by matching this
  // field on the sheet's decrypted entries (see openchat/inboxDedupe.ts
  // isImportedIntoSheet). Absent for manual/pasted entries and wrapper-less
  // (pre-v4) local legacy deposits.
  import_message_id?: string;
};

export function encodeEntry(p: EntryPayload): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(p));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteDate(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    Number.isFinite(new Date(value).getTime())
  );
}

function isMinorAmount(value: unknown, allowZero = true): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    (allowZero ? value >= 0 : value > 0)
  );
}

function isCurrency(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z]{3}$/.test(value);
}

export function decodeEntry(b: Uint8Array): EntryPayload {
  const value: unknown = JSON.parse(new TextDecoder().decode(b));
  if (!isRecord(value)) {
    throw new Error("invalid entry payload");
  }
  const p = value;
  if (
    !isFiniteDate(p.ts) ||
    (p.kind !== "expense" && p.kind !== "payment") ||
    !isCurrency(p.currency) ||
    !isMinorAmount(p.amount_minor, false) ||
    (p.direction !== "credit" && p.direction !== "debt") ||
    typeof p.note !== "string"
  ) {
    throw new Error("invalid entry payload");
  }
  if (
    p.txn_type !== undefined &&
    p.txn_type !== "settlement" &&
    p.txn_type !== "iou"
  ) {
    throw new Error("invalid entry transaction type");
  }
  if (p.schedule !== undefined) {
    if (
      p.txn_type === "settlement" ||
      !Array.isArray(p.schedule) ||
      p.schedule.length === 0 ||
      p.schedule.length > 100
    ) {
      throw new Error("invalid entry schedule");
    }
    let percentTotal = 0;
    for (const row of p.schedule) {
      if (
        !isRecord(row) ||
        !isFiniteDate(row.due_ts) ||
        typeof row.percent !== "number" ||
        !Number.isFinite(row.percent) ||
        row.percent < 0 ||
        row.percent > 100
      ) {
        throw new Error("invalid entry schedule");
      }
      percentTotal += row.percent;
    }
    if (percentTotal !== 100) {
      throw new Error("invalid entry schedule");
    }
  }
  if (p.fee !== undefined) {
    if (
      !isRecord(p.fee) ||
      typeof p.fee.percent !== "number" ||
      !Number.isFinite(p.fee.percent) ||
      p.fee.percent < 0 ||
      p.fee.percent > 100 ||
      !isMinorAmount(p.fee.gross_amount_minor, false) ||
      (p.fee.fixed_minor !== undefined &&
        !isMinorAmount(p.fee.fixed_minor)) ||
      (p.fee.fixed_currency !== undefined &&
        !isCurrency(p.fee.fixed_currency))
    ) {
      throw new Error("invalid entry fee");
    }
    const fixedMinor =
      p.fee.fixed_minor === undefined ? 0 : p.fee.fixed_minor;
    if (
      p.txn_type === "settlement" ||
      (p.fee.fixed_currency !== undefined && fixedMinor <= 0)
    ) {
      throw new Error("invalid entry fee");
    }
    const foreignFixed =
      p.fee.fixed_currency !== undefined &&
      p.fee.fixed_currency.toUpperCase() !==
        (p.currency as string).toUpperCase();
    const expectedNet = Math.max(
      0,
      p.fee.gross_amount_minor -
        Math.round(
          (p.fee.gross_amount_minor * p.fee.percent) / 100,
        ) -
        (foreignFixed ? 0 : fixedMinor),
    );
    if (
      !Number.isSafeInteger(expectedNet) ||
      p.amount_minor !== expectedNet
    ) {
      throw new Error("invalid entry fee");
    }
  }
  if (p.convert != null) {
    if (
      !isRecord(p.convert) ||
      !isCurrency(p.convert.from_currency) ||
      !isMinorAmount(p.convert.from_amount_minor, false) ||
      !isCurrency(p.convert.to_currency) ||
      !isMinorAmount(p.convert.to_amount_minor, false) ||
      typeof p.convert.rate !== "number" ||
      !Number.isFinite(p.convert.rate) ||
      p.convert.rate <= 0 ||
      typeof p.convert.rate_source !== "string" ||
      !isFiniteDate(p.convert.rate_fetched_at)
    ) {
      throw new Error("invalid entry conversion");
    }
  }
  if (p.draft_id != null && typeof p.draft_id !== "string") {
    throw new Error("invalid entry draft id");
  }
  if (p.import_message_id != null && typeof p.import_message_id !== "string") {
    throw new Error("invalid entry message id");
  }
  return value as EntryPayload;
}
