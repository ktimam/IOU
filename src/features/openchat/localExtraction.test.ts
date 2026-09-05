import { describe, expect, it } from "vitest";
import { extractIouLocalCandidates, postProcessIouCandidate } from "./localExtraction";
import { iouActionManifest } from "./actionManifest";
import { initToFormState } from "./cardBridge";
import { processIouRequest } from "./localProcessorBridge";
import { sourceIntervalFromText } from "./localExtractionSemantics";

const anchor = new Date("2026-08-16T12:00:00Z");

describe("IOU-owned local extraction", () => {
    it("extracts a transaction from text through IOU's own schema and rules", () => {
        expect(extractIouLocalCandidates({
            source: "text", text: "You owe me 425 EGP for groceries", now: anchor,
        })).toMatchObject({
            kind: "candidates",
            candidates: [{ amount: 425, currency: "EGP", kind: "iou", direction: "credit", note: "groceries" }],
        });
    });

    it("preserves each row in command amount-label shorthand", () => {
        expect(extractIouLocalCandidates({
            source: "text", text: "owe me 300 food 400 Uber", now: anchor,
        })).toMatchObject({
            kind: "candidates",
            candidates: [
                { amount: 300, note: "food", direction: "credit" },
                { amount: 400, note: "Uber", direction: "credit" },
            ],
        });
    });

    it("preserves per-row notes, amounts and currencies in explicit lists", () => {
        expect(extractIouLocalCandidates({
            source: "text", text: "Outstanding: lunch 20 USD; taxi 30 EGP", now: anchor,
        })).toMatchObject({
            kind: "candidates",
            candidates: [
                { amount: 20, currency: "USD", note: "lunch", kind: "iou", direction: "debt" },
                { amount: 30, currency: "EGP", note: "taxi", kind: "iou", direction: "debt" },
            ],
        });
    });

    it("keeps secondary OCR numbers and prose outside primary amount/date evidence", () => {
        expect(extractIouLocalCandidates({
            source: "ocr",
            text: "TOTAL 12,900 EGP\nDATE: 14 AUG 2026",
            ocrSemanticText: "تمت العملية بنجاح\n1,000 USD\nNOTE: invented",
            now: anchor,
        })).toEqual({
            kind: "candidates",
            candidates: [{ amount: 12_900, currency: "EGP", date: "2026-08-14", kind: "settlement", direction: "credit" }],
        });
    });

    it("returns no candidates for a non-transaction message", () => {
        expect(extractIouLocalCandidates({ source: "text", text: "See you at 3 pm by gate 4", now: anchor }).kind)
            .not.toBe("candidates");
    });
});

describe("IOU-owned source date recovery", () => {
    it("normalizes a copied English date without requiring host date semantics", () => {
        expect(postProcessIouCandidate({ date: "14 Aug 2026 09:47 PM", amount: 12900 }, {
            modality: "image",
        })).toEqual({ date: "2026-08-14", amount: 12900 });
    });

    it("normalizes a recognized model field alias", () => {
        expect(postProcessIouCandidate({ TransactionDate: "14 Aug 2026" }, { modality: "image" }))
            .toMatchObject({ date: "2026-08-14" });
    });

    it("recovers a source range's start without adding source text to the note", () => {
        const note = "Synthetic property UNIT-A1";
        expect(postProcessIouCandidate({ note, date: "2026-07-04" }, {
            modality: "text", text: "Reservation Confirmed\nSynthetic property UNIT-A1\nAugust 6-10\n26,400 EGP", now: anchor,
        })).toEqual({ note, date: "2026-08-06", interval_start: "2026-08-06", interval_end: "2026-08-10" });
    });

    it("uses source timestamp as the year anchor and retains the explicit month/day", () => {
        expect(postProcessIouCandidate({}, {
            modality: "text", text: "Workshop 14 August, 100 EGP", sourceTimestamp: "2025-09-01T12:00:00Z",
        })).toEqual({ date: "2025-08-14" });
    });

    it("does not copy one source date across multiple candidates", () => {
        expect(postProcessIouCandidate({ note: "second item" }, {
            modality: "text", text: "First item due 14 August; second item later", candidateCount: 2, now: anchor,
        })).toEqual({ note: "second item" });
    });

    it("rejects ambiguous numeric-only and impossible dates", () => {
        for (const date of ["07/04/2026", "30 Feb 2026", "2026-02-30"]) {
            expect(postProcessIouCandidate({ date }, { modality: "image" })).toEqual({});
        }
    });

    it("does not choose between conflicting model aliases without source evidence", () => {
        expect(postProcessIouCandidate({ date: "2026-08-14", TransactionDate: "2026-07-04" }, {
            modality: "image",
        })).not.toHaveProperty("date");
    });

    it("recovers explicit relative dates against the supplied calendar", () => {
        expect(postProcessIouCandidate({}, { modality: "text", text: "Pay tomorrow", now: anchor }))
            .toEqual({ date: "2026-08-17" });
    });
});

describe("IOU-owned complete source intervals", () => {
    it("rejects model row labels as interval values before card creation, without changing the source note", () => {
        const original = {
            amount: 1912.15, currency: "USD", note: "Reservation",
            interval_start: "Reservation", interval_end: "Total Payout",
        };
        const candidate = postProcessIouCandidate(original, { modality: "image", now: anchor });
        expect(candidate).toEqual({ amount: 1912.15, currency: "USD", note: "Reservation" });
        expect(initToFormState(candidate, anchor)).toMatchObject({ note: "Reservation", date: "" });
        expect(original).toHaveProperty("interval_start", "Reservation");
    });

    it.each(["Reservation", "Equipment calibration"])(
        "derives a complete model interval before card creation independently of the note %s", (note) => {
            const original = {
                amount: 1912.15, currency: "USD", note,
                interval_start: "Sun, Jul 19", interval_end: "Thu, Aug 6",
            };
            const candidate = postProcessIouCandidate(original, {
                modality: "image", sourceTimestamp: "2026-07-03T12:00:00Z",
            });
            expect(candidate).toEqual({ ...original, date: "2026-07-19" });
            expect(initToFormState(candidate, anchor)).toMatchObject({
                date: "2026-07-19", note: `${note} | From Sun, Jul 19 to Thu, Aug 6`,
            });
        },
    );

    it("preserves a complete yearless model interval without guessing a date when there is no weekday evidence", () => {
        const original = { note: "source description", interval_start: "Jul 19", interval_end: "Aug 6" };
        expect(postProcessIouCandidate(original, { modality: "image", now: anchor })).toEqual(original);
        expect(initToFormState(original, anchor)).toMatchObject({
            note: "source description | From Jul 19 to Aug 6", date: "",
        });
    });

    it("uses per-candidate image intervals without copying dates between rows", () => {
        const candidates = [
            { note: "first item", interval_start: "2025-01-02", interval_end: "2025-01-03" },
            { note: "second item", interval_start: "Start", interval_end: "End" },
        ].map((candidate) => postProcessIouCandidate(candidate, { modality: "image", candidateCount: 2, now: anchor }));
        expect(candidates).toEqual([
            { note: "first item", interval_start: "2025-01-02", interval_end: "2025-01-03", date: "2025-01-02" },
            { note: "second item" },
        ]);
    });

    it.each(["Reservation Confirmed", "Equipment calibration"])(
        "carries the complete interval from the app processor into the rendered note for %s",
        (heading) => {
            const binding = { frameNonce: "a".repeat(48), requestNonce: "b".repeat(48) };
            const result = processIouRequest({
                type: "oc:app-process:request", version: 1, ...binding,
                actionId: iouActionManifest.id,
                input: {
                    operation: "extract", modality: "text",
                    text: `${heading}\nSynthetic property UNIT-A1\nAugust 6-10\n26,400 EGP`,
                    sourceTimestamp: Date.UTC(2026, 8, 5),
                },
            }, binding);
            expect(result.kind).toBe("candidates");
            if (result.kind !== "candidates") throw new Error("expected app candidates");
            expect(result.candidates).toHaveLength(1);
            const candidate = result.candidates[0];
            expect(candidate).toMatchObject({
                amount: 26400, currency: "EGP", date: "2026-08-06",
                interval_start: "2026-08-06", interval_end: "2026-08-10",
            });
            expect(initToFormState(candidate, anchor).note).toContain("From 2026-08-06 to 2026-08-10");
        },
    );

    it.each([
        ["August 6-10", "2026-08-06", "2026-08-10"],
        ["6th–10th August 2027", "2027-08-06", "2027-08-10"],
        ["July 19 to August 6, 2026", "2026-07-19", "2026-08-06"],
        ["19 July 2026 – 6 August 2026", "2026-07-19", "2026-08-06"],
        ["2026-08-06 to 2026-08-10", "2026-08-06", "2026-08-10"],
        ["2026-12-29 – 2027-01-03", "2026-12-29", "2027-01-03"],
    ])("resolves both endpoints from %s and preserves an existing note", (text, start, end) => {
        const original = { amount: 50, note: "source description" };
        const candidate = postProcessIouCandidate(original, { modality: "text", text, now: anchor });
        expect(candidate).toMatchObject({ note: original.note, interval_start: start, interval_end: end });
        const form = initToFormState(candidate, anchor);
        expect(form.note).toBe(`source description | From ${start} to ${end}`);
        expect(initToFormState({ ...candidate, note: form.note }, anchor).note).toBe(form.note);
        expect(original).toEqual({ amount: 50, note: "source description" });
    });

    it.each([
        "February 29-30 2026",
        "August 10-6",
        "2026-08-10 to 2026-08-06",
        "2026-02-30 to 2026-03-02",
        "August 6-10 and September 4-8",
        "August 6-10 and February 30-31",
    ])("does not choose or repair invalid/ambiguous intervals in %s", (text) => {
        expect(sourceIntervalFromText(text, anchor)).toEqual({ kind: "ambiguous" });
        expect(postProcessIouCandidate({ note: "unchanged" }, { modality: "text", text, now: anchor }))
            .toEqual({ note: "unchanged" });
    });

    it("does not invent a year without an anchor or infer intervals from numeric identifiers", () => {
        expect(sourceIntervalFromText("August 6-10")).toEqual({ kind: "ambiguous" });
        expect(sourceIntervalFromText("Reference TEST-UNIT-A1; units 6-10", anchor)).toEqual({ kind: "none" });
        expect(sourceIntervalFromText("06/08/2026 to 10/08/2026", anchor)).toEqual({ kind: "none" });
    });

    it("does not copy a message-wide range onto independent candidate rows", () => {
        const rows = [{ amount: 20, note: "first item" }, { amount: 30, note: "second item" }];
        const candidates = rows.map((candidate) => postProcessIouCandidate(candidate, {
            modality: "text", text: "First item August 6-10; second item later", now: anchor, candidateCount: rows.length,
        }));
        expect(candidates).toEqual(rows);
        expect(candidates.map((candidate) => initToFormState(candidate, anchor).note))
            .toEqual(["first item", "second item"]);
    });
});
