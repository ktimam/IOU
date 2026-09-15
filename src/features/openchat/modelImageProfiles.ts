import configuredProfiles from "./modelImageProfiles.json";
import type { IouProcessorOptions } from "./localProcessorBridge";

type PromptProfile = { template: string; includeRuleGuidance: boolean; output: "app" | "canonical" };
type Profiles = {
  promptExtension?: { version: 2; templates: Record<string, PromptProfile> };
  processorOptions: Readonly<IouProcessorOptions>;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

/** App-owned configuration only: no model-family inference, remote scripts or prompt rewriting. */
export function readIouModelImageProfiles(value: unknown): Profiles {
  const fail = (): never => { throw new Error("Invalid IOU model image profile configuration"); };
  if (!record(value) || Object.keys(value).sort().join(",") !== "processorOptions,schemaVersion,templates" ||
    value.schemaVersion !== 1 || !record(value.processorOptions) ||
    Object.keys(value.processorOptions).join(",") !== "rawImageMoneyFormat" ||
    !record(value.templates)) return fail();
  const format = value.processorOptions.rawImageMoneyFormat;
  if (format !== "strict" && format !== "total-row") return fail();
  const entries = Object.entries(value.templates);
  if (entries.length > 8) return fail();
  const templates: Record<string, PromptProfile> = {};
  for (const [id, profile] of entries) {
    if (id.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(id) ||
      ["__proto__", "constructor", "prototype"].includes(id) || !record(profile) ||
      Object.keys(profile).sort().join(",") !== "includeRuleGuidance,output,template" ||
      typeof profile.template !== "string" || !profile.template.trim() ||
      new TextEncoder().encode(profile.template).byteLength > 4096 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\ud800-\udfff\u200b\u200e-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(profile.template) ||
      typeof profile.includeRuleGuidance !== "boolean" ||
      (profile.output !== "app" && profile.output !== "canonical")) return fail();
    templates[id] = Object.freeze({
      template: profile.template, includeRuleGuidance: profile.includeRuleGuidance, output: profile.output,
    });
  }
  const promptExtension = entries.length ? { version: 2 as const, templates: Object.freeze(templates) } : undefined;
  if (promptExtension && new TextEncoder().encode(JSON.stringify(promptExtension)).byteLength > 16384) return fail();
  return Object.freeze({
    ...(promptExtension ? { promptExtension: Object.freeze(promptExtension) } : {}),
    processorOptions: Object.freeze({ rawImageMoneyFormat: format }),
  });
}

const profiles = readIouModelImageProfiles(configuredProfiles);
export const iouImagePromptByModel = profiles.promptExtension;
export const iouImageProcessorOptions = profiles.processorOptions;
