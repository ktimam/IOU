import { IOU_EXTRACTION_RULES } from "./actionManifest";
import { IOU_LOCAL_EXTRACTION_SCHEMA } from "./localExtractionConfig";
import { validatedSourceInterval } from "./sourceInterval";
import {
    applyTextDateSchemaProperties,
    matchesKeyword,
    normalizeIouCandidateDates,
    parseDeclaredDelimitedTextSequence,
    sourceIntervalFromText,
} from "./localExtractionSemantics";
import {
    parseSourceGroundedTransactions,
    type SourceGroundedParseResult,
    type SourceGroundedTransactionInput,
} from "./sourceGroundedActionParser";

export type IouLocalExtractionInput = SourceGroundedTransactionInput;

export type IouCandidateSource = Readonly<{
    text?: string;
    sourceTimestamp?: Date | number | string;
    modality: "text" | "image" | "audio";
    candidateCount?: number;
    now?: Date;
}>;

function dateAnchor(value: Date | number | string | undefined): Date | undefined {
    if (value === undefined) return undefined;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date : undefined;
}

/** App-owned source date recovery and visible date normalization for a model candidate. */
export function postProcessIouCandidate(
    candidate: Record<string, unknown>,
    source: IouCandidateSource,
): Record<string, unknown> {
    const timestamp = dateAnchor(source.sourceTimestamp);
    const calendar = source.now ?? timestamp ?? new Date();
    const normalized = normalizeIouCandidateDates(candidate, IOU_LOCAL_EXTRACTION_SCHEMA);
    const candidateInterval = validatedSourceInterval(candidate.interval_start, candidate.interval_end, calendar);
    // Validate before the host signs the app-authored content. A bounded arbitrary string is
    // not date evidence; never let a row label become a synthesized From-to note.
    delete normalized.interval_start;
    delete normalized.interval_end;
    if (candidateInterval !== undefined) {
        normalized.interval_start = candidateInterval.start;
        normalized.interval_end = candidateInterval.end;
        if (normalized.date === undefined && candidateInterval.date !== undefined) {
            normalized.date = candidateInterval.date;
        }
    }
    if (!source.text?.trim()) return normalized;
    const interval = (source.candidateCount ?? 1) === 1
        ? sourceIntervalFromText(source.text, calendar)
        : { kind: "none" as const };
    if (interval.kind === "ambiguous") return normalized;
    const dated = applyTextDateSchemaProperties(
        normalized,
        IOU_LOCAL_EXTRACTION_SCHEMA,
        source.text,
        source.candidateCount ?? 1,
        calendar,
        timestamp,
    );
    // Preserve the app/model note and the complete endpoints separately. IOU's card projection
    // adds the full interval to the editable note exactly once.
    return interval.kind === "interval"
        ? { ...dated, interval_start: interval.start, interval_end: interval.end }
        : dated;
}

/**
 * Pure IOU-local extraction entrypoint for exact text or a private OCR transcript.
 * Monetary/date/type policies remain app-owned; a failed parse requests manual entry or
 * another extraction strategy without inventing a candidate.
 */
export function extractIouLocalCandidates(
    input: IouLocalExtractionInput,
): SourceGroundedParseResult {
    // Preserve the exact per-row description/currency/amount from a fully explicit list.
    const delimited = input.source === "text"
        ? parseDeclaredDelimitedTextSequence(IOU_LOCAL_EXTRACTION_SCHEMA, input.text)
        : { kind: "none" as const };
    if (delimited.kind === "overflow") {
        return { kind: "ambiguous", reason: "too_many_transactions" };
    }
    let result: SourceGroundedParseResult;
    if (delimited.kind === "candidates") {
        const candidates = delimited.candidates.map((candidate) => {
            const out: Record<string, unknown> = { kind: "iou", direction: "debt", ...candidate };
            for (const rule of IOU_EXTRACTION_RULES) {
                if (rule.kind !== "keyword_map" || rule.mode !== "override") continue;
                const hit = rule.map.find((mapping) =>
                    mapping.keywords.some((keyword) => matchesKeyword(input.text, keyword)),
                );
                if (hit !== undefined) out[rule.field] = hit.value;
            }
            // Source text remains separate from each row's exact note.
            out.message = input.text.trim().slice(0, 200);
            return out;
        });
        result = { kind: "candidates", candidates };
    } else {
        result = parseSourceGroundedTransactions(
            IOU_LOCAL_EXTRACTION_SCHEMA,
            IOU_EXTRACTION_RULES,
            input,
        );
    }
    if (result.kind !== "candidates") return result;
    const count = result.candidates.length;
    return {
        kind: "candidates",
        candidates: result.candidates.map((candidate) =>
            postProcessIouCandidate(candidate, {
                text: input.text,
                modality: input.source === "ocr" ? "image" : "text",
                candidateCount: count,
                now: input.now,
            }),
        ),
    };
}
