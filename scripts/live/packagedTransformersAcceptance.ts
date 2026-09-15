// Pure, app-owned acceptance checks. Neither expectations nor post-processing reach the model.
import { buildConfirmPayload, initToFormState } from "../../src/features/openchat/cardBridge";
import { postProcessIouCandidate } from "../../src/features/openchat/localExtraction";
import type { EntryDraft } from "../../src/features/entries/draft";
import { normalizeImageCurrencyToken, permittedImageCurrencyOutputs } from "../../src/features/openchat/currencyEvidencePolicy";

type Fields = {
  amount: number;
  currency?: string | null;
  kind?: "settlement" | "iou";
  date?: string | null;
  interval_start?: string | null;
  interval_end?: string | null;
  printed_date?: string | null;
  printed_end_date?: string | null;
  note?: string;
};
type ProjectedFields = { date: string | null; note?: string; currency?: string | null };
export type PackagedExpectation = {
  version: 1;
  sourceTimestamp: string;
  raw: Fields;
  card: ProjectedFields;
  confirmed: ProjectedFields;
  // Prospective opt-in only. raw.currency remains the independently reviewed source token.
  currencyPolicy?: { version: 1; mode: "literal-or-declared-symbol" };
};

export const DEFAULT_PACKAGED_EXPECTATION: PackagedExpectation = {
  version: 1,
  sourceTimestamp: "2026-08-14T12:00:00.000Z",
  raw: { amount: 12_900, currency: "EGP", kind: "settlement", date: "2026-08-14" },
  card: { date: "2026-08-14" },
  confirmed: { date: "2026-08-14" },
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength = 96): value is string {
  return typeof value === "string" && value.length > 0 && [...value].length <= maxLength &&
    !/[\0-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(value);
}

function calendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function onlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

// JSON.parse keeps only the last duplicate value. A model output claiming two different amounts
// or dates must not qualify merely because its final duplicate happens to match the expectation.
// Run after JSON.parse validates syntax; quoted strings are skipped whole, including escaped quotes.
function uniqueTopLevelKeys(text: string): boolean {
  const keys = new Set<string>();
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === "{" || character === "[") depth++;
    else if (character === "}" || character === "]") depth--;
    else if (character === '"') {
      const start = index;
      for (index++; index < text.length; index++) {
        if (text[index] === "\\") index++;
        else if (text[index] === '"') break;
      }
      let next = index + 1;
      while (/\s/.test(text[next] ?? "") && next < text.length) next++;
      if (depth === 1 && text[next] === ":") {
        const key = JSON.parse(text.slice(start, index + 1)) as string;
        if (keys.has(key)) return false;
        keys.add(key);
      }
    }
  }
  return true;
}

/** Bounded JSON expectations are local test data, not additional model evidence. */
export function parsePackagedExpectation(value: unknown): PackagedExpectation {
  const invalid = () => { throw new Error("invalid expectation"); };
  if (!record(value) || !onlyKeys(value, ["version", "sourceTimestamp", "raw", "card", "confirmed", "currencyPolicy"]) ||
      value.version !== 1 || typeof value.sourceTimestamp !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value.sourceTimestamp) ||
      !Number.isFinite(Date.parse(value.sourceTimestamp)) || !calendarDate(value.sourceTimestamp.slice(0, 10)) ||
      !record(value.raw)) return invalid();
  const raw = value.raw;
  if (!onlyKeys(raw, ["amount", "currency", "kind", "date", "interval_start", "interval_end", "printed_date", "printed_end_date", "note"]) ||
      typeof raw.amount !== "number" || !Number.isFinite(raw.amount) || raw.amount <= 0 || raw.amount > 1e12 ||
      (Object.hasOwn(raw, "currency") && raw.currency !== null &&
        (!boundedString(raw.currency, 16) || /\s|[\p{Cc}\p{Cf}\p{Cs}]/u.test(raw.currency))) ||
      (Object.hasOwn(raw, "kind") && raw.kind !== "iou" && raw.kind !== "settlement")) return invalid();
  for (const field of ["date", "interval_start", "interval_end"] as const) {
    if (Object.hasOwn(raw, field) && raw[field] !== null && !boundedString(raw[field])) return invalid();
  }
  if (Object.hasOwn(raw, "printed_date") || Object.hasOwn(raw, "printed_end_date")) {
    if (!boundedString(raw.printed_date) ||
        (raw.printed_end_date !== "" && !boundedString(raw.printed_end_date))) return invalid();
  }
  if (Object.hasOwn(raw, "note") && !boundedString(raw.note, 4096)) return invalid();
  for (const key of ["card", "confirmed"] as const) {
    const projected = value[key];
    if (!record(projected) || !onlyKeys(projected, ["date", "note", "currency"]) ||
        (projected.date !== null && !calendarDate(projected.date)) ||
        (Object.hasOwn(projected, "currency") && projected.currency !== null &&
          (typeof projected.currency !== "string" || !/^[A-Z]{3}$/.test(projected.currency))) ||
        (Object.hasOwn(projected, "note") && !boundedString(projected.note, 4096))) return invalid();
  }
  if (typeof raw.currency === "string" && !/^[A-Z]{3}$/.test(raw.currency) &&
      (!Object.hasOwn(value.card as object, "currency") || !Object.hasOwn(value.confirmed as object, "currency"))) return invalid();
  if ((Object.hasOwn(value.card as object, "currency") || Object.hasOwn(value.confirmed as object, "currency")) &&
      (!Object.hasOwn(raw, "currency") || !Object.hasOwn(value.card as object, "currency") ||
        !Object.hasOwn(value.confirmed as object, "currency"))) return invalid();
  if (Object.hasOwn(value, "currencyPolicy")) {
    const policy = value.currencyPolicy;
    const canonical = normalizeImageCurrencyToken(raw.currency);
    if (!record(policy) || !onlyKeys(policy, ["version", "mode"]) || policy.version !== 1 ||
        policy.mode !== "literal-or-declared-symbol" || canonical === undefined ||
        (value.card as Record<string, unknown>).currency !== canonical ||
        (value.confirmed as Record<string, unknown>).currency !== canonical) return invalid();
  }
  return value as unknown as PackagedExpectation;
}

export type PackagedResponseEvidence = {
  completeJsonObject: boolean;
  invalidOrTruncatedOutput: boolean;
  outputCharacters: number;
  observed: {
    amount: number | null;
    currency: string | null;
    kind: "settlement" | "iou" | null;
    date: string | null;
    interval_start: string | null;
    interval_end: string | null;
    printed_date: string | null;
    printed_end_date: string | null;
    noteMatches: boolean | null;
  };
  projected: {
    amount: number | null;
    currency: string | null;
    kind: "settlement" | "iou" | null;
    date: string | null;
    noteMatches: boolean | null;
    confirmedAmount: number | null;
    confirmedCurrency: string | null;
    confirmedKind: "settlement" | "iou" | null;
    confirmedDate: string | null;
    confirmedNoteMatches: boolean | null;
    notePreservedInConfirmation: boolean;
  };
  // A targeted regression can pass while full image grounding fails (for example, a guessed
  // ISO currency from an ambiguous symbol). Never use this partial result as full qualification.
  dateTypeNoteAccepted: boolean;
  currencyAccepted: boolean | null;
  literalCurrencyAccepted: boolean | null;
  exact: boolean;
};

/** Whole-response parsing is deliberate: never salvage a balanced prefix from truncated output. */
export function checkPackagedResponse(text: string, expected: PackagedExpectation): PackagedResponseEvidence {
  let candidate: Record<string, unknown> | undefined;
  if (text.length <= 16_384) {
    try {
      const parsed: unknown = JSON.parse(text.trim());
      if (record(parsed) && uniqueTopLevelKeys(text) && onlyKeys(parsed,
        ["amount", "currency", "kind", "date", "interval_start", "interval_end", "printed_date", "printed_end_date", "note"]) &&
        Object.values(parsed).every((value) => value === null || typeof value === "number" ||
          (typeof value === "string" && value.length <= 4096))) candidate = parsed;
    } catch { /* Malformed, fenced, prose-suffixed, or truncated generation is not a pass. */ }
  }
  const nullableString = (value: unknown) => boundedString(value) ? value : null;
  const observed: PackagedResponseEvidence["observed"] = {
    amount: typeof candidate?.amount === "number" && Number.isFinite(candidate.amount) &&
      candidate.amount > 0 && candidate.amount <= 1e12 ? candidate.amount : null,
    currency: boundedString(candidate?.currency, 16)
      ? candidate.currency : null,
    kind: candidate?.kind === "iou" || candidate?.kind === "settlement" ? candidate.kind : null,
    date: nullableString(candidate?.date),
    interval_start: nullableString(candidate?.interval_start),
    interval_end: nullableString(candidate?.interval_end),
    printed_date: nullableString(candidate?.printed_date),
    printed_end_date: candidate?.printed_end_date === "" ? "" : nullableString(candidate?.printed_end_date),
    noteMatches: expected.raw.note === undefined ? null : candidate?.note === expected.raw.note,
  };
  const calendar = new Date(expected.sourceTimestamp);
  const normalized = candidate === undefined ? {} : postProcessIouCandidate(candidate, {
    modality: "image", sourceTimestamp: expected.sourceTimestamp, now: calendar, candidateCount: 1,
  });
  const card = initToFormState(normalized as EntryDraft, calendar);
  const confirmed = buildConfirmPayload(card);
  const projectedAmount = Number(card.amount);
  const projected: PackagedResponseEvidence["projected"] = {
    amount: card.amount.trim() !== "" && Number.isFinite(projectedAmount) ? projectedAmount : null,
    currency: card.currency || null,
    kind: card.kind === "iou" || card.kind === "settlement" ? card.kind : null,
    date: calendarDate(card.date) ? card.date : null,
    noteMatches: expected.card.note === undefined ? null : card.note === expected.card.note,
    confirmedAmount: typeof confirmed.amount === "number" && Number.isFinite(confirmed.amount) ? confirmed.amount : null,
    confirmedCurrency: confirmed.currency ?? null,
    confirmedKind: confirmed.kind === "iou" || confirmed.kind === "settlement" ? confirmed.kind : null,
    confirmedDate: calendarDate(confirmed.date) ? confirmed.date : null,
    confirmedNoteMatches: expected.confirmed.note === undefined ? null : confirmed.note === expected.confirmed.note,
    notePreservedInConfirmation: (confirmed.note ?? "") === card.note,
  };
  const matchesRawField = ([key, value]: [string, unknown]) => {
    if (key === "note") return observed.noteMatches;
    if (key === "currency" && expected.currencyPolicy !== undefined) {
      return expected.currencyPolicy.version === 1 && expected.currencyPolicy.mode === "literal-or-declared-symbol" &&
        permittedImageCurrencyOutputs(value).includes(candidate?.currency as string);
    }
    // null explicitly requires the field to be absent/null, never merely failed sanitization.
    return value === null ? candidate?.[key] === undefined || candidate[key] === null
      : candidate?.[key] === value;
  };
  const rawMatches = Object.entries(expected.raw).every(matchesRawField);
  const printedEvidenceRequested = candidate !== undefined &&
    (!(Object.hasOwn(candidate, "printed_date") || Object.hasOwn(candidate, "printed_end_date")) ||
      (Object.hasOwn(expected.raw, "printed_date") && Object.hasOwn(expected.raw, "printed_end_date")));
  const dateTypeNoteAccepted = candidate !== undefined && printedEvidenceRequested &&
    Object.entries(expected.raw).filter(([key]) => key !== "amount" && key !== "currency").every(matchesRawField) &&
    (expected.raw.kind === undefined || (projected.kind === expected.raw.kind && projected.confirmedKind === expected.raw.kind)) &&
    projected.date === expected.card.date && projected.confirmedDate === expected.confirmed.date &&
    projected.noteMatches !== false && projected.confirmedNoteMatches !== false && projected.notePreservedInConfirmation;
  const currencyAccepted = expected.raw.currency === undefined ? null : candidate !== undefined &&
    matchesRawField(["currency", expected.raw.currency]) === true &&
    projected.currency === (Object.hasOwn(expected.card, "currency") ? expected.card.currency : expected.raw.currency) &&
    projected.confirmedCurrency === (Object.hasOwn(expected.confirmed, "currency") ? expected.confirmed.currency : expected.raw.currency);
  return {
    completeJsonObject: candidate !== undefined,
    invalidOrTruncatedOutput: candidate === undefined,
    outputCharacters: Math.min(text.length, 16_385),
    observed,
    projected,
    dateTypeNoteAccepted,
    currencyAccepted,
    literalCurrencyAccepted: expected.raw.currency === undefined ? null : candidate !== undefined &&
      (expected.raw.currency === null ? candidate.currency === undefined || candidate.currency === null
        : candidate.currency === expected.raw.currency),
    exact: candidate !== undefined && rawMatches && dateTypeNoteAccepted && currencyAccepted !== false &&
      projected.amount === expected.raw.amount &&
      projected.confirmedAmount === expected.raw.amount,
  };
}

/** Do not persist expected note text either: a local fixture may contain private image text. */
export function safePackagedExpectation(expected: PackagedExpectation) {
  const { note: rawNote, ...raw } = expected.raw;
  return {
    version: expected.version,
    ...(expected.currencyPolicy === undefined ? {} : { currencyPolicy: expected.currencyPolicy }),
    sourceCalendarDate: expected.sourceTimestamp.slice(0, 10),
    raw: { ...raw, noteChecked: rawNote !== undefined },
    card: { date: expected.card.date, noteChecked: expected.card.note !== undefined,
      ...(Object.hasOwn(expected.card, "currency") ? { currency: expected.card.currency } : {}) },
    confirmed: { date: expected.confirmed.date, noteChecked: expected.confirmed.note !== undefined,
      ...(Object.hasOwn(expected.confirmed, "currency") ? { currency: expected.confirmed.currency } : {}) },
  };
}
