// IOU-owned date evidence. Endpoint values must be dates, not the labels of the rows that
// contain them. The original spelling is retained for the editable note; any inferred year
// must be justified separately before it can populate the canonical Date field.
const MAX_ENDPOINT_LENGTH = 96;
type Endpoint = { month: number; day: number; year?: number; weekday?: number };
export type ValidatedSourceInterval = { start: string; end: string; date?: string };

const MONTHS = new Map([
  ["jan", 1], ["feb", 2], ["mar", 3], ["apr", 4], ["may", 5], ["jun", 6],
  ["jul", 7], ["aug", 8], ["sep", 9], ["oct", 10], ["nov", 11], ["dec", 12],
]);
const WEEKDAYS = new Map([
  ["sun", 0], ["mon", 1], ["tue", 2], ["wed", 3], ["thu", 4], ["fri", 5], ["sat", 6],
]);
const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const WEEKDAY = "(?:(sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)\\.?\\s*,?\\s+)?";
const DAY = "(\\d{1,2})(?:st|nd|rd|th)?";
const YEAR = "(?:(?:\\s*,\\s*|\\s+)(\\d{4}))?";
const MONTH_FIRST = new RegExp(`^${WEEKDAY}${MONTH}\\s+${DAY}${YEAR}$`, "iu");
const DAY_FIRST = new RegExp(`^${WEEKDAY}${DAY}\\s+${MONTH}${YEAR}$`, "iu");

function boundedEndpoint(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text !== "" && text.length <= MAX_ENDPOINT_LENGTH && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(text)
    ? text : undefined;
}

function endpointTime(endpoint: Endpoint, year: number): number | undefined {
  const value = new Date(Date.UTC(year, endpoint.month - 1, endpoint.day));
  return value.getUTCFullYear() === year && value.getUTCMonth() === endpoint.month - 1 &&
    value.getUTCDate() === endpoint.day &&
    (endpoint.weekday === undefined || value.getUTCDay() === endpoint.weekday)
    ? value.getTime() : undefined;
}

function parseEndpoint(text: string): Endpoint | undefined {
  const iso = /^(19\d{2}|20\d{2}|21\d{2}|2200)-(\d{2})-(\d{2})$/u.exec(text);
  let endpoint: Endpoint;
  if (iso !== null) {
    endpoint = { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
  } else {
    const monthFirst = MONTH_FIRST.exec(text);
    const dayFirst = DAY_FIRST.exec(text);
    const monthText = monthFirst?.[2] ?? dayFirst?.[3];
    const dayText = monthFirst?.[3] ?? dayFirst?.[2];
    const yearText = monthFirst?.[4] ?? dayFirst?.[4];
    const weekdayText = monthFirst?.[1] ?? dayFirst?.[1];
    if (monthText === undefined || dayText === undefined) return undefined;
    const month = MONTHS.get(monthText.toLowerCase().slice(0, 3));
    if (month === undefined) return undefined;
    endpoint = {
      month, day: Number(dayText),
      ...(yearText === undefined ? {} : { year: Number(yearText) }),
      ...(weekdayText === undefined ? {} : { weekday: WEEKDAYS.get(weekdayText.toLowerCase().slice(0, 3)) }),
    };
  }
  if (endpoint.year !== undefined) {
    if (endpoint.year < 1900 || endpoint.year > 2200 || endpointTime(endpoint, endpoint.year) === undefined) {
      return undefined;
    }
  } else {
    // A leap calendar validates month/day shape without inventing a source year or rejecting
    // a legitimate yearless February 29. Weekdays are checked only against an anchored year.
    if (endpointTime({ month: endpoint.month, day: endpoint.day }, 2000) === undefined) return undefined;
  }
  return endpoint;
}

function intervalDate(start: Endpoint, end: Endpoint, anchor: Date): string | undefined {
  const crossesYear = end.month * 32 + end.day < start.month * 32 + start.day;
  let startYears: number[];
  if (start.year !== undefined) startYears = [start.year];
  else if (end.year !== undefined) startYears = [end.year - (crossesYear ? 1 : 0)];
  else {
    if ((start.weekday === undefined && end.weekday === undefined) || !Number.isFinite(anchor.getTime())) {
      return undefined;
    }
    const year = anchor.getFullYear();
    startYears = [year - 1, year, year + 1];
  }
  const dates = new Set<string>();
  for (const startYear of startYears) {
    const endYear = end.year ?? startYear + (crossesYear ? 1 : 0);
    if (startYear < 1900 || startYear > 2200 || endYear < 1900 || endYear > 2200) continue;
    const startTime = endpointTime(start, startYear);
    const endTime = endpointTime(end, endYear);
    if (startTime === undefined || endTime === undefined || endTime < startTime) continue;
    dates.add(new Date(startTime).toISOString().slice(0, 10));
  }
  return dates.size === 1 ? [...dates][0] : undefined;
}

/** Validate the complete pair before either endpoint can appear in a synthesized note. */
export function validatedSourceInterval(
  startValue: unknown, endValue: unknown, anchor: Date = new Date(),
): ValidatedSourceInterval | undefined {
  const start = boundedEndpoint(startValue);
  const end = boundedEndpoint(endValue);
  if (start === undefined || end === undefined) return undefined;
  const startDate = parseEndpoint(start);
  const endDate = parseEndpoint(end);
  if (startDate === undefined || endDate === undefined) return undefined;
  const date = intervalDate(startDate, endDate, anchor);
  // An explicit year makes chronology and weekday checks authoritative. An unresolvable
  // yearless pair may still be preserved verbatim, but may not manufacture a canonical date.
  if ((startDate.year !== undefined || endDate.year !== undefined) && date === undefined) return undefined;
  return { start, end, ...(date === undefined ? {} : { date }) };
}

export function dateFromSourceInterval(
  startValue: unknown, endValue: unknown, anchor: Date = new Date(),
): string | undefined {
  return validatedSourceInterval(startValue, endValue, anchor)?.date;
}
