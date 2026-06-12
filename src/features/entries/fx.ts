// FX rate fetcher (no cache by design — see docs/01-spec).
//
// Frankfurter.app is a free, no-key, ECB-backed FX API. We hit it
// once per "convert" toggle click. If the user is offline or the API
// is down, we surface a clean error in the form.

const FRANKFURTER_BASE = "https://api.frankfurter.app/latest";

export type FxRate = {
  base: string;
  quote: string;
  rate: number;
  fetchedAt: number;
  source: "frankfurter.app";
};

export async function fetchRate(
  from: string,
  to: string,
): Promise<FxRate> {
  if (from === to) {
    return {
      base: from,
      quote: to,
      rate: 1,
      fetchedAt: Date.now(),
      source: "frankfurter.app",
    };
  }
  const url = `${FRANKFURTER_BASE}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`FX fetch failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { rates?: Record<string, number> };
  const rate = json.rates?.[to];
  if (typeof rate !== "number") {
    throw new Error(`FX rate missing in response for ${from}->${to}`);
  }
  return {
    base: from,
    quote: to,
    rate,
    fetchedAt: Date.now(),
    source: "frankfurter.app",
  };
}
