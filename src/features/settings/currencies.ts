// Shared currency lists + ordering used in every picker (sheet creation, entry
// form, default-currency setting, transaction types). ISO 4217 codes, uppercase.

// A short "common" set (kept for callers that want a quick shortlist).
export const COMMON_CURRENCIES = [
  "USD",
  "EUR",
  "EGP",
  "GBP",
  "JPY",
  "AUD",
  "CAD",
  "CHF",
];

// Full ISO 4217 active currency codes. Not exhaustive of every obscure/legacy
// code, but covers the circulating currencies people actually transact in.
export const ISO_CURRENCIES: string[] = [
  "AED", "AFN", "ALL", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN",
  "BAM", "BBD", "BDT", "BGN", "BHD", "BIF", "BMD", "BND", "BOB", "BRL",
  "BSD", "BTN", "BWP", "BYN", "BZD", "CAD", "CDF", "CHF", "CLP", "CNY",
  "COP", "CRC", "CUP", "CVE", "CZK", "DJF", "DKK", "DOP", "DZD", "EGP",
  "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GHS", "GIP", "GMD",
  "GNF", "GTQ", "GYD", "HKD", "HNL", "HRK", "HTG", "HUF", "IDR", "ILS",
  "INR", "IQD", "IRR", "ISK", "JMD", "JOD", "JPY", "KES", "KGS", "KHR",
  "KMF", "KPW", "KRW", "KWD", "KYD", "KZT", "LAK", "LBP", "LKR", "LRD",
  "LSL", "LYD", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRU",
  "MUR", "MVR", "MWK", "MXN", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK",
  "NPR", "NZD", "OMR", "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "PYG",
  "QAR", "RON", "RSD", "RUB", "RWF", "SAR", "SBD", "SCR", "SDG", "SEK",
  "SGD", "SHP", "SLE", "SOS", "SRD", "SSP", "STN", "SVC", "SYP", "SZL",
  "THB", "TJS", "TMT", "TND", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH",
  "UGX", "USD", "UYU", "UZS", "VED", "VES", "VND", "VUV", "WST", "XAF",
  "XCD", "XOF", "XPF", "YER", "ZAR", "ZMW", "ZWL",
];

// Options for a currency picker: `defaultCode` first (when given), then the big
// three (USD, EUR, GBP), then every other code (ISO_CURRENCIES ∪ `extra`) in
// alphabetical order. Deduped and uppercased. `extra` folds in any sheet-local
// codes not in the ISO list so nothing already in use ever disappears.
export function orderedCurrencies(defaultCode?: string, extra: string[] = []): string[] {
  const norm = (c: string) => c.trim().toUpperCase();
  const pool = new Set<string>(ISO_CURRENCIES);
  for (const c of extra) {
    const u = norm(c);
    if (u) pool.add(u);
  }
  const def = defaultCode ? norm(defaultCode) : undefined;
  if (def) pool.add(def);

  const seen = new Set<string>();
  const head: string[] = [];
  const push = (c?: string) => {
    if (c && pool.has(c) && !seen.has(c)) {
      seen.add(c);
      head.push(c);
    }
  };
  push(def);
  for (const p of ["USD", "EUR", "GBP"]) push(p);
  const rest = [...pool].filter((c) => !seen.has(c)).sort();
  return [...head, ...rest];
}
