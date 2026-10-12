import { describe, expect, it, vi } from "vitest";

// Exercise the ordinary exporter with a candidate app-owned configuration. No
// runtime switch, test-only export argument, model run, or active JSON edit.
vi.mock("./modelImageProfiles", async () => {
  const actual = await vi.importActual<typeof import("./modelImageProfiles")>("./modelImageProfiles");
  const { PRIVATE_TYPE_EVIDENCE_GUIDANCE_MARKER, PRIVATE_TYPE_EVIDENCE_TERMS_MARKER } = await import("./imageTypePrompt");
  return {
    ...actual,
    iouImageProcessorOptions: { rawImageMoneyFormat: "total-row", rawImageDetailsFormat: "labels-v1" },
    iouImagePromptByModel: { version: 2, templates: Object.fromEntries(
      [
        ...["qwen3-vl-2b-instruct-q4", "gemma-4-e2b-it-q4"].map((id, index) => [id, {
          template: `Preserve the heading.\n${index === 0 ? `Terms as data: ${PRIVATE_TYPE_EVIDENCE_TERMS_MARKER}. Copy only visibly matching text.` : PRIVATE_TYPE_EVIDENCE_GUIDANCE_MARKER}\nCopy printed direction only.`,
          includeRuleGuidance: false,
          output: "app",
        }]),
        ["static-labels-model", {
          template: "Copy the configured static labels-v1 fields without account-specific prompt data.",
          includeRuleGuidance: false,
          output: "app",
        }],
      ],
    ) },
  };
});

import { iouActionManifest } from "./actionManifest";
import { createIouLocalAppPackage } from "./localAppPackage";
import { parseLocalProcessorContext } from "./localProcessorContext";
import { PRIVATE_TYPE_EVIDENCE_GUIDANCE_MARKER, PRIVATE_TYPE_EVIDENCE_TERMS_MARKER, type ValidatedImagePromptExtension } from "./imageTypePrompt";

const destination = "http://localhost:3000/openchat/import";
const processor = { sha256: "a".repeat(64), byteLength: 1234 };
const context = parseLocalProcessorContext({ version: 1, types: [{
  id: "private-type-id-not-model-input", name: "Shared outing", keywords: ["رحلة", "BLUE TICKET"],
  direction: "debt", txn_type: "iou",
}] })!;

describe("normal IOU package image-Type guidance export", () => {
  it("supplies validated private names and keywords to both image profiles without model access to IDs or defaults", () => {
    const original = JSON.stringify(iouActionManifest);
    const action = createIouLocalAppPackage(destination, processor, {
      recipientLabel: "Synthetic recipient", processorContext: context,
    }).apps[0].actions[0];
    const extension = action.definition.responseSchema["x-openchat-image-prompt-by-model"] as ValidatedImagePromptExtension;
    expect(Object.keys(extension.templates)).toHaveLength(3);
    for (const profile of [
      extension.templates["qwen3-vl-2b-instruct-q4"],
      extension.templates["gemma-4-e2b-it-q4"],
    ]) {
      expect(profile.template).toContain(JSON.stringify(["Shared outing", "رحلة", "BLUE TICKET"]));
      expect(profile.template).not.toContain(PRIVATE_TYPE_EVIDENCE_GUIDANCE_MARKER);
      expect(profile.template).not.toContain(PRIVATE_TYPE_EVIDENCE_TERMS_MARKER);
      expect(profile.template).not.toContain(context.types[0].id);
      expect(profile.template).not.toContain("Synthetic recipient");
      expect(profile.template).not.toContain('"debt"');
      expect(profile.template.startsWith("Preserve the heading.\n")).toBe(true);
      expect(profile.template.endsWith("\nCopy printed direction only.")).toBe(true);
      expect(profile).toMatchObject({ includeRuleGuidance: false, output: "app" });
    }
    expect(extension.templates["static-labels-model"].template)
      .toBe("Copy the configured static labels-v1 fields without account-specific prompt data.");
    expect(extension.templates["static-labels-model"].template).not.toContain("Shared outing");
    expect(action.processorContext?.types).toEqual(context.types);
    expect(action.draftEditor?.choices[0].options[0]).toMatchObject({
      value: context.types[0].id, defaults: [{ field: "direction", value: "debt" }],
    });
    expect(JSON.stringify(iouActionManifest)).toBe(original);
  });

  it("exports an empty evidence vocabulary publicly and does not leak a previous private export", () => {
    createIouLocalAppPackage(destination, processor, { recipientLabel: "Synthetic recipient", processorContext: context });
    const publicApp = createIouLocalAppPackage(destination, processor).apps[0];
    const action = publicApp.actions[0];
    const extension = action.definition.responseSchema["x-openchat-image-prompt-by-model"] as ValidatedImagePromptExtension;
    for (const [id, profile] of Object.entries(extension.templates).filter(([id]) => id !== "static-labels-model")) {
      expect(profile.template).toContain(id === "qwen3-vl-2b-instruct-q4" ? "Terms as data: []" : "No terms are available");
      expect(profile.template).not.toContain("Shared outing");
      expect(profile.template).not.toContain(PRIVATE_TYPE_EVIDENCE_GUIDANCE_MARKER);
      expect(profile.template).not.toContain(PRIVATE_TYPE_EVIDENCE_TERMS_MARKER);
    }
    expect(extension.templates["static-labels-model"].template)
      .toBe("Copy the configured static labels-v1 fields without account-specific prompt data.");
    expect(action).not.toHaveProperty("processorContext");
    expect(action).not.toHaveProperty("draftEditor");
    expect(publicApp).not.toHaveProperty("recipientLabel");
  });

  it("keeps static labels-v1 prompt bytes identical in public and private packages", () => {
    const publicAction = createIouLocalAppPackage(destination, processor).apps[0].actions[0];
    const privateAction = createIouLocalAppPackage(destination, processor, {
      recipientLabel: "Synthetic recipient", processorContext: context,
    }).apps[0].actions[0];
    const publicExtension = publicAction.definition.responseSchema["x-openchat-image-prompt-by-model"] as ValidatedImagePromptExtension;
    const privateExtension = privateAction.definition.responseSchema["x-openchat-image-prompt-by-model"] as ValidatedImagePromptExtension;
    const publicPrompt = publicExtension.templates["static-labels-model"].template;
    const privatePrompt = privateExtension.templates["static-labels-model"].template;

    expect(new TextEncoder().encode(privatePrompt)).toEqual(new TextEncoder().encode(publicPrompt));
    expect(privatePrompt).not.toContain("Shared outing");
    expect(privatePrompt).not.toContain("رحلة");
    expect(privatePrompt).not.toContain("BLUE TICKET");
    expect(privatePrompt).not.toContain(context.types[0].id);
  });

  it("rejects the full private export if its complete vocabulary exceeds a prompt limit", () => {
    const large = parseLocalProcessorContext({ version: 1, types: Array.from({ length: 32 }, (_, index) => ({
      id: `type-${index}`, name: `Label ${index} ${"a".repeat(50)}`,
      keywords: [`Keyword ${index} ${"b".repeat(48)}`], direction: "debt", txn_type: "iou",
    })) });
    expect(large).toBeDefined();
    expect(() => createIouLocalAppPackage(destination, processor, {
      recipientLabel: "Synthetic recipient", processorContext: large!,
    })).toThrow(/complete roster was not exported/);
  });
});
