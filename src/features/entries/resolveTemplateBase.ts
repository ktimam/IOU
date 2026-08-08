// Which of THIS account's saved types does an imported draft mean?
//
// Extracted from an inline SheetPage closure so the containment below is testable at all. It is the
// boundary that ensures external/legacy template references and local keyword
// matching can use only the linked account's decrypted template list.
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
// account's "Rent". No cross-account aggregate is consulted.

import type { EntryPayload } from "./types";
import type { TxnTemplate } from "../templates/TemplatesContext";
import { templateToInitial } from "../templates/templateBase";
import { extractTs, messageEvidence } from "./draft";

export type TemplateResolution = {
  /** Entry defaults to merge under the extracted draft. Absent ⇒ nothing matched, nothing applied. */
  base?: Partial<EntryPayload>;
  /** The name the draft asked for when this account has no such type. Absent ⇒ nothing was asked for. */
  unknownTemplate?: string;
};

export type TemplateMatchOptions = {
  /**
   * A multi-entry extraction repeats the full source `message` on every row.
   * In that mode only the model's row-local `note` may select a saved Type;
   * otherwise one transaction's keyword can apply money defaults to a sibling.
   */
  evidence?: "full" | "row-local";
};

/**
 * OpenChat extraction is always row-local, even when a model array was
 * filtered down to one surviving row. Local/legacy single imports retain the
 * full-message convenience matcher; every true multi import is row-local.
 */
export function templateEvidenceForImport(
  source: "openchat" | "connector" | undefined,
  multiEntry: boolean,
): "full" | "row-local" {
  return source === "openchat" || multiEntry ? "row-local" : "full";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function keywordMatches(text: string, keyword: string): boolean {
  const normalized = keyword.trim();
  if (!normalized) return false;
  // Match complete words/phrases, so a type keyword such as "rent" does not match "parent".
  return new RegExp(
    `(^|[^\\p{L}\\p{N}_])${escapeRegExp(normalized)}($|[^\\p{L}\\p{N}_])`,
    "iu",
  ).test(text);
}

/**
 * Select exactly one account-local type from the draft's message evidence.
 *
 * This is shared by the signed-in import page and the credentialless OpenChat
 * card after the card has decrypted the viewer-authorized account roster. A
 * collision is deliberately treated as no match: money defaults must never be
 * selected by array order when two types share a keyword.
 */
export function matchTemplateForDraft(
  allTemplates: TxnTemplate[],
  raw: unknown,
  options: TemplateMatchOptions = {},
): TxnTemplate | undefined {
  if (raw == null || typeof raw !== "object") return undefined;
  const draft = raw as { message?: unknown; note?: unknown };
  const evidence = options.evidence === "row-local"
    ? (typeof draft.note === "string" ? draft.note : "")
    : messageEvidence(draft);
  if (!evidence.trim()) return undefined;
  const matches = allTemplates.filter((template) =>
    (template.keywords ?? []).some((keyword) => keywordMatches(evidence, keyword)),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Resolve a legacy explicit `template` reference or locally match message evidence against THIS
 * account's private shared types.
 *
 * Matched case-insensitively by name, with an id fallback for any older id-based manifest. The
 * template's relative due schedule is anchored at the DRAFT's transaction date (the same date the
 * entry gets), so a portion "due in 0 days" lands on the reservation date rather than today.
 */
export function resolveTemplateBase(
  allTemplates: TxnTemplate[],
  raw: unknown,
  options: TemplateMatchOptions = {},
): TemplateResolution {
  if (raw == null || typeof raw !== "object") return {};
  const ref = (raw as { template?: unknown }).template;
  let t: TxnTemplate | undefined;
  if (typeof ref === "string" && ref.trim() !== "") {
    const name = ref.trim();
    const key = name.toLowerCase();
    // A restored encrypted template_ref carries an id, while older local
    // drafts may carry a display name. If one value names one template but is
    // another template's id, choosing either by lookup order silently applies
    // the wrong private fee/schedule. Require one unique row across BOTH
    // namespaces; duplicate names and id/name collisions fail closed.
    const matches = allTemplates.filter(
      (candidate) =>
        candidate.name.trim().toLowerCase() === key || candidate.id === ref,
    );
    if (matches.length !== 1) return { unknownTemplate: name };
    [t] = matches;
  } else {
    // The public OpenChat manifest intentionally contains no private template roster. Match only
    // after the draft reaches IOU, against the templates of this linked account.
    t = matchTemplateForDraft(allTemplates, raw, options);
    if (!t) return {};
  }
  return { base: templateToInitial(t, extractTs(raw as { note?: unknown; date?: unknown })) };
}
