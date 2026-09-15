import { isDeepStrictEqual } from "node:util";
import { buildManifestWire } from "../../src/features/openchat/registerAiApp";

function readActions(value: unknown): { name: string; response_schema: string }[] {
  if (!Array.isArray(value)) throw new Error("IOU registration actions must be an array");
  return value.map((action: unknown) => {
    if (action === null || typeof action !== "object" ||
        !("name" in action) || typeof action.name !== "string" ||
        !("response_schema" in action) || typeof action.response_schema !== "string") {
      throw new Error("IOU registration action must have a name and response schema");
    }
    return { name: action.name, response_schema: action.response_schema };
  });
}

/** Use the registrar's source, not the older copy/paste documentation snapshot. No network calls. */
export function assertCurrentAppResponseSchemas(value: unknown): void {
  const actions = readActions(value);
  const expected = readActions(buildManifestWire("").actions);
  if (actions.length !== expected.length) {
    throw new Error("published IOU actions do not match the current registration contract");
  }
  for (const action of expected) {
    const matches = actions.filter((candidate) => candidate.name === action.name);
    if (matches.length !== 1) {
      throw new Error("published IOU actions do not match the current registration contract");
    }
    let liveSchema: unknown;
    try {
      liveSchema = JSON.parse(matches[0].response_schema);
    } catch {
      throw new Error("published IOU response schema is invalid JSON");
    }
    if (!isDeepStrictEqual(liveSchema, JSON.parse(action.response_schema))) {
      throw new Error("published IOU response schema does not match the current registration contract");
    }
  }
}
