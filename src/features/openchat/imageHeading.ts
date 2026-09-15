/** Public image evidence retained only until IOU's private, row-local type matching. */
export const IOU_IMAGE_HEADING_MAX_CODEPOINTS = 200;

export function validateImageHeading(value: unknown): string | undefined {
    if (typeof value !== "string" || /[\p{Cc}\u2028\u2029]/u.test(value)) return undefined;
    const heading = value.trim();
    return heading !== "" && [...heading].length <= IOU_IMAGE_HEADING_MAX_CODEPOINTS
        ? heading
        : undefined;
}
