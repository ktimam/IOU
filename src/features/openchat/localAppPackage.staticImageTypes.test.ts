import { describe, expect, it, vi } from "vitest";

const { STATIC_TEMPLATES } = vi.hoisted(() => ({
  STATIC_TEMPLATES: {
    "qwen3-vl-2b-instruct-q4": "Static Qwen labels-v1 prompt with no private-Type marker.",
    "gemma-4-e2b-it-q4": "Static Gemma labels-v1 prompt with no private-Type marker.",
  } as const,
}));

vi.mock("./modelImageProfiles", async () => {
  const actual = await vi.importActual<typeof import("./modelImageProfiles")>("./modelImageProfiles");
  const validated = actual.readIouModelImageProfiles({
    schemaVersion: 1,
    processorOptions: {
      rawImageMoneyFormat: "total-row",
      rawImageDetailsFormat: "labels-v1",
    },
    templates: Object.fromEntries(Object.entries(STATIC_TEMPLATES).map(([id, template]) => [
      id,
      { template, includeRuleGuidance: false, output: "app" },
    ])),
  });
  return {
    ...actual,
    iouImageProcessorOptions: validated.processorOptions,
    iouImagePromptByModel: validated.promptExtension,
  };
});

import { createIouLocalAppPackage } from "./localAppPackage";
import { parseLocalProcessorContext } from "./localProcessorContext";
import type { ValidatedImagePromptExtension } from "./imageTypePrompt";

const destination = "http://localhost:3000/openchat/import";
const processor = { sha256: "a".repeat(64), byteLength: 1234 };
const emptyContext = parseLocalProcessorContext({ version: 1, types: [] })!;
const populatedContext = parseLocalProcessorContext({ version: 1, types: [{
  id: "private-static-type",
  name: "Private static label",
  keywords: ["PRIVATE STATIC KEYWORD"],
  direction: "debt",
  txn_type: "iou",
}] })!;

function action(privateContext?: typeof emptyContext) {
  return createIouLocalAppPackage(destination, processor, privateContext === undefined ? undefined : {
    recipientLabel: "Synthetic recipient",
    processorContext: privateContext,
  }).apps[0].actions[0];
}

function bytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function promptExtension(value: ReturnType<typeof action>): ValidatedImagePromptExtension {
  return value.definition.responseSchema["x-openchat-image-prompt-by-model"] as ValidatedImagePromptExtension;
}

describe("static labels-v1 package compatibility", () => {
  it("keeps public, empty-private, and populated-private definitions identical except declared rules", () => {
    const publicAction = action();
    const emptyPrivateAction = action(emptyContext);
    const populatedPrivateAction = action(populatedContext);
    const { rules: publicRules, ...publicDefinition } = publicAction.definition;
    const { rules: emptyRules, ...emptyDefinition } = emptyPrivateAction.definition;
    const { rules: populatedRules, ...populatedDefinition } = populatedPrivateAction.definition;

    expect(emptyDefinition).toEqual(publicDefinition);
    expect(populatedDefinition).toEqual(publicDefinition);
    expect(emptyRules).toEqual(publicRules);
    expect(populatedRules).toEqual(expect.arrayContaining(publicRules));
    expect(populatedRules).toHaveLength(publicRules.length + 1);
    expect(bytes(emptyPrivateAction.definition.responseSchema))
      .toEqual(bytes(publicAction.definition.responseSchema));
    expect(bytes(populatedPrivateAction.definition.responseSchema))
      .toEqual(bytes(publicAction.definition.responseSchema));
    expect(bytes(promptExtension(emptyPrivateAction))).toEqual(bytes(promptExtension(publicAction)));
    expect(bytes(promptExtension(populatedPrivateAction))).toEqual(bytes(promptExtension(publicAction)));

    for (const [id, template] of Object.entries(STATIC_TEMPLATES)) {
      expect(promptExtension(populatedPrivateAction).templates[id].template).toBe(template);
    }
    expect(JSON.stringify(promptExtension(populatedPrivateAction))).not.toContain("Private static label");
    expect(JSON.stringify(promptExtension(populatedPrivateAction))).not.toContain("PRIVATE STATIC KEYWORD");
    expect(JSON.stringify(promptExtension(populatedPrivateAction))).not.toContain("private-static-type");
    expect(populatedPrivateAction.processorContext?.types).toEqual(populatedContext.types);
    expect(populatedPrivateAction.draftEditor?.choices[0].options[0]).toMatchObject({
      value: "private-static-type",
      label: "Private static label",
      defaults: [{ field: "direction", value: "debt" }],
    });
  });

  it("does not leak a populated private export into repeated public or empty-private exports", () => {
    const publicBefore = action();
    action(populatedContext);
    const emptyPrivate = action(emptyContext);
    action(populatedContext);
    const publicAfter = action();

    expect(bytes(publicAfter.definition)).toEqual(bytes(publicBefore.definition));
    expect(bytes(emptyPrivate.definition)).toEqual(bytes(publicBefore.definition));
    expect(JSON.stringify(publicAfter)).not.toContain("Private static label");
    expect(JSON.stringify(emptyPrivate)).not.toContain("Private static label");
    expect(JSON.stringify(publicAfter)).not.toContain("PRIVATE STATIC KEYWORD");
    expect(JSON.stringify(emptyPrivate)).not.toContain("PRIVATE STATIC KEYWORD");
  });
});
