import type { RawImageEvidenceCandidate } from "./rawImageEvidence";
import { normalizeRawImageTotalRowText } from "./rawImageTotalRow";

/** Inactive IOU-owned total-five-v1 representation: one object is one row,
 * { values: [heading, total_text, dates, kind, direction_text] }.
 * This only unpacks own JSON data into the existing total-row/direction-v1
 * validators. It does not activate a processor format, prove source accuracy,
 * expand multiple rows, repair fields or supply missing source evidence.
 * Whole-output parsing (including duplicate JSON keys) remains the caller's duty.
 */
export function normalizeRawImageTotalValuesRow(value: unknown): RawImageEvidenceCandidate | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined;
    const properties = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(properties).length !== 1 || !Object.hasOwn(properties, "values")) return undefined;
    const descriptor = properties.values;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) return undefined;
    const row: unknown = descriptor.value;
    if (!Array.isArray(row) || Object.getPrototypeOf(row) !== Array.prototype) return undefined;
    const slots = Object.getOwnPropertyDescriptors(row as object);
    if (slots.length?.value !== 5 || Reflect.ownKeys(slots).length !== 6) return undefined;
    const values: unknown[] = [];
    for (let index = 0; index < 5; index++) {
      const slot = slots[String(index)];
      if (slot === undefined || !slot.enumerable || !Object.hasOwn(slot, "value")) return undefined;
      if (index === 2 ? !Array.isArray(slot.value)
        : typeof slot.value !== "string" && !(index === 4 && slot.value === null)) return undefined;
      values.push(slot.value);
    }
    // The existing decoder owns complete money/date/range/direction validation,
    // including the nested date array's own-data boundary and null absence rule.
    return normalizeRawImageTotalRowText({
      heading: values[0], total_text: values[1], dates: values[2],
      kind: values[3], direction_text: values[4],
    }, "direction-v1");
  } catch {
    return undefined;
  }
}
