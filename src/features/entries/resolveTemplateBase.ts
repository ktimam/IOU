// Which of THIS account's saved types does a chat-routed draft mean?
//
// Extracted from an inline SheetPage closure so the containment below is testable at all. It is the
// only thing standing between a foreign type name and this account's ledger.
//
// WHY THE FOREIGN NAME ARRIVES. OpenChat registers ONE manifest per app+user, not per chat:
// ManifestTypesSync folds loadAllSharedTemplates (EVERY account this user is in) into a single
// keyword_map roster. So a "Reservation" that only exists on the House account is deterministically
// offered — and matched — in the child chat, and `raw.template` reaches this sheet naming a type it
// has never heard of. That is by design today (see actionManifest.test.ts, "one per-USER manifest"):
// there is no chat→account gate at propose time, so containment has to happen HERE, at import.
//
// WHAT CONTAINMENT MEANS. A name this account does not have resolves to NO base: no fee percent, no
// fixed fee, no due schedule, no currency, no direction, no default note. The draft is imported with
// exactly what the message itself said. Silently applying a foreign account's 20% fee and 50/50
// schedule to this sheet's entry is the damage this function exists to prevent.
//
// `unknownTemplate` reports the miss so the caller can say so out loud ("type 'Reservation' isn't in
// this account — imported without its defaults") instead of leaving the user to notice that the fee
// they expected never appeared. SheetPage reads only `base` today; the signal is here so the UI can
// be added without re-opening the matching rules.
//
// NOT DEDUPLICATED ACROSS ACCOUNTS. Two accounts may each own a type named "Rent" with different
// fees; this resolves against the CURRENT account's list only, so this sheet always gets its own
// account's "Rent". That is the correct answer for this sheet, and it is also why the roster leak
// above cannot be reasoned about as "the model picked the right type" — see resolveTemplateBase.test.ts.

import type { EntryPayload } from "./types";
import type { TxnTemplate } from "../templates/TemplatesContext";
import { templateToInitial } from "../templates/templateBase";
import { extractTs } from "./draft";

export type TemplateResolution = {
  /** Entry defaults to merge under the extracted draft. Absent ⇒ nothing matched, nothing applied. */
  base?: Partial<EntryPayload>;
  /** The name the draft asked for when this account has no such type. Absent ⇒ nothing was asked for. */
  unknownTemplate?: string;
};

/**
 * Resolve a draft's `template` (the manifest keyword_map / model sets it to the type's NAME — see
 * actionManifest buildTemplateRules) against THIS account's shared types.
 *
 * Matched case-insensitively by name, with an id fallback for any older id-based manifest. The
 * template's relative due schedule is anchored at the DRAFT's transaction date (the same date the
 * entry gets), so a portion "due in 0 days" lands on the reservation date rather than today.
 */
export function resolveTemplateBase(allTemplates: TxnTemplate[], raw: unknown): TemplateResolution {
  if (raw == null || typeof raw !== "object") return {};
  const ref = (raw as { template?: unknown }).template;
  if (typeof ref !== "string" || ref.trim() === "") return {};
  const name = ref.trim();
  const key = name.toLowerCase();
  const t =
    allTemplates.find((x) => x.name.trim().toLowerCase() === key) ??
    allTemplates.find((x) => x.id === ref);
  if (!t) return { unknownTemplate: name };
  return { base: templateToInitial(t, extractTs(raw as { note?: unknown; date?: unknown })) };
}
