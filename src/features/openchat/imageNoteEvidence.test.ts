import { describe, expect, it } from "vitest";
import { iouActionManifest } from "./actionManifest";
import { buildConfirmPayload, initToFormState } from "./cardBridge";
import { IOU_IMAGE_HEADING_MAX_CODEPOINTS, validateImageHeading } from "./imageHeading";
import { processIouRequest } from "./localProcessorBridge";

// Constructed app-boundary tests only: no model output, host parser, authenticated private context,
// or source-accuracy claim. A single candidate can be a surviving multi-entry row: the current
// bridge does not carry original cardinality, so normalization must not stamp captions over notes.
const binding = { frameNonce: "a".repeat(48), requestNonce: "b".repeat(48) };
const sourceTimestamp = Date.parse("2026-09-10T12:00:00Z");
const baseline = {
    kind: "settlement", amount: 12900, currency: "EGP", note: "Image memo",
    printed_date: "14 Aug 2026", printed_end_date: "",
};
function normalize(
    candidates: Record<string, unknown>[],
    options: { text?: string; modality?: "image" | "text" | "audio" } = {},
) {
    const result = processIouRequest({
        type: "oc:app-process:request", version: 1, ...binding, actionId: iouActionManifest.id,
        input: { operation: "normalize", modality: options.modality ?? "image", sourceTimestamp,
            candidates, ...(options.text === undefined ? {} : { text: options.text }) },
    }, binding);
    if (result.kind !== "candidates") throw new Error(`Expected candidates, got ${result.kind}`);
    return result.candidates;
}
function project(candidate: Record<string, unknown>) {
    const form = initToFormState(candidate, new Date(sourceTimestamp));
    return { form, confirmed: buildConfirmPayload(form) };
}

describe("bounded image heading evidence", () => {
    it("trims one line and counts Unicode codepoints, not UTF-16 units", () => {
        expect(IOU_IMAGE_HEADING_MAX_CODEPOINTS).toBe(200);
        expect(validateImageHeading("  عنوان الصورة  ")).toBe("عنوان الصورة");
        expect(validateImageHeading(` ${"📘".repeat(200)} `)).toBe("📘".repeat(200));
        expect(validateImageHeading("📘".repeat(201))).toBeUndefined();
    });
    it.each([undefined, null, false, 42, [], {}, "", "   ", "a\0b", "a\nb", "a\rb", "\tHeading",
        "a\u0085b", "a\u2028b", "a\u2029b"].map(value => ({ value })))("rejects nonstrings, blanks and controls without coercion: $value", ({ value }) => {
        expect(validateImageHeading(value)).toBeUndefined();
    });
    it("retains only validated image evidence and never puts it in confirmation", () => {
        const candidate = normalize([{ ...baseline, image_heading: "  Public category  " }])[0];
        expect(candidate.image_heading).toBe("Public category");
        const { form, confirmed } = project(candidate);
        expect(form).not.toHaveProperty("image_heading");
        expect(confirmed).not.toHaveProperty("image_heading");
        expect(confirmed).toMatchObject({ amount: 12900, currency: "EGP", date: "2026-08-14", note: "Image memo" });
    });
    it.each(["text", "audio"] as const)("drops heading evidence for %s candidates", modality => {
        const candidate = normalize([{ kind: "iou", amount: 50, note: "Original row", image_heading: "Category" }],
            { modality, text: "Attached description" })[0];
        expect(candidate).not.toHaveProperty("image_heading");
        expect(candidate.note).toBe("Original row");
    });
    it.each(["Heading\nMemo", "Heading\u2028Memo", "x".repeat(201), { value: "Heading" }])("deletes invalid image heading: %j", image_heading => {
        const candidate = normalize([{ ...baseline, image_heading }])[0];
        expect(candidate).not.toHaveProperty("image_heading");
        expect(candidate.note).toBe(baseline.note);
    });
});

describe("image captions never overwrite row notes without original-cardinality provenance", () => {
    it("preserves the model note despite a full caption and the host's 200-character message prefix", () => {
        const text = `  EGP ${"purpose ".repeat(40)}\nUser's final line  `;
        expect(text.length).toBeGreaterThan(200);
        const candidate = normalize([{ ...baseline, message: text.trim().slice(0, 200), image_heading: "Category" }], { text })[0];
        expect(candidate.note).toBe(baseline.note);
        expect(candidate.note).not.toBe(text);
        expect(candidate.note).not.toBe(candidate.message);
        expect(candidate.image_heading).toBe("Category");
        const { form, confirmed } = project(candidate);
        expect(form.note).toBe(baseline.note);
        expect(confirmed.note).toBe(baseline.note);
        expect(confirmed.date).toBe("2026-08-14");
        expect(confirmed).not.toHaveProperty("image_heading");
    });
    it("does not reinterpret even a within-schema 4096-codepoint caption as row note", () => {
        const properties = iouActionManifest.outputSchema.properties as Record<string, { maxLength?: number }>;
        expect(properties.note.maxLength).toBe(4096);
        const text = "📘".repeat(4096);
        const candidate = normalize([{ ...baseline }], { text })[0];
        expect(candidate.note).toBe(baseline.note);
        expect(project(candidate).confirmed.note).toBe(baseline.note);
    });
    it.each([
        ["spaces", " "], ["whitespace", "\n\t"], ["NUL", "before\0after"],
        ["overlong ASCII", "x".repeat(4097)], ["overlong Unicode", "📘".repeat(4097)],
    ])("keeps the existing note for %s caption", (_label, text) => {
        const candidate = normalize([{ ...baseline }], { text })[0];
        expect(candidate.note).toBe(baseline.note);
        expect(project(candidate).confirmed.note).toBe(baseline.note);
    });
    it("does not stamp shared captions onto multiple candidates", () => {
        const rows = [{ ...baseline, note: "First purpose", image_heading: "First category" },
            { ...baseline, note: "Second purpose", image_heading: "Second category" }];
        const candidates = normalize(rows, { text: "Shared description for several entries" });
        expect(candidates.map(candidate => candidate.note)).toEqual(["First purpose", "Second purpose"]);
        expect(candidates.map(candidate => candidate.image_heading)).toEqual(["First category", "Second category"]);
    });
    it("preserves a filtered single survivor's row-local note instead of copying sibling evidence", () => {
        const text = "First purpose 50 EGP; Second purpose 75 EGP";
        const remaining = { ...baseline, note: "Second purpose", image_heading: "Second category", message: text };
        const candidate = normalize([remaining], { text })[0];
        expect(candidate.note).toBe("Second purpose");
        expect(candidate.note).not.toContain("First purpose");
        expect(candidate.image_heading).toBe("Second category");
        expect(project(candidate).confirmed.note).toBe("Second purpose");
    });
    it("retains the existing no-caption result and does not mutate candidate input", () => {
        const original = structuredClone(baseline);
        const candidate = normalize([baseline])[0];
        expect(baseline).toEqual(original);
        expect(candidate).toEqual({ kind: "settlement", amount: 12900, currency: "EGP", note: "Image memo", date: "2026-08-14" });
    });
    it.each([
        { printed_date: "14 Aug 2026" },
        { printed_date: "14 Aug 2026", printed_end_date: "Total payout" },
        { printed_date: "14 Aug 2026", printed_end_date: "", date: "2026-08-14" },
    ])("preserves the model note and rejects invalid dates despite a dated caption: %j", dates => {
        const text = "Exact caption dated 9 September 2026";
        const candidate = normalize([{ kind: "iou", amount: 50, currency: "EGP", note: "Image memo",
            image_heading: "Category", ...dates }], { text })[0];
        expect(candidate.note).toBe("Image memo");
        expect(candidate.image_heading).toBe("Category");
        for (const key of ["date", "interval_start", "interval_end", "printed_date", "printed_end_date"]) {
            expect(candidate).not.toHaveProperty(key);
        }
        const { form, confirmed } = project(candidate);
        expect(form.date).toBe("");
        expect(confirmed).not.toHaveProperty("date");
        expect(confirmed.note).toBe("Image memo");
    });
    it("preserves valid full endpoints while the card appends them to the model note once", () => {
        const text = "  User's purpose  ";
        const candidate = normalize([{ ...baseline, kind: "iou", printed_date: "19 Jul 2026", printed_end_date: "6 Aug 2026" }], { text })[0];
        expect(candidate.note).toBe(baseline.note);
        expect(candidate).toMatchObject({ interval_start: "19 Jul 2026", interval_end: "6 Aug 2026", date: "2026-07-19" });
        expect(project(candidate).confirmed.note).toBe(`${baseline.note} | From 19 Jul 2026 to 6 Aug 2026`);
    });
});
