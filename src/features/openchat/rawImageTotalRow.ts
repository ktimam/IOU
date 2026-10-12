import { normalizeImageCurrencyToken } from "./currencyEvidencePolicy";
import { normalizeRawImageEvidence, type RawImageEvidenceCandidate } from "./rawImageEvidence";
import {
  RAW_IMAGE_DIRECTION_DETAIL_KEYS,
  RAW_IMAGE_LABEL_DETAIL_KEYS,
  RAW_IMAGE_SOURCE_DETAIL_KEYS,
  type RawImageDetailsFormat,
} from "./rawImageSourceDetails";

const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u;

function label(value: string): boolean {
  if (!/^[\p{L}\p{M}][\p{L}\p{M} '’\-]{0,63}:?$/u.test(value)) return false;
  // A trailing hyphen may be the amount's minus sign, even before its currency.
  // Reject that ambiguity instead of consuming the sign as label punctuation;
  // internal hyphenated words remain valid labels.
  if (/- *:?$/u.test(value)) return false;
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
 * The default carries no source details; explicit detail formats only forward their
 * exact validated fields for downstream app handling. Parsing does not prove source accuracy.
 */
function normalizeTotalRowFields(
  value: unknown,
  field: "total_row" | "total_text",
  detailsFormat: RawImageDetailsFormat,
): RawImageEvidenceCandidate | undefined {
  try {
    if (detailsFormat !== "none" && detailsFormat !== "source-v1" && detailsFormat !== "labels-v1" && detailsFormat !== "labels-v2" && detailsFormat !== "direction-v1") return undefined;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const detailKeys = detailsFormat === "source-v1"
      ? RAW_IMAGE_SOURCE_DETAIL_KEYS
      : detailsFormat === "labels-v1" || detailsFormat === "labels-v2"
        ? RAW_IMAGE_LABEL_DETAIL_KEYS
        : detailsFormat === "direction-v1" ? RAW_IMAGE_DIRECTION_DETAIL_KEYS : [];
    const keys = ["heading", field, "dates", "kind", ...detailKeys];
    if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some((key) =>
      !Object.hasOwn(descriptors, key) || !descriptors[key].enumerable ||
      !Object.hasOwn(descriptors[key], "value"))) return undefined;
    const total = monetaryValue(descriptors[field].value);
    if (total === undefined) return undefined;
    return normalizeRawImageEvidence(
      {
        heading: descriptors.heading.value,
        total_text: total,
        dates: descriptors.dates.value,
        kind: descriptors.kind.value,
        ...(detailsFormat === "source-v1" ? {
          direction_text: descriptors.direction_text.value,
          description_text: descriptors.description_text.value,
          type_texts: descriptors.type_texts.value,
        } : detailsFormat === "labels-v1" || detailsFormat === "labels-v2" ? {
          direction_text: descriptors.direction_text.value,
          type_texts: descriptors.type_texts.value,
        } : detailsFormat === "direction-v1" ? { direction_text: descriptors.direction_text.value } : {}),
      },
      "strict",
      detailsFormat,
    );
  } catch {
    return undefined;
  }
}

export function normalizeRawImageTotalRow(
  value: unknown,
  detailsFormat: RawImageDetailsFormat = "none",
): RawImageEvidenceCandidate | undefined {
  return normalizeTotalRowFields(value, "total_row", detailsFormat);
}

/** Same row grammar using the existing wire key, only for explicitly configured
 * app profiles. Keeping this separate avoids silently widening total_text's strict
 * default contract or forcing a key rename into a sensitive model prompt.
 */
export function normalizeRawImageTotalRowText(
  value: unknown,
  detailsFormat: RawImageDetailsFormat = "none",
): RawImageEvidenceCandidate | undefined {
  return normalizeTotalRowFields(value, "total_text", detailsFormat);
}
