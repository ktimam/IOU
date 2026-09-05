// IOU owns deterministic source interpretation. These helpers execute inside the app surface;
// OpenChat receives only bounded candidate objects through the generic extraction protocol.
type SafePropertySchema = Record<string, unknown>;
const MAX_AI_ACTION_CANDIDATES = 32;
const MAX_AI_ACTION_MESSAGE_SCAN_CHARS = 10_000;
const MAX_AI_ACTION_RULE_STRING_LENGTH = 64;
const MAX_AI_ACTION_KEYWORDS_PER_MAPPING = 50;
const SAFE_AI_ACTION_FIELD = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const FORBIDDEN_AI_ACTION_FIELDS = new Set(["__proto__", "prototype", "constructor"]);
const AI_ACTION_WORD_CHAR = /[\p{L}\p{N}]/u;
const DISPLAY_CONTROL = /[\p{Cc}\p{Cf}]/u;
const INVALID_SCHEMA_VALUE = Symbol("invalid-schema-value");
function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isSafeAiActionFieldName(field: string): boolean {
    return SAFE_AI_ACTION_FIELD.test(field) && !FORBIDDEN_AI_ACTION_FIELDS.has(field);
}

function isBoundedRuleString(value: string): boolean {
    return (
        value.length > 0 &&
        value.length <= MAX_AI_ACTION_RULE_STRING_LENGTH &&
        !DISPLAY_CONTROL.test(value)
    );
}

function isStrictCalendarDate(value: string): boolean {
    if (value.length !== 10 || value[4] !== "-" || value[7] !== "-") return false;
    for (let index = 0; index < value.length; index++) {
        if (index === 4 || index === 7) continue;
        const code = value.charCodeAt(index);
        if (code < 48 || code > 57) return false;
    }
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(5, 7));
    const day = Number(value.slice(8, 10));
    if (year < 1 || month < 1 || month > 12 || day < 1) return false;
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return day <= daysInMonth[month - 1];
}

const ENGLISH_MONTH_NUMBER: Readonly<Record<string, string>> = Object.freeze({
    jan: "01",
    january: "01",
    feb: "02",
    february: "02",
    mar: "03",
    march: "03",
    apr: "04",
    april: "04",
    may: "05",
    jun: "06",
    june: "06",
    jul: "07",
    july: "07",
    aug: "08",
    august: "08",
    sep: "09",
    sept: "09",
    september: "09",
    oct: "10",
    october: "10",
    nov: "11",
    november: "11",
    dec: "12",
    december: "12",
});

// Models commonly preserve a visibly labelled receipt date while also preserving its display
// format and time. Apps must opt in per field. Only ISO dates and unambiguous English month-name
// dates are accepted; numeric day/month strings such as 04/07/2026 deliberately remain invalid.
function normalizeUnambiguousCalendarDate(value: string): string | undefined {
    if (value.length > 96) return undefined;
    const trimmed = value.trim().replace(/^date\s*:\s*/iu, "");
    if (isStrictCalendarDate(trimmed)) return trimmed;
    const match =
        /^(\d{1,2})\s+([a-z]{3,9})\s+(\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?)?$/iu.exec(
            trimmed,
        );
    if (match === null) return undefined;
    const month = ENGLISH_MONTH_NUMBER[match[2].toLowerCase()];
    if (month === undefined) return undefined;
    const normalized = `${match[3]}-${month}-${match[1].padStart(2, "0")}`;
    return isStrictCalendarDate(normalized) ? normalized : undefined;
}

const SOURCE_ENGLISH_MONTH_PATTERN = Object.keys(ENGLISH_MONTH_NUMBER)
    .sort((left, right) => right.length - left.length)
    .join("|");
const SOURCE_DATE_YEAR_PATTERN = "(?:1[6-9]|2[0-4])\\d{2}";

type SourceInterval =
    | { kind: "none" | "ambiguous" }
    | { kind: "interval"; start: string; end: string };

/** Resolve a single explicit source interval without relying on a transaction's type or label. */
export function sourceIntervalFromText(value: string, calendarAnchor?: Date): SourceInterval {
    if (value.length > MAX_AI_ACTION_MESSAGE_SCAN_CHARS) return { kind: "ambiguous" };
    const intervals: { start: string | undefined; end: string | undefined }[] = [];
    const anchorYear = calendarAnchor !== undefined && Number.isFinite(calendarAnchor.getTime())
        ? String(calendarAnchor.getFullYear()).padStart(4, "0")
        : undefined;
    const namedEndpoint = (day: string, month: string, year: string | undefined) => {
        const monthNumber = ENGLISH_MONTH_NUMBER[month.toLowerCase()];
        if (year === undefined || monthNumber === undefined) return undefined;
        const date = `${year}-${monthNumber}-${day.padStart(2, "0")}`;
        return isStrictCalendarDate(date) ? date : undefined;
    };
    const separator = "[\\t ]*(?:[-\\u2013\\u2014]|\\bto\\b)[\\t ]*";
    const day = "(\\d{1,2})(?:st|nd|rd|th)?";
    const month = `(${SOURCE_ENGLISH_MONTH_PATTERN})\\.?`;
    const year = `(?:[\\t ]*,?[\\t ]+(${SOURCE_DATE_YEAR_PATTERN}))?`;
    const endBoundary = "\\b(?![\\d:/-])";
    for (const match of value.matchAll(
        /\b(\d{4}-\d{2}-\d{2})[\t ]*(?:[-\u2013\u2014]|\bto\b)[\t ]*(\d{4}-\d{2}-\d{2})\b(?![\d:/-])/giu,
    )) {
        intervals.push({
            start: isStrictCalendarDate(match[1]) ? match[1] : undefined,
            end: isStrictCalendarDate(match[2]) ? match[2] : undefined,
        });
    }
    // Same-month shorthand in either printed ordering: "August 6–10" or "6–10 August".
    for (const match of value.matchAll(new RegExp(`\\b${month}[\\t ]+${day}${separator}${day}${year}${endBoundary}`, "giu"))) {
        const resolvedYear = match[4] ?? anchorYear;
        intervals.push({ start: namedEndpoint(match[2], match[1], resolvedYear), end: namedEndpoint(match[3], match[1], resolvedYear) });
    }
    for (const match of value.matchAll(new RegExp(`\\b${day}${separator}${day}[\\t ]+${month}${year}${endBoundary}`, "giu"))) {
        const resolvedYear = match[4] ?? anchorYear;
        intervals.push({ start: namedEndpoint(match[1], match[3], resolvedYear), end: namedEndpoint(match[2], match[3], resolvedYear) });
    }
    // Fully written endpoints may span months. A supplied year applies to both endpoints when
    // only one endpoint prints it; otherwise use the authoritative source calendar year.
    for (const match of value.matchAll(new RegExp(`\\b${month}[\\t ]+${day}${year}${separator}${month}[\\t ]+${day}${year}${endBoundary}`, "giu"))) {
        intervals.push({
            start: namedEndpoint(match[2], match[1], match[3] ?? match[6] ?? anchorYear),
            end: namedEndpoint(match[5], match[4], match[6] ?? match[3] ?? anchorYear),
        });
    }
    for (const match of value.matchAll(new RegExp(`\\b${day}[\\t ]+${month}${year}${separator}${day}[\\t ]+${month}${year}${endBoundary}`, "giu"))) {
        intervals.push({
            start: namedEndpoint(match[1], match[2], match[3] ?? match[6] ?? anchorYear),
            end: namedEndpoint(match[4], match[5], match[6] ?? match[3] ?? anchorYear),
        });
    }
    if (intervals.length === 0) return { kind: "none" };
    if (intervals.length !== 1) return { kind: "ambiguous" };
    const { start, end } = intervals[0];
    if (start === undefined || end === undefined || end < start) return { kind: "ambiguous" };
    return { kind: "interval", start, end };
}

function normalizedSourceMonthDate(
    dayText: string,
    rangeEndText: string | undefined,
    monthText: string,
    yearText: string | undefined,
    calendarAnchor: Date | undefined,
): string | undefined {
    const month = ENGLISH_MONTH_NUMBER[monthText.toLowerCase()];
    const year =
        yearText !== undefined
            ? yearText
            : calendarAnchor !== undefined && Number.isFinite(calendarAnchor.getTime())
              ? String(calendarAnchor.getFullYear()).padStart(4, "0")
              : undefined;
    if (month === undefined || year === undefined) return undefined;

    const day = Number(dayText);
    const normalized = `${year}-${month}-${String(day).padStart(2, "0")}`;
    if (!isStrictCalendarDate(normalized)) return undefined;
    if (rangeEndText !== undefined) {
        const rangeEnd = Number(rangeEndText);
        const normalizedEnd = `${year}-${month}-${String(rangeEnd).padStart(2, "0")}`;
        if (!isStrictCalendarDate(normalizedEnd) || rangeEnd < day) return undefined;
    }
    return normalized;
}

// Extract one deterministic date from authoritative message text. This deliberately recognizes
// only forms whose ordering is unambiguous: ISO, English month names (including a range whose start
// is the transaction date), and explicit relative day words. Numeric-only dates remain model-owned
// because 03/08 is locale-dependent. A year-less or relative date requires the same local calendar
// anchor that the app explicitly opted into via its context/today rule.
function unambiguousDateFromText(
    value: string,
    calendarAnchor: Date | undefined,
): string | undefined {
    const text = value.slice(0, MAX_AI_ACTION_MESSAGE_SCAN_CHARS);
    const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/u.exec(text);
    if (iso !== null) {
        const normalized = `${iso[1]}-${iso[2]}-${iso[3]}`;
        if (isStrictCalendarDate(normalized)) return normalized;
    }

    const dayFirst = new RegExp(
        `\\b(\\d{1,2})(?:st|nd|rd|th)?(?:[\\t ]*[-\\u2013\\u2014][\\t ]*(\\d{1,2})(?:st|nd|rd|th)?)?[\\t ]+(${SOURCE_ENGLISH_MONTH_PATTERN})\\.?(?:[\\t ]*,?[\\t ]*(${SOURCE_DATE_YEAR_PATTERN}))?\\b`,
        "iu",
    ).exec(text);
    if (dayFirst !== null) {
        const normalized = normalizedSourceMonthDate(
            dayFirst[1],
            dayFirst[2],
            dayFirst[3],
            dayFirst[4],
            calendarAnchor,
        );
        if (normalized !== undefined) return normalized;
    }

    const monthFirst = new RegExp(
        `\\b(${SOURCE_ENGLISH_MONTH_PATTERN})\\.?[\\t ]+(\\d{1,2})(?:st|nd|rd|th)?(?:[\\t ]*[-\\u2013\\u2014][\\t ]*(\\d{1,2})(?:st|nd|rd|th)?)?(?:[\\t ]*,?[\\t ]*(${SOURCE_DATE_YEAR_PATTERN}))?\\b`,
        "iu",
    ).exec(text);
    if (monthFirst !== null) {
        const normalized = normalizedSourceMonthDate(
            monthFirst[2],
            monthFirst[3],
            monthFirst[1],
            monthFirst[4],
            calendarAnchor,
        );
        if (normalized !== undefined) return normalized;
    }

    if (calendarAnchor === undefined || !Number.isFinite(calendarAnchor.getTime()))
        return undefined;
    const relative = /\b(today|tomorrow|yesterday)\b/iu.exec(text)?.[1].toLowerCase();
    if (relative === undefined) return undefined;
    const delta = relative === "tomorrow" ? 1 : relative === "yesterday" ? -1 : 0;
    const date = new Date(
        calendarAnchor.getFullYear(),
        calendarAnchor.getMonth(),
        calendarAnchor.getDate() + delta,
        12,
    );
    return formatLocalCalendarDate(date);
}

function conformsToSafeStringFormat(format: unknown, value: string): boolean {
    switch (format) {
        case "date":
            return isStrictCalendarDate(value);
        case "ascii-uppercase":
            return [...value].every((character) => {
                const code = character.charCodeAt(0);
                return code >= 65 && code <= 90;
            });
        case "no-nul":
            return !value.includes(String.fromCharCode(0));
        case "utf8-no-nul": {
            // JavaScript strings may contain lone UTF-16 surrogates, but Rust/serde strings and
            // Candid text are Unicode scalar values. Reject them here so exact-card provenance
            // cannot be minted for bytes the app boundary is structurally unable to decode.
            for (let index = 0; index < value.length; index++) {
                const code = value.charCodeAt(index);
                if (code === 0) return false;
                if (code >= 0xd800 && code <= 0xdbff) {
                    if (index + 1 >= value.length) return false;
                    const next = value.charCodeAt(index + 1);
                    if (next < 0xdc00 || next > 0xdfff) return false;
                    index++;
                } else if (code >= 0xdc00 && code <= 0xdfff) {
                    return false;
                }
            }
            return true;
        }
        default:
            // JSON Schema permits implementation-defined formats. Unknown formats remain annotations.
            return true;
    }
}

function conformPropertyValue(value: unknown, p: SafePropertySchema): unknown {
    let conformed = value;
    if (conformed === INVALID_SCHEMA_VALUE) return INVALID_SCHEMA_VALUE;
    if (
        p["x-iou-normalize-date"] === true &&
        p.format === "date" &&
        typeof conformed === "string"
    ) {
        const normalized = normalizeUnambiguousCalendarDate(conformed);
        if (normalized === undefined) return INVALID_SCHEMA_VALUE;
        conformed = normalized;
    }
    if (p.type === "number" && typeof conformed !== "number") return INVALID_SCHEMA_VALUE;
    if (p.type === "string" && typeof conformed !== "string") return INVALID_SCHEMA_VALUE;
    if (Array.isArray(p.enum) && !p.enum.some((entry) => entry === conformed)) {
        return INVALID_SCHEMA_VALUE;
    }
    // Numeric lower bounds constrain number values only, exactly like JSON schema. A model can
    // emit a degenerate value that IS the declared type (e.g. amount 0 against exclusiveMinimum
    // 0, live-reproduced from the message "hi") — deleting it here lets the required-fields
    // check refuse the whole extraction instead of posting an unusable card.
    if (typeof p.minimum === "number" && typeof conformed === "number" && conformed < p.minimum) {
        return INVALID_SCHEMA_VALUE;
    }
    if (
        typeof p.exclusiveMinimum === "number" &&
        typeof conformed === "number" &&
        conformed <= p.exclusiveMinimum
    ) {
        return INVALID_SCHEMA_VALUE;
    }
    if (typeof p.maximum === "number" && typeof conformed === "number" && conformed > p.maximum) {
        return INVALID_SCHEMA_VALUE;
    }
    if (typeof conformed === "string") {
        const length = [...conformed].length;
        if (
            typeof p.minLength === "number" &&
            Number.isSafeInteger(p.minLength) &&
            p.minLength >= 0 &&
            length < p.minLength
        ) {
            return INVALID_SCHEMA_VALUE;
        }
        if (
            typeof p.maxLength === "number" &&
            Number.isSafeInteger(p.maxLength) &&
            p.maxLength >= 0 &&
            length > p.maxLength
        ) {
            return INVALID_SCHEMA_VALUE;
        }
        if (!conformsToSafeStringFormat(p.format, conformed)) return INVALID_SCHEMA_VALUE;
    }
    // Manifest patterns are untrusted and JavaScript's backtracking RegExp engine has no timeout.
    // Fail closed for any patterned field rather than execute a potential ReDoS expression such
    // as `(a+)+$`. A future implementation may re-enable patterns through a bounded RE2 engine.
    if (typeof p.pattern === "string") return INVALID_SCHEMA_VALUE;
    return conformed;
}

export function formatLocalCalendarDate(
    date: Pick<Date, "getFullYear" | "getMonth" | "getDate">,
): string {
    const year = String(date.getFullYear()).padStart(4, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function isWholeKeywordAt(text: string, index: number, length: number): boolean {
    let before = "";
    if (index > 0) {
        let beforeStart = index - 1;
        const last = text.charCodeAt(beforeStart);
        if (
            last >= 0xdc00 &&
            last <= 0xdfff &&
            beforeStart > 0 &&
            text.charCodeAt(beforeStart - 1) >= 0xd800 &&
            text.charCodeAt(beforeStart - 1) <= 0xdbff
        ) {
            beforeStart--;
        }
        before = text.slice(beforeStart, index);
    }
    const afterIndex = index + length;
    const after =
        afterIndex >= text.length ? "" : String.fromCodePoint(text.codePointAt(afterIndex) ?? 0);
    return !AI_ACTION_WORD_CHAR.test(before) && !AI_ACTION_WORD_CHAR.test(after);
}

export function matchesKeyword(text: string, keyword: string): boolean {
    if (!isBoundedRuleString(keyword)) return false;
    const haystack = text.slice(0, MAX_AI_ACTION_MESSAGE_SCAN_CHARS).toLowerCase();
    const needle = keyword.toLowerCase();
    let from = 0;
    while (from <= haystack.length - needle.length) {
        const index = haystack.indexOf(needle, from);
        if (index < 0) return false;
        if (isWholeKeywordAt(haystack, index, needle.length)) return true;
        from = index + Math.max(needle.length, 1);
    }
    return false;
}

export function applyTextDateSchemaProperties(
    extraction: Record<string, unknown>,
    schema: object | undefined,
    messageText: string,
    candidateCount: number | undefined,
    calendarAnchor: Date | undefined,
    messageTimestampAnchor: Date | undefined,
): Record<string, unknown> {
    if (schema === undefined || candidateCount !== 1) return extraction;
    const props: unknown = (schema as { properties?: unknown }).properties;
    if (props === null || typeof props !== "object" || Array.isArray(props)) return extraction;

    const out = { ...extraction };
    for (const [field, rawProperty] of Object.entries(props as Record<string, unknown>)) {
        if (
            !isSafeAiActionFieldName(field) ||
            rawProperty === null ||
            typeof rawProperty !== "object" ||
            Array.isArray(rawProperty)
        ) {
            continue;
        }
        const property = rawProperty as SafePropertySchema;
        if (
            property.type !== "string" ||
            property.format !== "date"
        ) {
            continue;
        }
        const explicit =
            property["x-iou-date-from-text"] === true
                ? unambiguousDateFromText(messageText, calendarAnchor)
                : undefined;
        const timestampKeywords = property[
            "x-iou-date-from-message-timestamp-keywords"
        ];
        const timestampFallback =
            explicit === undefined &&
            messageTimestampAnchor !== undefined &&
            Number.isFinite(messageTimestampAnchor.getTime()) &&
            Array.isArray(timestampKeywords) &&
            timestampKeywords.length > 0 &&
            timestampKeywords.length <= MAX_AI_ACTION_KEYWORDS_PER_MAPPING &&
            timestampKeywords.every(
                (keyword): keyword is string =>
                    typeof keyword === "string" && isBoundedRuleString(keyword),
            ) &&
            timestampKeywords.some((keyword) => matchesKeyword(messageText, keyword))
                ? formatLocalCalendarDate(messageTimestampAnchor)
                : undefined;
        const derived = explicit ?? timestampFallback;
        if (derived === undefined) continue;
        const conformed = conformPropertyValue(derived, property);
        if (conformed !== INVALID_SCHEMA_VALUE) out[field] = conformed;
    }
    return out;
}

type DeclaredTextSequence = {
    numberField: string;
    labelField: string;
    minimumItems: number;
    anchors: string[];
    unanchoredMode?: "whole_message";
    unanchoredLabels?: ReadonlySet<string>;
    numberSchema: SafePropertySchema;
    labelSchema: SafePropertySchema;
};

export type ParsedTextSequence =
    | { kind: "none" }
    | { kind: "overflow" }
    | { kind: "candidates"; candidates: Record<string, unknown>[] };

const TEXT_SEQUENCE_EXTENSION = "x-iou-text-sequence";
const TEXT_SEQUENCE_REQUIRED_OPTION_KEYS = ["anchors", "labelField", "minimumItems", "numberField"];
const TEXT_SEQUENCE_OPTION_KEYS = new Set([
    ...TEXT_SEQUENCE_REQUIRED_OPTION_KEYS,
    "unanchoredLabels",
    "unanchoredMode",
]);
const MAX_TEXT_SEQUENCE_ANCHORS = 16;
const MAX_UNANCHORED_TEXT_SEQUENCE_LABELS = 50;
const MAX_WHOLE_MESSAGE_SEQUENCE_LABEL_WORDS = 4;
const TEXT_SEQUENCE_AMOUNT =
    /(^|[^\p{L}\p{N}.,])((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(?=$|[^\p{L}\p{N}.,])/gu;
const TEXT_SEQUENCE_LABEL = /^[\p{L}\p{M}]+(?:[ '\u2019-]+[\p{L}\p{M}]+)*$/u;
const TEXT_SEQUENCE_ANCHOR = /^[A-Za-z]+(?:[ '-]+[A-Za-z]+)*$/;
const TEXT_SEQUENCE_MONTH =
    "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const TEXT_SEQUENCE_MONTH_DATE = new RegExp(
    `(?:\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${TEXT_SEQUENCE_MONTH}\\b|\\b${TEXT_SEQUENCE_MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b)`,
    "iu",
);
const TEXT_SEQUENCE_ISO_CURRENCY_CODES = new Set(
    (
        "AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND " +
        "BOB BOV BRL BSD BTN BWP BYN BZD CAD CDF CHE CHF CHW CLF CLP CNY COP COU " +
        "CRC CUC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS " +
        "GIP GMD GNF GTQ GYD HKD HNL HRK HTG HUF IDR ILS INR IQD IRR ISK JMD JOD " +
        "JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL " +
        "MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MXV MYR MZN NAD NGN NIO NOK NPR " +
        "NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK " +
        "SGD SHP SLE SLL SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD " +
        "TZS UAH UGX USD USN UYI UYU UYW UZS VED VES VND VUV WST XAF XAG XAU XBA " +
        "XBB XBC XBD XCD XDR XOF XPD XPF XPT XSU XTS XUA XXX YER ZAR ZMW ZWG ZWL"
    ).split(" "),
);
const TEXT_SEQUENCE_CURRENCY_WORD =
    /\b(?:currenc(?:y|ies)|dinars?|dirhams?|dollars?|euros?|francs?|pounds?|pesos?|riyals?|rupees?|sterling|yen|yuan)\b/iu;
const TEXT_SEQUENCE_ID_CONTEXT =
    /\b(?:account|confirmation|invoice|inv|receipt|reference|ref|transaction)\s*(?:(?:id|no|number)\b|[#:]|\d)/iu;
const TEXT_SEQUENCE_QUANTITY_CONTEXT =
    /\b(?:days?|grams?|hours?|items?|kgs?|kilograms?|lbs?|liters?|litres?|milliliters?|nights?|pcs|pieces?|quantit(?:y|ies)|qty|rides?|tickets?|units?)\b/iu;

function declaredTextSequence(schema: object | undefined): DeclaredTextSequence | undefined {
    if (!isRecord(schema)) return undefined;
    const extension = schema[TEXT_SEQUENCE_EXTENSION];
    if (!isRecord(extension)) return undefined;
    const optionKeys = Object.keys(extension);
    if (
        TEXT_SEQUENCE_REQUIRED_OPTION_KEYS.some((key) => !optionKeys.includes(key)) ||
        optionKeys.some((key) => !TEXT_SEQUENCE_OPTION_KEYS.has(key))
    ) {
        return undefined;
    }
    const { numberField, labelField, minimumItems, anchors, unanchoredMode, unanchoredLabels } =
        extension;
    if (
        typeof numberField !== "string" ||
        typeof labelField !== "string" ||
        !isSafeAiActionFieldName(numberField) ||
        !isSafeAiActionFieldName(labelField) ||
        numberField === labelField ||
        typeof minimumItems !== "number" ||
        !Number.isInteger(minimumItems) ||
        minimumItems < 2 ||
        minimumItems > MAX_AI_ACTION_CANDIDATES ||
        !Array.isArray(anchors) ||
        anchors.length === 0 ||
        anchors.length > MAX_TEXT_SEQUENCE_ANCHORS ||
        (unanchoredMode !== undefined && unanchoredMode !== "whole_message")
    ) {
        return undefined;
    }
    const safeAnchors: string[] = [];
    const seenAnchors = new Set<string>();
    for (const anchor of anchors) {
        if (
            typeof anchor !== "string" ||
            anchor !== anchor.trim() ||
            !isBoundedRuleString(anchor) ||
            !TEXT_SEQUENCE_ANCHOR.test(anchor) ||
            seenAnchors.has(anchor.toLowerCase())
        ) {
            return undefined;
        }
        seenAnchors.add(anchor.toLowerCase());
        safeAnchors.push(anchor);
    }
    let safeUnanchoredLabels: Set<string> | undefined;
    if (unanchoredMode === undefined) {
        if (unanchoredLabels !== undefined) return undefined;
    } else {
        if (
            !Array.isArray(unanchoredLabels) ||
            unanchoredLabels.length === 0 ||
            unanchoredLabels.length > MAX_UNANCHORED_TEXT_SEQUENCE_LABELS
        ) {
            return undefined;
        }
        safeUnanchoredLabels = new Set<string>();
        for (const label of unanchoredLabels) {
            if (
                typeof label !== "string" ||
                label !== label.trim() ||
                !isBoundedRuleString(label) ||
                !TEXT_SEQUENCE_LABEL.test(label) ||
                label.split(/\s+/u).length > MAX_WHOLE_MESSAGE_SEQUENCE_LABEL_WORDS
            ) {
                return undefined;
            }
            const normalized = label.normalize("NFKC").toLowerCase();
            if (!isBoundedRuleString(normalized) || safeUnanchoredLabels.has(normalized)) {
                return undefined;
            }
            safeUnanchoredLabels.add(normalized);
        }
    }
    const properties = schema.properties;
    const required = schema.required;
    if (!isRecord(properties) || !Array.isArray(required) || !required.includes(numberField)) {
        return undefined;
    }
    const numberSchema = properties[numberField];
    const labelSchema = properties[labelField];
    if (
        !isRecord(numberSchema) ||
        numberSchema.type !== "number" ||
        !isRecord(labelSchema) ||
        labelSchema.type !== "string"
    ) {
        return undefined;
    }
    return {
        numberField,
        labelField,
        minimumItems,
        anchors: safeAnchors,
        ...(unanchoredMode === "whole_message" ? { unanchoredMode } : {}),
        ...(safeUnanchoredLabels === undefined ? {} : { unanchoredLabels: safeUnanchoredLabels }),
        numberSchema,
        labelSchema,
    };
}

function textSequenceContainsCurrencyCode(text: string, anchors: readonly string[]): boolean {
    const anchorWords = new Set(
        anchors.flatMap((anchor) => anchor.toLowerCase().match(/[a-z]+/g) ?? []),
    );
    for (const match of text.matchAll(/\b[A-Za-z]{3}\b/gu)) {
        const token = match[0];
        if (
            TEXT_SEQUENCE_ISO_CURRENCY_CODES.has(token.toUpperCase()) ||
            (token === token.toUpperCase() && !anchorWords.has(token.toLowerCase()))
        ) {
            return true;
        }
    }
    return false;
}

function textSequenceHasDisallowedNumericContext(
    text: string,
    anchors: readonly string[],
): boolean {
    return (
        /[\p{Sc}%]/u.test(text) ||
        /\b(?:percent|percentage)\b/iu.test(text) ||
        /\b\d{1,4}\s*[\/-]\s*\d{1,2}(?:\s*[\/-]\s*\d{1,4})?\b/u.test(text) ||
        /\b\d{1,2}\s*:\s*\d{2}\b/u.test(text) ||
        /\b\d{1,2}\s*(?:am|pm)\b/iu.test(text) ||
        /(^|[\s([{:;,])[+-]\s*\d/u.test(text) ||
        TEXT_SEQUENCE_MONTH_DATE.test(text) ||
        textSequenceContainsCurrencyCode(text, anchors) ||
        TEXT_SEQUENCE_CURRENCY_WORD.test(text) ||
        TEXT_SEQUENCE_ID_CONTEXT.test(text) ||
        TEXT_SEQUENCE_QUANTITY_CONTEXT.test(text)
    );
}

function declaredTextSequenceAnchorState(
    text: string,
    anchors: readonly string[],
    firstAmountStart: number,
): { valid: boolean; afterAmount: boolean } {
    const haystack = text.slice(0, MAX_AI_ACTION_MESSAGE_SCAN_CHARS);
    let validAnchor = false;
    let anchorAfterAmount = false;
    for (const declaredAnchor of anchors) {
        const anchor = declaredAnchor.toLowerCase();
        let from = 0;
        while (from <= haystack.length - anchor.length) {
            let start = -1;
            candidateStart: for (
                let index = from;
                index <= haystack.length - anchor.length;
                index++
            ) {
                for (let offset = 0; offset < anchor.length; offset++) {
                    let code = haystack.charCodeAt(index + offset);
                    if (code >= 65 && code <= 90) code += 32;
                    if (code !== anchor.charCodeAt(offset)) continue candidateStart;
                }
                start = index;
                break;
            }
            if (start < 0) break;
            const end = start + anchor.length;
            if (isWholeKeywordAt(haystack, start, anchor.length)) {
                if (start >= firstAmountStart) {
                    anchorAfterAmount = true;
                } else if (
                    !/\p{N}/u.test(text.slice(0, start)) &&
                    /^[^\p{L}\p{N}]*$/u.test(text.slice(end, firstAmountStart))
                ) {
                    validAnchor = true;
                }
            }
            from = start + Math.max(anchor.length, 1);
        }
    }
    return { valid: validAnchor && !anchorAfterAmount, afterAmount: anchorAfterAmount };
}

// A manifest may explicitly opt a TEXT action into a narrow, deterministic fallback for the common
// `command amount label amount label ...` shorthand. The manifest must declare the whole-word command
// anchors explicitly; free words or numbers between an anchor and the first amount make the source
// ambiguous. An app may separately accept an entirely unanchored message, but must then declare a
// bounded allowlist of complete labels: arbitrary quantity lists are structurally indistinguishable
// from monetary rows. This parser never repairs model prose, guesses fields, supplies categorical
// values, or handles images. Everything emitted still passes ordinary rules/defaults/schema checks.
export function parseDeclaredTextSequence(
    schema: object | undefined,
    text: string,
): ParsedTextSequence {
    const declaration = declaredTextSequence(schema);
    if (
        declaration === undefined ||
        text.length === 0 ||
        text.length > MAX_AI_ACTION_MESSAGE_SCAN_CHARS ||
        textSequenceHasDisallowedNumericContext(text, declaration.anchors)
    ) {
        return { kind: "none" };
    }

    const spans: { start: number; end: number; raw: string }[] = [];
    for (const match of text.matchAll(TEXT_SEQUENCE_AMOUNT)) {
        const prefix = match[1] ?? "";
        const raw = match[2];
        if (raw === undefined || match.index === undefined) return { kind: "none" };
        const start = match.index + prefix.length;
        spans.push({ start, end: start + raw.length, raw });
    }
    if (spans.length < declaration.minimumItems) return { kind: "none" };
    const anchor = declaredTextSequenceAnchorState(text, declaration.anchors, spans[0].start);
    const wholeMessage = !anchor.valid;
    if (
        wholeMessage &&
        (declaration.unanchoredMode !== "whole_message" ||
            anchor.afterAmount ||
            !/^[\s,;:|]*$/u.test(text.slice(0, spans[0].start)))
    ) {
        return { kind: "none" };
    }
    if (spans.length > MAX_AI_ACTION_CANDIDATES) return { kind: "overflow" };

    // Every source digit must belong to one recognized amount token. This rejects malformed,
    // embedded, stray and otherwise unaccounted-for numbers instead of silently discarding them.
    const covered = new Uint8Array(text.length);
    for (const span of spans) covered.fill(1, span.start, span.end);
    for (const numeric of text.matchAll(/\p{N}/gu)) {
        if (numeric.index === undefined || covered[numeric.index] !== 1) return { kind: "none" };
    }

    const candidates: Record<string, unknown>[] = [];
    for (let index = 0; index < spans.length; index++) {
        const span = spans[index];
        const nextStart = spans[index + 1]?.start ?? text.length;
        const label = text.slice(span.end, nextStart).replace(/^[\s,;:|]+|[\s,;:|.!?]+$/gu, "");
        if (!TEXT_SEQUENCE_LABEL.test(label)) return { kind: "none" };
        if (
            wholeMessage &&
            (label.trim().split(/\s+/u).length > MAX_WHOLE_MESSAGE_SEQUENCE_LABEL_WORDS ||
                /\.\d{3,}$/u.test(span.raw) ||
                declaration.unanchoredLabels?.has(label.normalize("NFKC").toLowerCase()) !== true)
        ) {
            return { kind: "none" };
        }

        const amount = Number(span.raw.replaceAll(",", ""));
        if (!Number.isFinite(amount) || amount <= 0) return { kind: "none" };
        const conformedAmount = conformPropertyValue(amount, declaration.numberSchema);
        const conformedLabel = conformPropertyValue(label, declaration.labelSchema);
        if (
            conformedAmount === INVALID_SCHEMA_VALUE ||
            conformedAmount !== amount ||
            conformedLabel === INVALID_SCHEMA_VALUE ||
            conformedLabel !== label
        ) {
            return { kind: "none" };
        }
        candidates.push({
            [declaration.numberField]: amount,
            [declaration.labelField]: label,
        });
    }
    return { kind: "candidates", candidates };
}

type DeclaredDelimitedTextSequence = {
    numberField: string;
    labelField: string;
    currencyField: string;
    minimumItems: number;
    numberSchema: SafePropertySchema;
    labelSchema: SafePropertySchema;
    currencySchema: SafePropertySchema;
};

const DELIMITED_TEXT_SEQUENCE_EXTENSION = "x-iou-delimited-text-sequence";
const DELIMITED_TEXT_SEQUENCE_OPTION_KEYS = [
    "currencyField",
    "delimiter",
    "labelField",
    "minimumItems",
    "numberField",
];
const DELIMITED_TEXT_SEQUENCE_ITEM =
    /^(.*?)\s+((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s+([A-Za-z]{3})(?:\s*[.!?])?$/u;
const MAX_DELIMITED_TEXT_SEQUENCE_HEADER_CHARS = 200;

function declaredDelimitedTextSequence(
    schema: object | undefined,
): DeclaredDelimitedTextSequence | undefined {
    if (!isRecord(schema)) return undefined;
    const extension = schema[DELIMITED_TEXT_SEQUENCE_EXTENSION];
    if (!isRecord(extension)) return undefined;
    if (
        Object.keys(extension).sort().join("\0") !== DELIMITED_TEXT_SEQUENCE_OPTION_KEYS.join("\0")
    ) {
        return undefined;
    }
    const { delimiter, numberField, labelField, currencyField, minimumItems } = extension;
    if (
        delimiter !== "semicolon" ||
        typeof numberField !== "string" ||
        typeof labelField !== "string" ||
        typeof currencyField !== "string" ||
        !isSafeAiActionFieldName(numberField) ||
        !isSafeAiActionFieldName(labelField) ||
        !isSafeAiActionFieldName(currencyField) ||
        new Set([numberField, labelField, currencyField]).size !== 3 ||
        typeof minimumItems !== "number" ||
        !Number.isInteger(minimumItems) ||
        minimumItems < 2 ||
        minimumItems > MAX_AI_ACTION_CANDIDATES
    ) {
        return undefined;
    }
    const properties = schema.properties;
    const required = schema.required;
    if (!isRecord(properties) || !Array.isArray(required) || !required.includes(numberField)) {
        return undefined;
    }
    const numberSchema = properties[numberField];
    const labelSchema = properties[labelField];
    const currencySchema = properties[currencyField];
    if (
        !isRecord(numberSchema) ||
        numberSchema.type !== "number" ||
        !isRecord(labelSchema) ||
        labelSchema.type !== "string" ||
        !isRecord(currencySchema) ||
        currencySchema.type !== "string"
    ) {
        return undefined;
    }
    return {
        numberField,
        labelField,
        currencyField,
        minimumItems,
        numberSchema,
        labelSchema,
        currencySchema,
    };
}

// A manifest may opt into a narrow fast path for explicit
// `optional safe header: label amount ISO; label amount ISO; ...` source text. Every segment must
// match in full, so no model value, header word, stray number, identifier or unsupported currency
// can leak into the result. This remains source-only and text-only; rules/defaults supply categorical
// fields afterward exactly as they do for model candidates.
export function parseDeclaredDelimitedTextSequence(
    schema: object | undefined,
    text: string,
): ParsedTextSequence {
    const declaration = declaredDelimitedTextSequence(schema);
    if (
        declaration === undefined ||
        text.length === 0 ||
        text.length > MAX_AI_ACTION_MESSAGE_SCAN_CHARS
    ) {
        return { kind: "none" };
    }

    const segments = text.split(";");
    if (segments.length < declaration.minimumItems) return { kind: "none" };
    if (segments.length > MAX_AI_ACTION_CANDIDATES) return { kind: "overflow" };
    if (segments.some((segment) => segment.trim().length === 0)) return { kind: "none" };

    const firstColon = segments[0].indexOf(":");
    if (firstColon >= 0) {
        if (segments[0].lastIndexOf(":") !== firstColon) return { kind: "none" };
        const header = segments[0].slice(0, firstColon).trim();
        if (
            header.length === 0 ||
            [...header].length > MAX_DELIMITED_TEXT_SEQUENCE_HEADER_CHARS ||
            !TEXT_SEQUENCE_LABEL.test(header)
        ) {
            return { kind: "none" };
        }
        segments[0] = segments[0].slice(firstColon + 1);
    }
    if (segments.some((segment) => segment.includes(":"))) return { kind: "none" };

    const candidates: Record<string, unknown>[] = [];
    for (const segment of segments) {
        const match = DELIMITED_TEXT_SEQUENCE_ITEM.exec(segment.trim());
        if (match === null) return { kind: "none" };
        const label = match[1].trim();
        const rawAmount = match[2];
        const currency = match[3].toUpperCase();
        if (!TEXT_SEQUENCE_LABEL.test(label) || !TEXT_SEQUENCE_ISO_CURRENCY_CODES.has(currency)) {
            return { kind: "none" };
        }
        const amount = Number(rawAmount.replaceAll(",", ""));
        if (!Number.isFinite(amount) || amount <= 0) return { kind: "none" };
        const conformedAmount = conformPropertyValue(amount, declaration.numberSchema);
        const conformedLabel = conformPropertyValue(label, declaration.labelSchema);
        const conformedCurrency = conformPropertyValue(currency, declaration.currencySchema);
        if (
            conformedAmount === INVALID_SCHEMA_VALUE ||
            conformedAmount !== amount ||
            conformedLabel === INVALID_SCHEMA_VALUE ||
            conformedLabel !== label ||
            conformedCurrency === INVALID_SCHEMA_VALUE ||
            conformedCurrency !== currency
        ) {
            return { kind: "none" };
        }
        candidates.push({
            [declaration.numberField]: amount,
            [declaration.labelField]: label,
            [declaration.currencyField]: currency,
        });
    }
    return { kind: "candidates", candidates };
}


/** Normalize visible, unambiguous date values before IOU validates the final canonical draft. */
export function normalizeIouCandidateDates(
    candidate: Record<string, unknown>,
    schema: object | undefined,
): Record<string, unknown> {
    if (!isRecord(schema) || !isRecord(schema.properties)) return { ...candidate };
    const output = { ...candidate };
    for (const [field, property] of Object.entries(schema.properties)) {
        if (!isSafeAiActionFieldName(field) || !isRecord(property)) continue;
        if (property["x-iou-normalize-date"] !== true || property.format !== "date") continue;
        const aliases = property["x-openchat-property-aliases"];
        const values = [field, ...(Array.isArray(aliases) ? aliases.filter((v): v is string => typeof v === "string") : [])]
            .filter((key) => Object.hasOwn(candidate, key))
            .map((key) => candidate[key]);
        if (values.length === 0) continue;
        if (!values.every((value) => Object.is(value, values[0]))) {
            delete output[field];
            continue;
        }
        const normalized = typeof values[0] === "string" ? normalizeUnambiguousCalendarDate(values[0]) : undefined;
        if (normalized === undefined) delete output[field];
        else output[field] = normalized;
    }
    return output;
}
