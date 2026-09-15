import { normalizeImageCurrencyToken } from "./currencyEvidencePolicy";
import { normalizeRawImageEvidence, type RawImageEvidenceCandidate } from "./rawImageEvidence";

const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u;

function label(value: string): boolean {
  if (!/^[\p{L}\p{M}][\p{L}\p{M} '’\-]{0,63}:?$/u.test(value)) return false;
  // A second currency cannot disappear into a label. No document/label vocabulary.
  return !(value.match(/[\p{L}\p{M}]+/gu) ?? []).some((word) =>
    normalizeImageCurrencyToken(word) !== undefined);
}

/** One whole row: optional alphabetic label, one amount, at most one printed unit.
 * Without a unit, a nonempty label must end in ':', so unknown unit words cannot
 * silently turn into a currency-free amount. All numeric validation stays shared.
 */
function monetaryValue(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 192 || UNSAFE.test(value)) return undefined;
  const row = value.trim().replace(/\p{Zs}+/gu, " ");
  const match = /^([^0-9]*)([0-9][0-9,]*(?:\.[0-9]{1,2})?)([^0-9]*)$/u.exec(row);
  if (!match) return undefined;
  const before = match[1].trim(), number = match[2], after = match[3].trim();
  if (after !== "") {
    if (normalizeImageCurrencyToken(after) === undefined || (before !== "" && !label(before))) return undefined;
    return `${number} ${after}`;
  }
  if (before === "") return number;
  // Only a complete terminal currency token may follow a bounded label. No search
  // for numeric fragments, no removal of symbols, no OCR aliases or model defaults.
  for (let index = Math.max(0, before.length - 16); index < before.length; index++) {
    if (index !== 0 && !/[ :]/u.test(before[index - 1])) continue;
    const token = before.slice(index), prefix = before.slice(0, index).trim();
    if (normalizeImageCurrencyToken(token) !== undefined && (prefix === "" || label(prefix)))
      return `${token} ${number}`;
  }
  return before.endsWith(":") && label(before) ? number : undefined;
}

/** Explicit IOU-owned total_row wire format. Does not accept/relax total_text.
 * Transcription accuracy is a model acceptance requirement, not established by
 * parsing. Private types, direction, canonical dates and cards remain downstream.
 */
function normalizeTotalRowFields(value: unknown, field: "total_row" | "total_text"): RawImageEvidenceCandidate | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = ["heading", field, "dates", "kind"];
    if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some((key) =>
      !Object.hasOwn(descriptors, key) || !descriptors[key].enumerable ||
      !Object.hasOwn(descriptors[key], "value"))) return undefined;
    const total = monetaryValue(descriptors[field].value);
    if (total === undefined) return undefined;
    return normalizeRawImageEvidence({
      heading: descriptors.heading.value,
      total_text: total,
      dates: descriptors.dates.value,
      kind: descriptors.kind.value,
    });
  } catch {
    return undefined;
  }
}

export function normalizeRawImageTotalRow(value: unknown): RawImageEvidenceCandidate | undefined {
  return normalizeTotalRowFields(value, "total_row");
}

/** Same row grammar using the existing wire key, only for explicitly configured
 * app profiles. Keeping this separate avoids silently widening total_text's strict
 * default contract or forcing a key rename into a sensitive model prompt.
 */
export function normalizeRawImageTotalRowText(value: unknown): RawImageEvidenceCandidate | undefined {
  return normalizeTotalRowFields(value, "total_text");
}
