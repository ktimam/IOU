import { iouActionManifest } from "./actionManifest";
import { parseLocalProcessorContext, type LocalProcessorContext } from "./localProcessorContext";
import { DIRECTION_LABELS } from "../entries/directionLabels";
import { orderedCurrencies } from "../settings/currencies";
import { IOU_LOCAL_APP_REVISION, parseLocalDeliveryEncryption, type LocalDeliveryEncryption } from "./localImportEncryption";

/** Strict final review DTO, separate from the model/evidence schema and owned entirely by IOU. */
export const iouLocalDraftSchema = {
  type: "object", additionalProperties: false, required: ["entries"], properties: {
    entries: { type: "array", minItems: 1, maxItems: 32, items: {
      type: "object", additionalProperties: false, required: ["kind", "amount", "currency", "direction"],
      properties: {
        kind: { type: "string", enum: ["iou", "settlement"] },
        amount: { type: "number", minimum: 0.01, maximum: Math.floor(Number.MAX_SAFE_INTEGER / 100) },
        currency: { type: "string", minLength: 3, maxLength: 3, pattern: "^[A-Z]{3}$" },
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
  deliveryEncryption?: LocalDeliveryEncryption;
}) {
  const url = new URL(destination);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/openchat/import" ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) ||
    !/^[a-f0-9]{64}$/.test(processor.sha256) || !Number.isSafeInteger(processor.byteLength) || processor.byteLength <= 0) {
    throw new Error("Invalid IOU local app export configuration");
  }
  const parsedContext = privateSetup && parseLocalProcessorContext(privateSetup.processorContext);
  if (privateSetup && (!parsedContext ||
    !privateSetup.recipientLabel.trim() || privateSetup.recipientLabel.length > 512)) throw new Error("Invalid private IOU export.");
  const deliveryEncryption = privateSetup?.deliveryEncryption && parseLocalDeliveryEncryption(privateSetup.deliveryEncryption);
  if (privateSetup?.deliveryEncryption && !deliveryEncryption) throw new Error("Invalid IOU delivery encryption setup");
  // The isolated IOU processor already verifies text currency evidence and composes the note.
  // Preserve its reviewed private defaults and optional Type through the host's final conformance
  // pass. Raw source echo is not a field in this private handoff contract.
  const responseSchema = JSON.parse(JSON.stringify(iouActionManifest.outputSchema)) as Record<string, unknown> & { properties: Record<string, Record<string, unknown>> };
  delete responseSchema.properties.message;
  delete responseSchema.properties.currency["x-openchat-require-text-evidence"];
  responseSchema.properties.typeId = { type: "string", minLength: 1, maxLength: 128 };
  responseSchema.properties.typeName = { type: "string", minLength: 1, maxLength: 128 };
  const rules = iouActionManifest.rules.filter(rule => rule.kind !== "from_message");
  if (parsedContext?.types.length) {
    const map = parsedContext.types.map(type => ({ value: type.id,
      keywords: [...new Set([type.name, ...type.keywords])] }));
    if (map.length > 50 || map.some(item => item.value.length > 64 || item.keywords.length > 50 || item.keywords.some(keyword => keyword.length > 64))) {
      throw new Error("Private Type names/keywords exceed the local app declaration limits.");
    }
    // Generic declarative suggestions, visible only in the explicit private download. OpenChat
    // never interprets IOU processorContext or knows what a saved Type means.
    rules.push({ kind: "keyword_map", field: "typeId", mode: "hint", map });
  }
  // The roster belongs to IOU. The host receives only this declarative selector, companion
  // assignment and direction default; kind, fees and schedules remain independent.
  const draftEditor = parsedContext?.types.length ? { version: 1, choices: [{
    field: "typeId", label: "Saved type", noneLabel: "None — use reviewed fields only",
    options: parsedContext.types.map(type => ({ value: type.id, label: type.name,
      assign: [{ field: "typeName", value: type.name }],
      defaults: [{ field: "direction", value: type.direction }],
    })),
  }] } : undefined;
  if (draftEditor && (new Set(draftEditor.choices[0].options.map(option => option.label)).size !== draftEditor.choices[0].options.length ||
    draftEditor.choices[0].options.some(option => option.label === draftEditor.choices[0].noneLabel ||
      /[\p{Cf}\u0000-\u001f\u007f-\u009f]/u.test(option.label)) ||
    new TextEncoder().encode(JSON.stringify(draftEditor)).byteLength > 65536)) {
    throw new Error("Private Type names must be unique, visible labels within the local editor limits.");
  }
  // Never emit the opt-in without its paired selector, including an empty private roster.
  let processorContext: LocalProcessorContext | undefined;
  if (parsedContext) {
    const { draftEditorDefaults: _priorDefaults, ...baseContext } = parsedContext;
    processorContext = parseLocalProcessorContext({ ...baseContext,
      ...(draftEditor ? { draftEditorDefaults: "host-v1" as const } : {}) });
    if (!processorContext) throw new Error("Private Type context exceeds the local processor limits after adding editor defaults.");
  }
  return { version: 1, apps: [{
    id: "iou", revision: IOU_LOCAL_APP_REVISION, name: "IOU", description: "Receive encrypted private transaction drafts, then review and save encrypted entries in IOU.",
    destination: url.href, processor: { sha256: processor.sha256, byteLength: processor.byteLength },
    ...(deliveryEncryption ? { deliveryEncryption } : {}),
    ...(privateSetup ? { recipientLabel: privateSetup.recipientLabel } : {}), actions: [{
      definition: {
        name: iouActionManifest.id, description: "Prepare an IOU transaction draft for private review.",
        promptTemplate: iouActionManifest.prompt, responseSchema,
        rules, acceptsImage: true,
        card: { title: iouActionManifest.title,
          rows: ["amount", "currency", "direction", "kind", "typeId", "date", "note", "typeName"].map(key => ({
            label: key === "typeId" ? "Saved type" : key === "typeName" ? "Type name" :
              iouActionManifest.card.fields.find(field => field.key === key)!.label,
            valueKey: key,
          })),
          confirmLabel: "Review in IOU", cancelLabel: "Cancel" },
      },
      draftSchema: iouLocalDraftSchema, handoff: { kind: "wrapped-list", field: "entries" },
      // Presentation only; suggestions do not narrow valid currency codes or change extracted values.
      draftPresentation: { version: 1, enumLabels: [
        { field: "kind", options: [{ value: "iou", label: "IOU" }, { value: "settlement", label: "Settlement" }] },
        { field: "direction", options: [{ value: "credit", label: DIRECTION_LABELS.credit }, { value: "debt", label: DIRECTION_LABELS.debt }] },
      ], controls: [
        { field: "currency", kind: "select", suggestions: orderedCurrencies(parsedContext?.defaultCurrency) },
        { field: "date", kind: "date" },
        { field: "note", kind: "multiline", fullWidth: true },
      ] },
      ...(processorContext ? { processorContext } : {}),
      ...(draftEditor ? { draftEditor } : {}),
    }],
  }] };
}
