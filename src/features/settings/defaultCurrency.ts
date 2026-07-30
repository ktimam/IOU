// The user's ONE default currency: canister-backed, browser-cached.
//
// It used to live ONLY in localStorage ("iou:prefs:v1"), so it did not follow the user to another
// device — a second browser silently fell back to "USD". It is now stored per principal on the
// canister (`UserRecord.default_currency`, set via `set_default_currency`) with localStorage kept as a
// fast cache so pickers render instantly before the query lands.
//
// This module is the pure half — no actor, no React — so the precedence rules are unit-testable.
// DefaultCurrencySync owns the actual round trip.

/** The fallback when neither the canister nor the cache has a usable code. */
export const FALLBACK_CURRENCY = "USD";

const ISO_RE = /^[A-Z]{3}$/;

/**
 * A trimmed, uppercased 3-letter ISO code, or undefined for anything else (empty, junk, a candid
 * `opt` that came back as `[]`, a number, …). Both sides of the sync are untrusted input: the
 * canister value was written by an older build, and the cache by an older browser.
 */
export function normalizeCurrencyCode(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const code = raw.trim().toUpperCase();
  return ISO_RE.test(code) ? code : undefined;
}

export type CurrencyReconciliation = {
  /** The code the app should use from now on (always a valid ISO code). */
  use: string;
  /**
   * Set when the canister holds no usable value and the local one must be pushed up — the one-time
   * migration for users whose default has only ever existed in this browser. Undefined means the
   * canister is already authoritative and must NOT be overwritten (that would let a stale device
   * clobber a newer choice made elsewhere).
   */
  push?: string;
};

/**
 * Decide what to use and whether to push, given the canister's value and the browser cache.
 *
 * The canister WINS whenever it has a usable code: it is the cross-device source of truth, so a
 * device whose cache is stale adopts the newer choice instead of fighting it. Only when the canister
 * has nothing does the cached value win — and then it is pushed up so every other device inherits it.
 */
export function reconcileDefaultCurrency(
  canisterValue: unknown,
  cachedValue: unknown,
): CurrencyReconciliation {
  const remote = normalizeCurrencyCode(canisterValue);
  if (remote) return { use: remote };

  const local = normalizeCurrencyCode(cachedValue);
  if (local) return { use: local, push: local };

  // Neither side has anything usable: fall back, and record it so the next device agrees.
  return { use: FALLBACK_CURRENCY, push: FALLBACK_CURRENCY };
}

/**
 * Read `default_currency` out of a candid `UserRecord`. Candid `opt text` decodes to `[]` or `[code]`,
 * and an older canister has no such field at all — both resolve to undefined.
 */
export function currencyFromUserRecord(rec: unknown): string | undefined {
  if (typeof rec !== "object" || rec === null) return undefined;
  const field = (rec as { default_currency?: unknown }).default_currency;
  if (Array.isArray(field)) return field.length > 0 ? normalizeCurrencyCode(field[0]) : undefined;
  return normalizeCurrencyCode(field);
}
