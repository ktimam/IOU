export type RawImageFactualGrade = Readonly<{
  passed: boolean;
  issues: readonly string[];
}>;

const MAX_RAW_JSON_CHARS = 65_536;

type Container =
  | { kind: "array" }
  | { kind: "object"; keys: Set<string> };

function hasUniqueObjectKeys(text: string): boolean {
  const stack: Container[] = [];
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === "{") {
      stack.push({ kind: "object", keys: new Set() });
    } else if (character === "[") {
      stack.push({ kind: "array" });
    } else if (character === "}" || character === "]") {
      const expected = character === "}" ? "object" : "array";
      if (stack.pop()?.kind !== expected) return false;
    } else if (character === '"') {
      const start = index;
      for (index++; index < text.length; index++) {
        if (text[index] === "\\") index++;
        else if (text[index] === '"') break;
      }
      if (index >= text.length) return false;
      let next = index + 1;
      while (/\s/u.test(text[next] ?? "")) next++;
      const container = stack.at(-1);
      if (container?.kind === "object" && text[next] === ":") {
        const key = JSON.parse(text.slice(start, index + 1)) as string;
        if (container.keys.has(key)) return false;
        container.keys.add(key);
      }
    }
  }
  return stack.length === 0;
}

function isAuthoredJsonValue(value: unknown, seen: Set<object>): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  )
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;

  seen.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return false;
      const length = descriptors.length?.value;
      if (
        typeof length !== "number" ||
        !Number.isInteger(length) ||
        length < 0 ||
        keys.length !== length + 1
      )
        return false;
      for (let index = 0; index < length; index++) {
        const descriptor = descriptors[String(index)];
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !Object.hasOwn(descriptor, "value") ||
          !isAuthoredJsonValue(descriptor.value, seen)
        )
          return false;
      }
      return true;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    for (const key of keys) {
      if (typeof key !== "string") return false;
      const descriptor = descriptors[key];
      if (
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value") ||
        !isAuthoredJsonValue(descriptor.value, seen)
      )
        return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    seen.delete(value);
  }
}

function valueKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function childPath(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

function compareExact(
  observed: unknown,
  expected: unknown,
  path: string,
  issues: string[],
): void {
  if (Object.is(observed, expected)) return;
  if (valueKind(observed) !== valueKind(expected)) {
    issues.push(`${path}:type`);
    return;
  }
  if (Array.isArray(observed) && Array.isArray(expected)) {
    if (observed.length !== expected.length)
      issues.push(`${path}:array-length`);
    for (let index = 0; index < Math.min(observed.length, expected.length); index++)
      compareExact(observed[index], expected[index], `${path}[${index}]`, issues);
    return;
  }
  if (
    observed !== null &&
    expected !== null &&
    typeof observed === "object" &&
    typeof expected === "object"
  ) {
    const observedRecord = observed as Record<string, unknown>;
    const expectedRecord = expected as Record<string, unknown>;
    const observedKeys = Object.keys(observedRecord);
    const expectedKeys = Object.keys(expectedRecord);
    for (const key of expectedKeys) {
      if (!Object.hasOwn(observedRecord, key))
        issues.push(`${childPath(path, key)}:missing-field`);
      else
        compareExact(
          observedRecord[key],
          expectedRecord[key],
          childPath(path, key),
          issues,
        );
    }
    if (observedKeys.some((key) => !Object.hasOwn(expectedRecord, key)))
      issues.push(`${path}:unexpected-field`);
    return;
  }
  issues.push(`${path}:value`);
}

/**
 * Grade one whole raw model response against an independently authored factual
 * expectation. JSON is parsed once, without fence removal, trimming, value
 * repair or evidence filtering. Object key order is immaterial; field names,
 * array cardinality/order and every primitive value are exact.
 */
export function gradeExactRawImageFacts(
  rawText: string,
  authoredExpected: unknown,
): RawImageFactualGrade {
  if (!isAuthoredJsonValue(authoredExpected, new Set()))
    throw new TypeError("Invalid authored raw-image factual expectation");
  if (typeof rawText !== "string" || rawText.length > MAX_RAW_JSON_CHARS)
    return { passed: false, issues: ["$:invalid-json"] };

  let observed: unknown;
  try {
    observed = JSON.parse(rawText);
  } catch {
    return { passed: false, issues: ["$:invalid-json"] };
  }
  if (!hasUniqueObjectKeys(rawText))
    return { passed: false, issues: ["$:duplicate-key"] };

  const issues: string[] = [];
  compareExact(observed, authoredExpected, "$", issues);
  return { passed: issues.length === 0, issues };
}
