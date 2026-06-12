// Entry form. Used for both add and edit (edit is a separate route
// in v1, but the form is the same).
//
// v1 input shape:
//   - date (defaults to "now")
//   - currency (one of sheet.enabled_currencies)
//   - amount (in major units, e.g. 12.50)
//   - direction (credit / debt, with "I am owed" / "I owe" copy)
//   - description
//   - convert toggle: pick target currency, fetch FX rate, show
//     converted amount

import { useEffect, useState } from "react";
import type { EntryPayload, Direction, ConvertPayload } from "./types";
import { fetchRate, type FxRate } from "./fx";

interface EntryFormProps {
  enabledCurrencies: string[];
  myPrincipal: string;
  partnerPrincipal: string;
  initial?: EntryPayload;
  onCancel: () => void;
  onSubmit: (p: EntryPayload) => Promise<void>;
}

export function EntryForm({
  enabledCurrencies,
  myPrincipal,
  partnerPrincipal,
  initial,
  onCancel,
  onSubmit,
}: EntryFormProps) {
  const [date, setDate] = useState(
    new Date(initial?.ts ?? Date.now()).toISOString().slice(0, 10),
  );
  const [currency, setCurrency] = useState(
    initial?.currency ?? enabledCurrencies[0] ?? "USD",
  );
  const [amount, setAmount] = useState(
    initial ? (initial.amount_minor / 100).toFixed(2) : "",
  );
  const [direction, setDirection] = useState<Direction>(initial?.direction ?? "credit");
  const [note, setNote] = useState(initial?.note ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Convert state
  const [convertEnabled, setConvertEnabled] = useState(!!initial?.convert);
  const [convertTo, setConvertTo] = useState(
    initial?.convert?.to_currency ??
      enabledCurrencies.find((c) => c !== currency) ??
      enabledCurrencies[0] ??
      "USD",
  );
  const [rate, setRate] = useState<FxRate | null>(null);
  const [rateErr, setRateErr] = useState<string | null>(null);
  const [rateLoading, setRateLoading] = useState(false);

  async function fetchRateAndStore() {
    setRate(null);
    setRateErr(null);
    setRateLoading(true);
    try {
      const r = await fetchRate(currency, convertTo);
      setRate(r);
    } catch (e) {
      setRateErr((e as Error).message);
    } finally {
      setRateLoading(false);
    }
  }

  useEffect(() => {
    if (convertEnabled && currency !== convertTo) {
      fetchRateAndStore();
    } else if (convertEnabled && currency === convertTo) {
      setRate({ base: currency, quote: convertTo, rate: 1, fetchedAt: Date.now(), source: "frankfurter.app" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convertEnabled, currency, convertTo]);

  const amountMinor = Math.round((parseFloat(amount) || 0) * 100);
  const convertedMinor = rate
    ? Math.round(amountMinor * rate.rate)
    : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!amountMinor || amountMinor <= 0) {
      setErr("amount must be > 0");
      return;
    }
    const ts = new Date(date + "T00:00:00Z").getTime();
    let convert: ConvertPayload | undefined;
    if (convertEnabled && rate && convertedMinor != null) {
      convert = {
        from_currency: currency,
        from_amount_minor: amountMinor,
        to_currency: convertTo,
        to_amount_minor: convertedMinor,
        rate: rate.rate,
        rate_source: rate.source,
        rate_fetched_at: rate.fetchedAt,
      };
    }
    setSubmitting(true);
    try {
      const payload: EntryPayload = {
        ts,
        kind: "expense",
        currency: convert ? convertTo : currency,
        amount_minor: convert ? convertedMinor! : amountMinor,
        direction,
        note,
        convert,
      };
      await onSubmit(payload);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="entry-form">
      <div className="row">
        <label>
          <span>Date</span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
          />
        </label>
      </div>

      <div className="row">
        <label>
          <span>Currency</span>
          <select
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            required
          >
            {enabledCurrencies.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Amount</span>
          <input
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
          />
        </label>
      </div>

      <div className="row">
        <fieldset>
          <legend>Direction</legend>
          <label>
            <input
              type="radio"
              checked={direction === "credit"}
              onChange={() => setDirection("credit")}
            />
            {`They owe me (credit)`}
          </label>
          <label>
            <input
              type="radio"
              checked={direction === "debt"}
              onChange={() => setDirection("debt")}
            />
            {`I owe them (debt)`}
          </label>
        </fieldset>
      </div>

      <div className="row">
        <label>
          <span>Note</span>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="lunch, taxi, etc."
          />
        </label>
      </div>

      <div className="row">
        <label>
          <input
            type="checkbox"
            checked={convertEnabled}
            onChange={(e) => setConvertEnabled(e.target.checked)}
          />
          {` Convert to another currency`}
        </label>
      </div>

      {convertEnabled && (
        <div className="convert-block">
          <div className="row">
            <label>
              <span>Convert to</span>
              <select
                value={convertTo}
                onChange={(e) => setConvertTo(e.target.value)}
              >
                {enabledCurrencies
                  .filter((c) => c !== currency)
                  .map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
              </select>
            </label>
            <button
              type="button"
              onClick={fetchRateAndStore}
              disabled={rateLoading || currency === convertTo}
            >
              {rateLoading ? "fetching..." : "Refresh rate"}
            </button>
          </div>
          {rateErr && <div className="err">{rateErr}</div>}
          {rate && convertedMinor != null && (
            <div className="rate-preview">
              {amount || "0.00"} {currency} → {convertedMinor / 100}{" "}
              {convertTo} @ {rate.rate.toFixed(4)} (
              {new Date(rate.fetchedAt).toISOString().slice(0, 10)})
            </div>
          )}
        </div>
      )}

      {err && <div className="err">{err}</div>}

      <div className="actions">
        <button type="button" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button type="submit" disabled={submitting}>
          {submitting ? "Saving..." : initial ? "Save edit" : "Add entry"}
        </button>
      </div>

      <p className="muted small">
        Author: {myPrincipal.slice(0, 5)}… · Partner: {partnerPrincipal.slice(0, 5)}…
      </p>
    </form>
  );
}
