import { IOU_MAX_MAJOR_AMOUNT, IOU_MIN_MAJOR_AMOUNT } from "./actionManifest";
import { normalizeImageCurrencyToken } from "./currencyEvidencePolicy";
import { validateImageHeading } from "./imageHeading";
import { dateFromPrintedDate, validatedSourceInterval } from "./sourceInterval";

/** Validated public image evidence, not a complete/private IOU draft or card. */
export type RawImageEvidenceCandidate = {
  amount: number;
  currency?: string;
  kind: "iou" | "settlement";
  printed_date?: string;
  printed_end_date?: string;
  note?: string;
  image_heading?: string;
};

const ARRAY_KEYS = ["heading", "total_text", "dates", "kind"];
const SCALAR_KEYS = ["note", "total_text", "date_text", "kind"];
const SPLIT_ARRAY_KEYS = ["heading", "currency_text", "amount_text", "dates", "kind"];
const SPLIT_SCALAR_KEYS = ["note", "currency_text", "amount_text", "date_text", "kind"];
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u;
const NUMBER = /^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d{1,2})?$/u;
export type RawImageDateTextFormat = "strict" | "labeled-values";

// Read only own data properties: callers must pass an already whole-parsed JSON object.
// Duplicate JSON keys cannot be diagnosed after parsing and remain the parser's duty.
function fields(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const expected = [ARRAY_KEYS, SCALAR_KEYS, SPLIT_ARRAY_KEYS, SPLIT_SCALAR_KEYS].find((shape) =>
    keys.length === shape.length && shape.every((key) => Object.hasOwn(descriptors, key)));
  if (expected === undefined) return undefined;
  const out: Record<string, unknown> = Object.create(null);
  for (const key of expected) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) return undefined;
    out[key] = descriptor.value;
  }
  return out;
}

function numericAmount(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length > 128 || UNSAFE_TEXT.test(value) || !NUMBER.test(value)) return undefined;
  const [integer, fraction = ""] = value.replaceAll(",", "").split(".");
  const minor = BigInt(integer) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  const amount = Number(minor) / 100;
  if (!Number.isFinite(amount) || amount < IOU_MIN_MAJOR_AMOUNT || amount > IOU_MAX_MAJOR_AMOUNT ||
    BigInt(Math.round(amount * 100)) !== minor) return undefined;
  return amount;
}

function money(value: unknown): { amount: number; currency?: string } | undefined {
  if (typeof value !== "string" || value.length > 128 || UNSAFE_TEXT.test(value)) return undefined;
  // This is a whole-field grammar, never a scan for a plausible number inside arbitrary text.
  const match = /^([^0-9]*)([0-9][0-9,]*(?:\.[0-9]{1,2})?)([^0-9]*)$/u.exec(value.trim());
  if (match === null) return undefined;
  const before = match[1].trim(), after = match[3].trim();
  if (before !== "" && after !== "") return undefined;
  const token = before || after;
  const currency = token === "" ? undefined : normalizeImageCurrencyToken(token);
  if (token !== "" && currency === undefined) return undefined;
  const amount = numericAmount(match[2]);
  return amount === undefined ? undefined : { amount, ...(currency === undefined ? {} : { currency }) };
}

function splitMoney(currencyValue: unknown, amountValue: unknown): { amount: number; currency?: string } | undefined {
  if (typeof currencyValue !== "string") return undefined;
  const currency = currencyValue === "" ? undefined : normalizeImageCurrencyToken(currencyValue);
  if (currencyValue !== "" && currency === undefined) return undefined;
  // Do not concatenate the fields or trim/scan amount_text: embedded units, labels and
  // partial numeric strings must not become valid through the combined-total grammar.
  const amount = numericAmount(amountValue);
  return amount === undefined ? undefined : { amount, ...(currency === undefined ? {} : { currency }) };
}

function dateValues(value: unknown, scalar: boolean, format: RawImageDateTextFormat): string[] | undefined {
  let values: unknown[];
  if (scalar) {
    if (typeof value !== "string" || value.length > 195) return undefined;
    values = value === "" ? [] : format === "strict" ? value.split(" | ") : value.split(/ (?:\||[-–—]) /u);
    if (format === "labeled-values") {
      // An opt-in app-owned wire grammar, not a search for dates in arbitrary text.
      // A bounded alphabetic label followed by ': ' may wrap one complete value.
      // No label vocabulary, endpoint completion, clock removal, or number repair.
      // The full resulting date/pair still has to pass the calendar checks below.
      if (values.length > 2) return undefined;
      values = values.map((item) => {
        if (typeof item !== "string" || item !== item.trim() || UNSAFE_TEXT.test(item)) return item;
        return /^[\p{L}\p{M}][\p{L}\p{M} _-]{0,31}: (.+)$/u.exec(item)?.[1] ?? item;
      });
    }
  } else {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value as object);
    const length: unknown = descriptors.length?.value;
    if (typeof length !== "number" || !Number.isInteger(length) || length < 0 || length > 2 ||
      Reflect.ownKeys(descriptors).length !== length + 1) return undefined;
    values = [];
    for (let index = 0; index < length; index++) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) return undefined;
      values.push(descriptor.value);
    }
  }
  if (values.length > 2 || values.some((item) => typeof item !== "string" || item === "" ||
    item.length > 96 || item !== item.trim() || UNSAFE_TEXT.test(item))) return undefined;
  return values as string[];
}

/**
 * Unwired IOU-owned adapter for exact four-field or split-money five-field formats. It does not
 * identify models, inspect pixels/OCR, prove faithful transcription, select private types,
 * infer direction, attach message text, hydrate a card, or activate a new manifest schema.
 * Any unsupported/malformed field rejects the whole candidate; no valid-field salvage.
 */
export function normalizeRawImageEvidence(
  value: unknown,
  dateTextFormat: RawImageDateTextFormat = "strict",
): RawImageEvidenceCandidate | undefined {
  try {
    if (dateTextFormat !== "strict" && dateTextFormat !== "labeled-values") return undefined;
    const raw = fields(value);
    if (raw === undefined || (raw.kind !== "iou" && raw.kind !== "settlement")) return undefined;
    const total = Object.hasOwn(raw, "total_text") ? money(raw.total_text) : splitMoney(raw.currency_text, raw.amount_text);
    if (total === undefined) return undefined;
    const scalar = Object.hasOwn(raw, "date_text");
    const dates = dateValues(scalar ? raw.date_text : raw.dates, scalar, dateTextFormat);
    if (dates === undefined) return undefined;
    // An invalid anchor deliberately prevents consulting today's year. We retain printed
    // endpoints only; the existing later app projection owns any justified canonical date.
    const unanchored = new Date(NaN);
    if (dates.length === 1 && dateFromPrintedDate(dates[0]) === undefined &&
      validatedSourceInterval(dates[0], dates[0], unanchored) === undefined) return undefined;
    if (dates.length === 2 && validatedSourceInterval(dates[0], dates[1], unanchored) === undefined) return undefined;
    const headingValue = scalar ? raw.note : raw.heading;
    if (typeof headingValue !== "string" || headingValue.length > 800 || UNSAFE_TEXT.test(headingValue)) return undefined;
    const heading = validateImageHeading(headingValue);
    if (heading === undefined && headingValue.trim() !== "") return undefined;
    return {
      ...total,
      kind: raw.kind,
      ...(dates.length === 0 ? {} : { printed_date: dates[0], printed_end_date: dates[1] ?? "" }),
      ...(heading === undefined ? {} : { note: heading, image_heading: heading }),
    };
  } catch {
    // Throwing proxy traps or malformed object descriptors must not escape this pure boundary.
    return undefined;
  }
}
