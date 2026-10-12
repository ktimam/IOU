import { processIouRequest, type IouProcessorOptions } from "./localProcessorBridge";
import { iouImageProcessorOptions } from "./modelImageProfiles";
import { buildConfirmPayload, initToFormState } from "./cardBridge";
import { parseLocalProcessorContext } from "./localProcessorContext";
import { keywordMatches, matchTemplateForDraft, templateMatchTerms } from "../entries/resolveTemplateBase";
import { validateImageTypeTexts } from "./rawImageSourceDetails";

/** App-owned adapter for the host's one-request, network-disabled classic Worker. */
export function processLocalArtifactRequest(value: unknown, options: IouProcessorOptions = iouImageProcessorOptions) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { kind: "error" };
  const request = value as Record<string, unknown>;
  if (!["actionId,input,type,version", "actionId,context,input,type,version"].includes(Object.keys(request).sort().join(",")) ||
    request.type !== "oc:local-process:request" || request.version !== 1) return { kind: "error" };
  const context = request.context === undefined ? undefined : parseLocalProcessorContext(request.context);
  if (request.context !== undefined && !context) return { kind: "error" };
  const binding = { frameNonce: "0".repeat(48), requestNonce: "1".repeat(48) };
  const result = processIouRequest({ actionId: request.actionId, input: request.input, version: 1,
    type: "oc:app-process:request", ...binding }, binding, options);
  if (result.kind !== "candidates") return result;
  const input = request.input as { sourceTimestamp?: number; modality?: string; operation?: string };
  if (input.operation === "normalize_raw" && input.modality === "image" && options.rawImageDetailsFormat === "labels-v2") {
    const terms = (context?.types ?? []).flatMap(type => templateMatchTerms({ name: type.name, keywords: [...type.keywords] }));
    // Only labels-v2 requires distinct, individually candidate-bearing source strings.
    // Reject the complete result: never filter unrelated text, merge fields or repair duplicates.
    // This vocabulary check cannot establish that the model copied the image faithfully.
    if (result.candidates.some(candidate => {
      const texts = validateImageTypeTexts(candidate.image_type_texts);
      return texts === undefined || new Set(texts).size !== texts.length ||
        texts.some(text => !terms.some(term => keywordMatches(text, term)));
    })) return { kind: "error" };
  }
  const now = input.sourceTimestamp === undefined ? new Date() : new Date(input.sourceTimestamp);
  return { ...result, candidates: result.candidates.map((candidate) => {
    const state = initToFormState(candidate, now);
    if (!Object.hasOwn(candidate, "direction")) state.direction = input.modality === "image" ? "credit" : "debt";
    if (!state.currency && context?.defaultCurrency) state.currency = context.defaultCurrency;
    const matched = context && matchTemplateForDraft(context.types.map((item) => ({ ...item, keywords: [...item.keywords] })),
      candidate, { evidence: result.candidates.length > 1 ? "row-local" : "full", allowImageHeading: input.modality === "image",
        allowImageTypeTexts: input.modality === "image" &&
          (options.rawImageDetailsFormat === "source-v1" || options.rawImageDetailsFormat === "labels-v1" ||
            options.rawImageDetailsFormat === "labels-v2") });
    // Match the original card: a saved Type supplies direction, not a replacement for the
    // extracted IOU/Settlement kind. The two user-visible choices are independent.
    // Paired named-choice exports let the host capture this pre-Type direction before it
    // applies IOU's declared default. Old contexts retain their existing behavior.
    if (matched && context?.draftEditorDefaults !== "host-v1") state.direction = matched.direction;
    // Source ranges become visible note text here, in IOU. Only reviewed DTO fields leave this
    // worker; source echo, image headings/type texts, date intermediates and private types are not forwarded.
    delete state.message;
    return { ...buildConfirmPayload(state), ...(matched ? { typeId: matched.id, typeName: matched.name } : {}) };
  }) };
}
