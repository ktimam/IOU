import { normalizeRawImageEvidence, type RawImageEvidenceCandidate } from "./rawImageEvidence";

/** IOU-owned opt-in wire representation: one object contains one six-slot row.
 * v1 only unpacks syntax; v2 additionally accepts the explicitly corroborated
 * repeated-unit grammar below. Row order and established semantic validators
 * are unchanged; no wrapper expansion, guessing or partial salvage.
 */
export type RawImageValuesRowFormat = "split-six-v1" | "split-six-v2";

export function normalizeRawImageValuesRow(
  value: unknown,
  format: RawImageValuesRowFormat = "split-six-v1",
): RawImageEvidenceCandidate | undefined {
  try {
    if (format !== "split-six-v1" && format !== "split-six-v2") return undefined;
    if (value === null || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined;
    const properties = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(properties).length !== 1 || !Object.hasOwn(properties, "values")) return undefined;
    const descriptor = properties.values;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) return undefined;
    const row: unknown = descriptor.value;
    if (!Array.isArray(row) || Object.getPrototypeOf(row) !== Array.prototype) return undefined;
    const slots = Object.getOwnPropertyDescriptors(row as object);
    if (slots.length?.value !== 6 || Reflect.ownKeys(slots).length !== 7) return undefined;
    const values: unknown[] = [];
    for (let index = 0; index < 6; index++) {
      const slot = slots[String(index)];
      if (slot === undefined || !slot.enumerable || !Object.hasOwn(slot, "value") ||
        (typeof slot.value !== "string" && !(index === 5 && slot.value === null))) return undefined;
      values.push(slot.value);
    }
    // v2 alone allows a redundantly printed unit, corroborated by literal token
    // equality with the separate currency slot. Remove only an exact prefix or
    // suffix plus one ASCII space, never trim/search/map equivalent units. The
    // unchanged shared split-money validator still owns currency recognition,
    // whole numeric grammar, grouping, precision and exact minor-unit bounds.
    let amount = values[2];
    const currency = values[1];
    if (format === "split-six-v2" && typeof amount === "string" &&
      typeof currency === "string" && currency !== "") {
      if (amount.length > 128) return undefined;
      const prefix = `${currency} `, suffix = ` ${currency}`;
      if (amount.startsWith(prefix)) amount = amount.slice(prefix.length);
      else if (amount.endsWith(suffix)) amount = amount.slice(0, -suffix.length);
    }
    return normalizeRawImageEvidence({
      note: values[0], currency_text: currency, amount_text: amount,
      date_text: values[3], kind: values[4], direction_text: values[5],
    }, "labeled-values", "direction-v1");
  } catch {
    return undefined;
  }
}
