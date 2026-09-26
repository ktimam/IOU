import { iouActionManifest } from "./actionManifest";
import { parseLocalProcessorContext, type LocalProcessorContext } from "./localProcessorContext";

/** Strict final review DTO, separate from the model/evidence schema and owned entirely by IOU. */
export const iouLocalDraftSchema = {
  type: "object", additionalProperties: false, required: ["entries"], properties: {
    entries: { type: "array", minItems: 1, maxItems: 32, items: {
      type: "object", additionalProperties: false, required: ["kind", "amount", "currency", "direction"],
      properties: {
        kind: { type: "string", enum: ["iou", "settlement"] },
        amount: { type: "number", minimum: 0.01, maximum: Math.floor(Number.MAX_SAFE_INTEGER / 100) },
        currency: { type: "string", minLength: 3, maxLength: 3 },
        direction: { type: "string", enum: ["credit", "debt"] },
        date: { type: "string", minLength: 10, maxLength: 10 },
        note: { type: "string", maxLength: 4096 },
        typeId: { type: "string", minLength: 1, maxLength: 128 },
        typeName: { type: "string", minLength: 1, maxLength: 128 },
      },
    } },
  },
};

export function createIouLocalAppPackage(destination: string, processor: { sha256: string; byteLength: number }, privateSetup?: {
  recipientLabel: string;
  processorContext: LocalProcessorContext;
}) {
  const url = new URL(destination);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/openchat/import" ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) ||
    !/^[a-f0-9]{64}$/.test(processor.sha256) || !Number.isSafeInteger(processor.byteLength) || processor.byteLength <= 0) {
    throw new Error("Invalid IOU local app export configuration");
  }
  if (privateSetup && (!parseLocalProcessorContext(privateSetup.processorContext) ||
    !privateSetup.recipientLabel.trim() || privateSetup.recipientLabel.length > 512)) throw new Error("Invalid private IOU export.");
  // The isolated IOU processor already verifies text currency evidence and composes the note.
  // Preserve its reviewed private defaults and optional Type through the host's final conformance
  // pass. Raw source echo is not a field in this private handoff contract.
  const responseSchema = JSON.parse(JSON.stringify(iouActionManifest.outputSchema)) as Record<string, unknown> & { properties: Record<string, Record<string, unknown>> };
  delete responseSchema.properties.message;
  delete responseSchema.properties.currency["x-openchat-require-text-evidence"];
  responseSchema.properties.typeId = { type: "string", minLength: 1, maxLength: 128 };
  responseSchema.properties.typeName = { type: "string", minLength: 1, maxLength: 128 };
  const rules = iouActionManifest.rules.filter(rule => rule.kind !== "from_message");
  if (privateSetup?.processorContext.types.length) {
    const map = privateSetup.processorContext.types.map(type => ({ value: type.id,
      keywords: [...new Set([type.name, ...type.keywords])] }));
    if (map.length > 50 || map.some(item => item.value.length > 64 || item.keywords.length > 50 || item.keywords.some(keyword => keyword.length > 64))) {
      throw new Error("Private Type names/keywords exceed the local app declaration limits.");
    }
    // Generic declarative suggestions, visible only in the explicit private download. OpenChat
    // never interprets IOU processorContext or knows what a saved Type means.
    rules.push({ kind: "keyword_map", field: "typeId", mode: "hint", map });
  }
  return { version: 1, apps: [{
    id: "iou", revision: "local-import-v1", name: "IOU", description: "Review private transaction drafts, then save encrypted entries in IOU.",
    destination: url.href, processor: { sha256: processor.sha256, byteLength: processor.byteLength },
    ...(privateSetup ? { recipientLabel: privateSetup.recipientLabel } : {}), actions: [{
      definition: {
        name: iouActionManifest.id, description: "Prepare an IOU transaction draft for private review.",
        promptTemplate: iouActionManifest.prompt, responseSchema,
        rules, acceptsImage: true,
        card: { title: iouActionManifest.title,
          rows: iouActionManifest.card.fields.map(({ key, label }) => ({ label, valueKey: key })),
          confirmLabel: "Review in IOU", cancelLabel: "Cancel" },
      },
      draftSchema: iouLocalDraftSchema, handoff: { kind: "wrapped-list", field: "entries" },
      ...(privateSetup ? { processorContext: privateSetup.processorContext } : {}),
    }],
  }] };
}
