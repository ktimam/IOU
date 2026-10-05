import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createIouLocalAppPackage } from "./localAppPackage";
import { createLocalProcessorContext, parseLocalProcessorContext } from "./localProcessorContext";
import { iouActionManifest } from "./actionManifest";
import { DIRECTION_LABELS } from "../entries/directionLabels";
import { orderedCurrencies } from "../settings/currencies";
import { parseLocalImportPayload } from "./localImportHandoff";

const destination = "http://localhost:3000/openchat/import";
const processor = { sha256: "a".repeat(64), byteLength: 1234 };
const types = [
  { id: "private-credit", name: "Private credit", keywords: ["alpha"], direction: "credit" as const, txn_type: "iou" as const, fee_percent: 50 },
  { id: "private-debt", name: "Private debt", keywords: ["beta"], direction: "debt" as const, txn_type: "settlement" as const },
];
const presentation = { version: 1, enumLabels: [
  { field: "kind", options: [{ value: "iou", label: "IOU" }, { value: "settlement", label: "Settlement" }] },
  { field: "direction", options: [{ value: "credit", label: "Owed to you" }, { value: "debt", label: "You owe" }] },
] };

describe("checked-in public IOU package freshness", () => {
  // Explicit staging verification only; normal/CI runs still check canonical
  // public bytes. Never skip the complete source freshness/hash assertions.
  const directory = process.env.IOU_LOCAL_APP_TEST_ARTIFACT_DIRECTORY;
  const artifact = (name: string) => readFileSync(directory ? resolve(directory, name)
    : new URL(`../../../public/openchat/${name}`, import.meta.url));
  const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

  it("exports the current producer contract, not just an internally consistent older catalog", () => {
    const catalog = JSON.parse(artifact("local-app-v1.json").toString("utf8"));
    const metadata = JSON.parse(artifact("local-processor-v1.sha256.json").toString("utf8"));
    expect(catalog.apps).toHaveLength(1);
    const expected = createIouLocalAppPackage(catalog.apps[0].destination, metadata);
    // Compare the whole source-produced recipe: stale card rows/schema must fail even when
    // their old public-file digests still agree. Private setup is never included here.
    expect(catalog).toEqual(expected);
  });

  it("binds the public directory and setup metadata to the exact exported bytes", () => {
    const catalogBytes = artifact("local-app-v1.json");
    const processorBytes = artifact("local-processor-v1.js");
    const catalog = JSON.parse(catalogBytes.toString("utf8"));
    const directory = JSON.parse(artifact("apps-v1.json").toString("utf8"));
    const metadata = JSON.parse(artifact("local-processor-v1.sha256.json").toString("utf8"));
    const app = catalog.apps[0];
    const processorIdentity = { sha256: digest(processorBytes), byteLength: processorBytes.byteLength };
    expect(metadata).toEqual({ version: 1, ...processorIdentity, protocol: "oc:local-process:request" });
    expect(app.processor).toEqual(processorIdentity);
    expect(directory).toEqual({ version: 1, apps: [{
      id: app.id, name: app.name, description: app.description, revision: app.revision,
      catalog: { url: "/openchat/local-app-v1.json", sha256: digest(catalogBytes), byteLength: catalogBytes.byteLength },
      processor: { url: "/openchat/local-processor-v1.js", ...processorIdentity },
      setupUrl: "/openchat/connect",
    }] });
  });
});

describe("IOU-owned draft presentation", () => {
  it.each(["public", "private-empty", "private-types"] as const)("exports display-only labels for %s setup without changing scalar values or defaults", (setup) => {
    const privateSetup = setup === "public" ? undefined : {
      recipientLabel: "Synthetic sheet", processorContext: createLocalProcessorContext(setup === "private-types" ? types : [], "EGP"),
    };
    const action = createIouLocalAppPackage(destination, processor, privateSetup).apps[0].actions[0];
    expect(action.draftPresentation).toEqual({ ...presentation, controls: [
      { field: "currency", kind: "select", suggestions: orderedCurrencies(setup === "public" ? undefined : "EGP") },
      { field: "date", kind: "date" },
      { field: "note", kind: "multiline", fullWidth: true },
    ] });
    expect(action.definition.card.rows.map(row => row.valueKey)).toEqual(["amount", "currency", "direction", "kind", "typeId", "date", "note", "typeName"]);
    expect(action.definition.card.rows.find(row => row.valueKey === "typeId")?.label).toBe("Saved type");
    expect(action.definition.card.rows.find(row => row.valueKey === "typeName")?.label).toBe("Type name");
    for (const row of action.definition.card.rows) expect(action.definition.responseSchema.properties).toHaveProperty(row.valueKey);
    expect(action.draftPresentation.enumLabels[1].options).toEqual([
      { value: "credit", label: DIRECTION_LABELS.credit }, { value: "debt", label: DIRECTION_LABELS.debt },
    ]);
    expect(action.draftSchema.properties.entries.items.properties.kind).toEqual({ type: "string", enum: ["iou", "settlement"] });
    expect(action.draftSchema.properties.entries.items.properties.direction).toEqual({ type: "string", enum: ["credit", "debt"] });
    expect(action.definition.responseSchema.properties.kind).toMatchObject({ enum: ["settlement", "iou"], default: "iou",
      "x-openchat-require-explicit-for-image-only": true });
    expect(action.definition.responseSchema.properties.direction).toEqual({ type: "string", enum: ["credit", "debt"],
      default: "debt", "x-openchat-default-for-image-only": "credit" });
    expect(action.definition).not.toHaveProperty("draftPresentation");
    expect(action.draftSchema).not.toHaveProperty("draftPresentation");
    expect(action.processorContext ?? {}).not.toHaveProperty("draftPresentation");
    expect(action.definition.promptTemplate).toBe(iouActionManifest.prompt);
    for (const entry of action.draftPresentation.enumLabels) {
      expect(Object.keys(entry).sort()).toEqual(["field", "options"]);
      for (const option of entry.options) expect(Object.keys(option).sort()).toEqual(["label", "value"]);
    }
  });
  it("offers IOU's currency suggestions without converting the draft schema into an enum", () => {
    const action = createIouLocalAppPackage(destination, processor, {
      recipientLabel: "Synthetic sheet", processorContext: createLocalProcessorContext([], "ZZZ"),
    }).apps[0].actions[0];
    const suggestions = action.draftPresentation.controls[0].suggestions!;
    expect(suggestions[0]).toBe("ZZZ");
    expect(suggestions).toEqual(orderedCurrencies("ZZZ"));
    expect(new Set(suggestions).size).toBe(suggestions.length);
    expect(suggestions.length).toBeLessThanOrEqual(256);
    expect(action.draftSchema.properties.entries.items.properties.currency).toEqual({ type: "string", minLength: 3, maxLength: 3, pattern: "^[A-Z]{3}$" });
    expect(action.draftSchema.properties.entries.items.properties.date).toEqual({ type: "string", minLength: 10, maxLength: 10 });
    expect(action.draftSchema.properties.entries.items.properties.note).toEqual({ type: "string", maxLength: 4096 });
  });
  it("declares the recipient's uppercase currency boundary only for final review and retains unsuggested codes", () => {
    const action = createIouLocalAppPackage(destination, processor).apps[0].actions[0];
    const currencySchema = action.draftSchema.properties.entries.items.properties.currency;
    expect(currencySchema).toEqual({ type: "string", minLength: 3, maxLength: 3, pattern: "^[A-Z]{3}$" });
    expect(currencySchema).not.toHaveProperty("enum");
    expect(action.draftPresentation.controls[0]).toEqual({ field: "currency", kind: "select", suggestions: orderedCurrencies() });
    expect(action.draftPresentation.controls[0].suggestions).not.toContain("XXQ");
    const extractionProperties = iouActionManifest.outputSchema.properties as Record<string, Record<string, unknown>>;
    const { "x-openchat-require-text-evidence": _evidence, ...originalExtractionCurrency } = extractionProperties.currency;
    expect(action.definition.responseSchema.properties.currency).toEqual(originalExtractionCurrency);
    expect(action.definition.responseSchema.properties.currency).not.toHaveProperty("pattern");
    for (const [currency, accepted] of [
      ["USD", true], ["EGP", true], ["ZZZ", true], ["XXQ", true],
      ["usd", false], ["UsD", false], ["12A", false], ["A$B", false],
      ["ÅBC", false], ["ＵＳＤ", false], ["US", false], ["USDD", false],
      [" USD", false], ["USD ", false], ["USD\n", false], ["", false],
    ] as const) {
      const payload = { entries: [{ kind: "iou", amount: 1.23, currency, direction: "debt" }] };
      const before = JSON.stringify(payload);
      const parsed = parseLocalImportPayload(payload);
      expect(parsed !== undefined, JSON.stringify(currency)).toBe(accepted);
      if (accepted) expect(parsed?.entries[0].currency).toBe(currency);
      expect(JSON.stringify(payload)).toBe(before);
    }
  });
  it("retains the exact original model prompt bytes in the exported extraction contract", () => {
    const action = createIouLocalAppPackage(destination, processor).apps[0].actions[0];
    const profiles = action.definition.responseSchema["x-openchat-image-prompt-by-model"] as {
      version: number; templates: Record<string, { template: string; includeRuleGuidance: boolean; output: string }>;
    };
    expect(profiles.version).toBe(2);
    const expected = {
      "qwen3-vl-2b-instruct-q4": "2d73ebab0701a7adb4256072ef4625c30964b46766172bae05602bc72e045cc8",
      "gemma-4-e2b-it-q4": "a84d35c89fb8f3c91979a1954051769417109bb4f6785fea4fea3a3ad72048d8",
    };
    expect(Object.keys(profiles.templates).sort()).toEqual(Object.keys(expected).sort());
    for (const [id, sha256] of Object.entries(expected)) {
      expect(createHash("sha256").update(profiles.templates[id].template).digest("hex")).toBe(sha256);
      expect(profiles.templates[id]).toMatchObject({ includeRuleGuidance: false, output: "app" });
    }
  });
});

describe("IOU-owned named draft choices", () => {
  it("exports the exact private labels and IDs with only a direction default", () => {
    const context = createLocalProcessorContext(types, "EGP");
    const before = JSON.stringify(context);
    const action = createIouLocalAppPackage(destination, processor, { processorContext: context, recipientLabel: "Synthetic sheet" }).apps[0].actions[0];
    expect(action.draftEditor).toEqual({ version: 1, choices: [{ field: "typeId", label: "Saved type",
      noneLabel: "None — use reviewed fields only", options: types.map(type => ({ value: type.id, label: type.name,
        assign: [{ field: "typeName", value: type.name }], defaults: [{ field: "direction", value: type.direction }],
      })),
    }] });
    expect(action.processorContext).toEqual({ ...context, draftEditorDefaults: "host-v1" });
    expect(JSON.stringify(context)).toBe(before);
    expect(JSON.stringify(action.draftEditor)).not.toContain("kind");
    expect(JSON.stringify(action.processorContext)).not.toContain("fee");
    expect(action.definition).not.toHaveProperty("draftEditor");
    expect(action.definition.promptTemplate).not.toContain("Private credit");
    expect(action.definition.rules).toContainEqual({ kind: "keyword_map", field: "typeId", mode: "hint", map: [
      { value: "private-credit", keywords: ["Private credit", "alpha"] },
      { value: "private-debt", keywords: ["Private debt", "beta"] },
    ] });
  });
  it("keeps public exports unchanged and gives empty private rosters an explicit None-only selector", () => {
    const publicAction = createIouLocalAppPackage(destination, processor).apps[0].actions[0];
    expect(publicAction).not.toHaveProperty("draftEditor");
    expect(publicAction).not.toHaveProperty("processorContext");
    const context = { ...createLocalProcessorContext([], "EGP"), draftEditorDefaults: "host-v1" as const };
    const privateAction = createIouLocalAppPackage(destination, processor, { processorContext: context, recipientLabel: "Empty sheet" }).apps[0].actions[0];
    expect(privateAction.draftEditor).toEqual({ version: 1, choices: [{
      field: "typeId", label: "Saved type", noneLabel: "None — use reviewed fields only",
      options: [], companionFields: ["typeName"],
    }] });
    expect(privateAction.processorContext).toEqual({ version: 1, types: [], defaultCurrency: "EGP" });
    expect(privateAction.draftSchema).toEqual(publicAction.draftSchema);
    expect(privateAction.draftView).toEqual(publicAction.draftView);
    expect(privateAction.definition).toEqual(publicAction.definition);
    expect(privateAction.draftEditor?.choices[0]).not.toHaveProperty("defaults");
    expect(privateAction.draftEditor?.choices[0]).not.toHaveProperty("assign");
    expect(privateAction.draftEditor?.choices[0].options).toHaveLength(0);
    const payload = { entries: [{ amount: 1.23, currency: "EGP", kind: "iou", direction: "debt" }] };
    expect(parseLocalImportPayload(payload)?.entries[0]).not.toHaveProperty("typeId");
    expect(parseLocalImportPayload(payload)?.entries[0]).not.toHaveProperty("typeName");
  });
  it("rejects duplicate or hidden Type labels rather than emitting a host-invalid selector", () => {
    for (const name of [types[0].name, "None — use reviewed fields only", "Hidden\u200bname", "Hidden\u0085name"]) {
      const context = createLocalProcessorContext([types[0], { ...types[1], name }], "USD");
      expect(() => createIouLocalAppPackage(destination, processor, { processorContext: context, recipientLabel: "Synthetic sheet" })).toThrow(/unique, visible/);
    }
  });
  it("strictly accepts only the declared host-v1 context extension", () => {
    const context = createLocalProcessorContext(types, "USD");
    expect(context).not.toHaveProperty("draftEditorDefaults");
    const parsed = parseLocalProcessorContext({ ...context, draftEditorDefaults: "host-v1" });
    expect(parsed).toEqual({ ...context, draftEditorDefaults: "host-v1" });
    expect(Object.isFrozen(parsed)).toBe(true);
    for (const invalid of [undefined, null, false, 1, "host-v2", {}, []]) {
      expect(parseLocalProcessorContext({ ...context, draftEditorDefaults: invalid })).toBeUndefined();
    }
    expect(parseLocalProcessorContext({ ...context, draftEditorDefaults: "host-v1", surprise: true })).toBeUndefined();
  });
  it.each([32736, 32750])("validates the final paired context, including its added bytes (base %s)", (targetBytes) => {
    const roster = Array.from({ length: 15 }, (_, i) => ({ id: `type${i}`, name: `Type ${i}`,
      direction: "debt" as const, txn_type: "iou" as const, keywords: Array(32).fill("x".repeat(62)) as string[] }));
    const context = { version: 1 as const, defaultCurrency: "USD", types: roster };
    const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
    let bytes = byteLength(context);
    for (const type of roster) {
      for (let i = 0; i < 32 && bytes < targetBytes; i++) {
        const extra = Math.min(2, targetBytes - bytes);
        type.keywords[i] += "y".repeat(extra);
        bytes += extra;
      }
    }
    expect(byteLength(context)).toBe(targetBytes);
    expect(parseLocalProcessorContext(context)).toBeDefined();
    const withEditor = { ...context, draftEditorDefaults: "host-v1" as const };
    expect(byteLength(withEditor)).toBe(targetBytes + 32);
    const exportPackage = () => createIouLocalAppPackage(destination, processor, { processorContext: context, recipientLabel: "Synthetic sheet" });
    if (targetBytes + 32 > 32768) {
      expect(parseLocalProcessorContext(withEditor)).toBeUndefined();
      expect(exportPackage).toThrow(/context exceeds/);
    } else {
      const exported = exportPackage().apps[0].actions[0].processorContext;
      expect(exported).toEqual(withEditor);
      expect(parseLocalProcessorContext(exported)).toEqual(withEditor);
    }
  });
});
