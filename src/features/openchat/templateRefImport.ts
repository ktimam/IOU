// Restore an OpenChat card's encrypted account-type selection only after the
// confirmed payload is back inside the signed-in IOU application.
//
// This boundary intentionally removes every plaintext template field received
// from OpenChat. Only a template_ref authenticated under this sheet key and the
// exact chat/message/row coordinates may become a local template id.

import { decryptTemplateRef, type TemplateRefContext } from "./templateRef";

const MAX_CARD_ENTRIES = 100;
const INVALID_SELECTION_MESSAGE = "invalid encrypted account type selection";

export type OpenChatTemplateRefContext = Omit<TemplateRefContext, "entryIndex">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function restoreRow(
  value: unknown,
  entryIndex: number,
  K_sheet: Uint8Array,
  context: OpenChatTemplateRefContext | undefined,
  allowedTemplateIds: ReadonlySet<string> | undefined,
): Promise<unknown> {
  if (!isRecord(value)) return value;

  const row = { ...value };
  const reference = row.template_ref;

  // Neither a host-provided name nor an id may select an account-local type.
  // The authenticated encrypted reference below is the sole authority.
  delete row.template;
  delete row.template_ref;

  if (reference === undefined) return row;
  if (typeof reference !== "string" || !context) throw new Error(INVALID_SELECTION_MESSAGE);

  try {
    const templateId = await decryptTemplateRef(reference, K_sheet, {
      ...context,
      entryIndex,
    });
    if (allowedTemplateIds && !allowedTemplateIds.has(templateId)) {
      throw new Error(INVALID_SELECTION_MESSAGE);
    }
    row.template = templateId;
    return row;
  } catch {
    throw new Error(INVALID_SELECTION_MESSAGE);
  }
}

/**
 * Return a fresh payload with valid template_ref values restored to local
 * template ids. The input is never mutated. Arrays use their exact card row
 * index as authenticated additional data.
 */
export async function restoreOpenChatTemplateRefs(
  payload: unknown,
  K_sheet: Uint8Array,
  context?: OpenChatTemplateRefContext,
  allowedTemplateIds?: ReadonlySet<string>,
): Promise<unknown> {
  if (Array.isArray(payload)) {
    if (payload.length > MAX_CARD_ENTRIES) {
      throw new Error(INVALID_SELECTION_MESSAGE);
    }
    return Promise.all(
      payload.map((row, entryIndex) =>
        restoreRow(row, entryIndex, K_sheet, context, allowedTemplateIds),
      ),
    );
  }
  return restoreRow(payload, 0, K_sheet, context, allowedTemplateIds);
}
