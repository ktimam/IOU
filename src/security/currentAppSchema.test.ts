import { describe, expect, it } from "vitest";
import registration from "../../docs/openchat-registration.json";
import { assertCurrentAppResponseSchemas } from "../../scripts/live/current-app-schema";
import { buildManifestWire } from "../features/openchat/registerAiApp";

const actions = () => buildManifestWire("").actions as { name: string; response_schema: string }[];

describe("read-only current registration schema gate", () => {
  it("accepts the actual registrar schema, including configured model prompts", () => {
    const current = actions();
    const schema = JSON.parse(current[0].response_schema);
    expect(Object.keys(schema["x-openchat-image-prompt-by-model"].templates).length).toBeGreaterThan(0);
    expect(() => assertCurrentAppResponseSchemas(current)).not.toThrow();
  });

  it("accepts the synchronized shipped registration schema", () => {
    const documented = actions();
    documented[0].response_schema = JSON.stringify(registration.responseSchema);
    expect(() => assertCurrentAppResponseSchemas(documented)).not.toThrow();
  });

  it("rejects an explicitly stale documentation clone without current model configuration", () => {
    const stale = actions();
    const staleSchema: Record<string, unknown> = structuredClone(registration.responseSchema);
    delete staleSchema["x-openchat-image-prompt-by-model"];
    stale[0].response_schema = JSON.stringify(staleSchema);
    expect(() => assertCurrentAppResponseSchemas(stale)).toThrow("current registration contract");
  });

  it.each(["x-openchat-image-prompt-by-model", "x-openchat-image-prompt-template", "properties"])(
    "rejects a change to %s even when the rest of the registration is current",
    (field) => {
      const changed = actions();
      const schema = JSON.parse(changed[0].response_schema);
      delete schema[field];
      changed[0].response_schema = JSON.stringify(schema);
      expect(() => assertCurrentAppResponseSchemas(changed)).toThrow("current registration contract");
    },
  );

  it("rejects missing, duplicate, renamed actions and invalid JSON", () => {
    const current = actions();
    expect(() => assertCurrentAppResponseSchemas(undefined)).toThrow("must be an array");
    expect(() => assertCurrentAppResponseSchemas([null])).toThrow("must have a name");
    expect(() => assertCurrentAppResponseSchemas([])).toThrow();
    expect(() => assertCurrentAppResponseSchemas([...current, ...current])).toThrow();
    expect(() => assertCurrentAppResponseSchemas([{ ...current[0], name: "unexpected" }])).toThrow();
    expect(() => assertCurrentAppResponseSchemas([{ ...current[0], response_schema: "{" }])).toThrow("invalid JSON");
  });

  it("compares JSON structure independently of property serialization order", () => {
    const reordered = actions();
    const schema = JSON.parse(reordered[0].response_schema);
    reordered[0].response_schema = JSON.stringify(Object.fromEntries(Object.entries(schema).reverse()));
    expect(() => assertCurrentAppResponseSchemas(reordered)).not.toThrow();
  });
});
