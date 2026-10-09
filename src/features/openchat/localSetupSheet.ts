import { decryptName } from "../crypto/devVetkd";
import { createLocalProcessorContext } from "./localProcessorContext";
import { localConnectionLabel, localConnectionLabels } from "./localConnectionLabels";
import { decryptSlotWithStatus, myMemberIndex } from "../templates/pairTemplatesActor";
import { mergePairTemplates, visibleTemplates } from "../templates/pairTemplates";
import { LocalSetupV2Error, type LocalSetupSheet } from "./localSetupV2Service";

const unwrap = <T,>(value: T | T[] | null | undefined): T | null => Array.isArray(value) ? value[0] ?? null : value ?? null;
/** Read-only strict Type/name snapshot using the existing sheet-key provider. */
export async function loadLocalSetupSheet(options: {
  actor: any; principal: string; sheetId: string; defaultCurrency: string;
  unwrapFor: (sheetId: string) => Promise<Uint8Array>; assertCurrent: () => void;
}): Promise<LocalSetupSheet> {
  const { actor, principal, sheetId, assertCurrent: check } = options;
  check(); const sheet = unwrap<any>(await actor.get_sheet(sheetId)); check();
  if (!sheet || sheet.id !== sheetId || !sheet.state || !("Active" in sheet.state) ||
    ![sheet.member_a, sheet.member_b].some(member => member?.toText?.() === principal)) {
    throw new LocalSetupV2Error("This sheet is not active or is unavailable to the signed-in IOU account. Use Open setup in this chat.");
  }
  const pair = unwrap<any>(await actor.get_pair(sheet.pair_id)); check();
  if (!pair || pair.id !== sheet.pair_id || myMemberIndex(pair, principal) == null ||
    unwrap(pair.archived_at) != null) {
    throw new LocalSetupV2Error("This chat's IOU account or active sheet changed. Use Open setup in this chat.");
  }
  // The active sheet belongs to PairSummary, not Pair. Read it afresh for each
  // preview/share so a sheet rotation cannot reuse the earlier picker snapshot.
  const summaries: unknown = await actor.get_my_pairs(); check();
  const matching = Array.isArray(summaries) ? summaries.filter(summary => summary?.id === pair.id) : [];
  if (matching.length !== 1 || unwrap(matching[0].active_sheet_id) !== sheetId || unwrap(matching[0].archived_at) != null) {
    throw new LocalSetupV2Error("This chat's IOU account or active sheet changed. Use Open setup in this chat.");
  }
  const key = await options.unwrapFor(sheetId); check();
  const [a, b] = await Promise.all([
    decryptSlotWithStatus(key, pair.templates_a_enc, pair.templates_a_iv),
    decryptSlotWithStatus(key, pair.templates_b_enc, pair.templates_b_iv),
  ]); check();
  if (!a.readable || !b.readable) throw new LocalSetupV2Error("This sheet's private Types could not be read. No setup was shared.");
  let names = localConnectionLabels(0);
  try {
    const [sheetName, accountName] = await Promise.all([
      decryptName(key, new Uint8Array(unwrap<any>(sheet.name_iv) ?? []), new Uint8Array(unwrap<any>(sheet.name_enc) ?? [])),
      decryptName(key, new Uint8Array(unwrap<any>(pair.name_iv) ?? []), new Uint8Array(unwrap<any>(pair.name_enc) ?? [])),
    ]); check(); names = localConnectionLabels(0, accountName, sheetName);
  } catch { check(); }
  return Object.freeze({ pairId: pair.id, sheetId, label: localConnectionLabel(names),
    processorContext: createLocalProcessorContext(visibleTemplates(mergePairTemplates(a.payload.templates, b.payload.templates)), options.defaultCurrency) });
}
