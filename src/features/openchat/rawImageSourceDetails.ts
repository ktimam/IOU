import { DIRECTION_LABELS } from "../entries/directionLabels";
import type { Direction } from "../entries/types";

// labels-v2 shares labels-v1's wire shape; only the private artifact adapter adds
// distinct, configured-candidate-bearing Type evidence validation for v2.
export type RawImageDetailsFormat = "none" | "source-v1" | "labels-v1" | "labels-v2" | "direction-v1";

export const RAW_IMAGE_SOURCE_DETAIL_KEYS = [
  "direction_text",
  "description_text",
  "type_texts",
] as const;

export const RAW_IMAGE_LABEL_DETAIL_KEYS = ["direction_text", "type_texts"] as const;
export const RAW_IMAGE_DIRECTION_DETAIL_KEYS = ["direction_text"] as const;

const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u;
const MAX_DIRECTION_CHARS = 64;
const MAX_DESCRIPTION_CHARS = 800;
const MAX_TYPE_TEXTS = 4;
const MAX_TYPE_TEXT_CHARS = 160;

export type RawImageSourceDetails = Readonly<{
  direction?: Direction;
  description?: string;
  imageTypeTexts: string[];
}>;

function safeString(value: unknown, maxChars: number): value is string {
  return (
    typeof value === "string" &&
    value.length <= maxChars &&
    !UNSAFE_TEXT.test(value)
  );
}

/**
 * Validate bounded source text that may be used only by IOU's private, local
 * saved-Type matcher. Values remain separate and byte-for-byte unchanged; this
 * boundary never trims, joins, de-duplicates or consults a private roster.
 */
export function validateImageTypeTexts(value: unknown): string[] | undefined {
  try {
    if (
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype
    )
      return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
      string,
      PropertyDescriptor
    >;
    const length = descriptors.length?.value;
    if (
      typeof length !== "number" ||
      !Number.isInteger(length) ||
      length < 0 ||
      length > MAX_TYPE_TEXTS ||
      Reflect.ownKeys(descriptors).length !== length + 1
    )
      return undefined;
    const result: string[] = [];
    for (let index = 0; index < length; index++) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value") ||
        !safeString(descriptor.value, MAX_TYPE_TEXT_CHARS)
      )
        return undefined;
      result.push(descriptor.value);
    }
    return result;
  } catch {
    return undefined;
  }
}

/** Parse the three required `source-v1` fields after the caller has proved
 * they are own enumerable data properties of an exact-shape record. */
export function parseRawImageSourceDetails(
  directionText: unknown,
  descriptionText: unknown,
  typeTexts: unknown,
): RawImageSourceDetails | undefined {
  if (
    !safeString(directionText, MAX_DIRECTION_CHARS) ||
    !safeString(descriptionText, MAX_DESCRIPTION_CHARS)
  )
    return undefined;
  const imageTypeTexts = validateImageTypeTexts(typeTexts);
  if (imageTypeTexts === undefined) return undefined;

  const normalizedDirection = directionText.trim().toLocaleLowerCase("en-US");
  let direction: Direction | undefined;
  if (normalizedDirection !== "") {
    direction = (
      Object.entries(DIRECTION_LABELS) as [Direction, string][]
    ).find(
      ([, label]) => label.toLocaleLowerCase("en-US") === normalizedDirection,
    )?.[0];
    if (direction === undefined) return undefined;
  }

  return {
    ...(direction === undefined ? {} : { direction }),
    ...(descriptionText.trim() === "" ? {} : { description: descriptionText }),
    imageTypeTexts,
  };
}
