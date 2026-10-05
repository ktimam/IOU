// No client-side rate cache: request a fresh quote when the user asks to convert.
// Frankfurter v2 supplies daily reference rates from multiple official providers.
// Only the currency pair leaves the device; amounts and entry data stay local.
// API contract: https://frankfurter.dev/#rate
const FRANKFURTER_BASE = "https://api.frankfurter.dev/v2/rate";
const REQUEST_TIMEOUT_MS = 10_000;

class FxRequestError extends Error {}

function cancelled(): DOMException {
  return new DOMException("Exchange-rate request cancelled.", "AbortError");
}

export type FxRate = {
  base: string;
  quote: string;
  rate: number;
  fetchedAt: number;
  // Persisted provenance is free text (including legacy labels and "manual").
  // The automatic fetcher below emits only "frankfurter.dev".
  source: string;
};

export async function fetchRate(
  from: string,
  to: string,
  signal?: AbortSignal,
): Promise<FxRate> {
  if (signal?.aborted) throw cancelled();
  from = from.trim().toUpperCase();
  to = to.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) {
    throw new FxRequestError("Choose valid three-letter currencies, or enter the rate manually.");
  }
  if (from === to) {
    return {
      base: from,
      quote: to,
      rate: 1,
      fetchedAt: Date.now(),
      source: "frankfurter.dev",
    };
  }
  const controller = new AbortController();
  let stop!: (reason: Error) => void;
  const interrupted = new Promise<never>((_, reject) => { stop = reject; });
  const onAbort = () => {
    stop(cancelled());
    controller.abort();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => {
    stop(new FxRequestError("Exchange-rate lookup timed out. Retry or enter the rate manually."));
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    // Race the complete operation, including body reading, so a stalled request
    // cannot leave the form loading forever even if its transport ignores abort.
    return await Promise.race([interrupted, (async (): Promise<FxRate> => {
      const res = await fetch(`${FRANKFURTER_BASE}/${from}/${to}`, {
        signal: controller.signal,
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
        redirect: "error",
      });
      if (!res.ok) {
        if ([400, 404, 422].includes(res.status)) {
          throw new FxRequestError(`No automatic rate is available for ${from} to ${to}. Enter the rate manually.`);
        }
        throw new FxRequestError("The exchange-rate provider is unavailable. Retry or enter the rate manually.");
      }
      let json: unknown;
      try {
        json = await res.json();
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new FxRequestError("The provider returned an invalid exchange rate. Retry or enter the rate manually.");
        }
        throw error;
      }
      if (typeof json !== "object" || json === null || Array.isArray(json)) {
        throw new FxRequestError("The provider returned an invalid exchange rate. Retry or enter the rate manually.");
      }
      const quote = json as Record<string, unknown>;
      if (quote.base !== from || quote.quote !== to || typeof quote.rate !== "number"
        || !Number.isFinite(quote.rate) || quote.rate <= 0) {
        throw new FxRequestError("The provider returned an invalid exchange rate. Retry or enter the rate manually.");
      }
      return { base: from, quote: to, rate: quote.rate, fetchedAt: Date.now(), source: "frankfurter.dev" };
    })()]);
  } catch (error) {
    if (signal?.aborted) throw cancelled();
    if (error instanceof FxRequestError) throw error;
    throw new FxRequestError("Could not reach the exchange-rate provider. Check your connection, retry, or enter the rate manually.");
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}
