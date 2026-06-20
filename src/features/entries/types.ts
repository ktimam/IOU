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

export type EntryPayload = {
  ts: number;             // ms epoch
  kind: "expense" | "payment";
  currency: string;
  amount_minor: number;
  direction: Direction;
  note: string;
  txn_type?: TxnType;       // settlement | iou (default iou when absent)
  schedule?: DuePortion[];  // IOU split across due dates; absent ⇒ one portion due at `ts`
  convert?: ConvertPayload; // present iff this entry is a conversion
};

export function encodeEntry(p: EntryPayload): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(p));
}

export function decodeEntry(b: Uint8Array): EntryPayload {
  return JSON.parse(new TextDecoder().decode(b)) as EntryPayload;
}
