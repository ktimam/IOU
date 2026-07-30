// Entry form. Used for both add and edit (edit is a separate route
// in v1, but the form is the same).
//
// v1 input shape:
//   - date (defaults to "now")
//   - currency (any ISO code; defaults to the user's single default currency)
//   - amount (in major units, e.g. 12.50)
//   - direction (credit / debt, with "I am owed" / "I owe" copy)
//   - description
//   - convert toggle: pick target currency, fetch FX rate, show
//     converted amount

import { useEffect, useState } from "react";
import type { EntryPayload, Direction, TxnType } from "./types";
import { fetchRate, type FxRate } from "./fx";
import { netAfterFee, formatMinor } from "./balance";
import { buildEntryPayload } from "./entryMath";
import { usePreferences } from "../settings/usePreferences";
import { orderedCurrencies } from "../settings/currencies";

type SchedRow = { date: string; percent: number };

interface EntryFormProps {
  myPrincipal: string;
  partnerPrincipal: string;
  // A full entry (edit) or a partial set of defaults (e.g. from a template).
  initial?: Partial<EntryPayload>;
  // True only when editing an existing entry (controls the submit label) —
  // a template also passes `initial` but is still an "add".
  isEdit?: boolean;
  onCancel: () => void;
  onSubmit: (p: EntryPayload) => Promise<void>;
}

export function EntryForm({
  myPrincipal,
  partnerPrincipal,
  initial,
  isEdit = false,
  onCancel,
  onSubmit,
}: EntryFormProps) {
  const { prefs } = usePreferences();
  const [date, setDate] = useState(
    new Date(initial?.ts ?? Date.now()).toISOString().slice(0, 10),
  );
  // A sheet has no currency of its own, so the only default is the user's single
  // default currency (Settings -> Default currency). An entry being EDITED keeps its own.
  const [currency, setCurrency] = useState(
    initial?.currency ?? prefs.defaultCurrency ?? "USD",
  );
  // Default first, then USD/EUR/GBP, then every other ISO code alphabetically. The
  // entry's own code is folded in so an edited entry's currency never drops out of
  // the list (e.g. a legacy or non-ISO code).
  const currencyOptions = orderedCurrencies(prefs.defaultCurrency, [currency]);
  // The amount field holds the GROSS (face value). For an entry with a fee
  // the stored amount_minor is the net, so seed from the fee's gross.
  // Templates may carry no amount at all → leave it blank.
  const initialGrossMinor = initial?.fee
    ? initial.fee.gross_amount_minor
    : initial?.amount_minor;
  const [amount, setAmount] = useState(
    initialGrossMinor && initialGrossMinor > 0
      ? (initialGrossMinor / 100).toFixed(2)
      : "",
  );
  const [direction, setDirection] = useState<Direction>(initial?.direction ?? "credit");
  const [note, setNote] = useState(initial?.note ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Transaction type + due-date schedule + fee (IOU only).
  const [txnType, setTxnType] = useState<TxnType>(initial?.txn_type ?? "iou");
  const [feePercent, setFeePercent] = useState<number>(initial?.fee?.percent ?? 0);
  const [feeFixed, setFeeFixed] = useState(
    initial?.fee?.fixed_minor ? (initial.fee.fixed_minor / 100).toFixed(2) : "",
  );
  // The fixed fee may be charged in a different currency than the entry. When it is, it doesn't
  // reduce the entry amount — it becomes its own balance line in that currency (see balance.ts).
  const [feeFixedCurrency, setFeeFixedCurrency] = useState(
    initial?.fee?.fixed_currency ?? initial?.currency ?? "",
  );
  const initialDate = new Date(initial?.ts ?? Date.now()).toISOString().slice(0, 10);
  const [schedule, setSchedule] = useState<SchedRow[]>(
    initial?.schedule && initial.schedule.length
      ? initial.schedule.map((p) => ({
          date: new Date(p.due_ts).toISOString().slice(0, 10),
          percent: p.percent,
        }))
      : [{ date: initialDate, percent: 100 }],
  );
  const setRowDate = (i: number, d: string) =>
    setSchedule((s) => s.map((r, j) => (j === i ? { ...r, date: d } : r)));
  const setRowPercent = (i: number, pct: number) =>
    setSchedule((s) => s.map((r, j) => (j === i ? { ...r, percent: pct } : r)));
  const addRow = () => setSchedule((s) => [...s, { date, percent: 0 }]);
  const removeRow = (i: number) => setSchedule((s) => s.filter((_, j) => j !== i));
  const percentTotal = schedule.reduce((t, r) => t + (Number(r.percent) || 0), 0);
  const scheduleValid = schedule.length === 1 || percentTotal === 100;

  // Convert state
  const [convertEnabled, setConvertEnabled] = useState(!!initial?.convert);
  // Converting to the SAME currency is meaningless, so the target starts as the user's
  // default and falls back to USD/EUR when that IS the entry's currency.
  const [convertTo, setConvertTo] = useState(
    initial?.convert?.to_currency ??
      [prefs.defaultCurrency, "USD", "EUR"].find((c) => c && c !== currency) ??
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
  const feeFixedMinor = Math.round((parseFloat(feeFixed) || 0) * 100);
  const feeCcy = feeFixedCurrency || currency;
  // A fixed fee in a different currency doesn't reduce the entry amount; it's its own balance line.
  const feeForeign = feeFixedMinor > 0 && feeCcy !== currency;
  const convertedMinor = rate
    ? Math.round(amountMinor * rate.rate)
    : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    // The net/convert/fee/schedule math lives in the pure buildEntryPayload helper (entryMath.ts)
    // so it can be unit-tested; the form only wires state in and handles the async submit.
    const result = buildEntryPayload({
      amountStr: amount,
      currency,
      direction,
      note,
      dateYmd: date,
      txnType,
      feePercent,
      feeFixedStr: feeFixed,
      feeFixedCurrency,
      schedule,
      convert:
        convertEnabled && rate && convertedMinor != null
          ? { to: convertTo, rate: rate.rate, rateSource: rate.source, rateFetchedAt: rate.fetchedAt }
          : null,
      draftId: initial?.draft_id,
      // Cross-member already-imported key: carried on BOTH the import path (SheetPage sets it on
      // the initial from the card's context.messageId) and the EDIT path (initial is the existing
      // payload) — an edit that dropped it would resurrect the card in the partner's pending list.
      importMessageId: initial?.import_message_id,
    });
    if (!result.ok) {
      setErr(result.error);
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit(result.payload);
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
            {currencyOptions.map((c) => (
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
            {`Credit (Incoming)`}
          </label>
          <label>
            <input
              type="radio"
              checked={direction === "debt"}
              onChange={() => setDirection("debt")}
            />
            {`Debit (Outgoing)`}
          </label>
        </fieldset>
      </div>

      <div className="row">
        <fieldset>
          <legend>Type</legend>
          <label>
            <input
              type="radio"
              checked={txnType === "iou"}
              onChange={() => setTxnType("iou")}
            />
            {" IOU (owed, has due date)"}
          </label>
          <label>
            <input
              type="radio"
              checked={txnType === "settlement"}
              onChange={() => setTxnType("settlement")}
            />
            {" Settlement (paid now)"}
          </label>
        </fieldset>
      </div>

      {txnType === "iou" && (
        <div className="card" style={{ padding: 12 }}>
          <div
            className="row"
            style={{ gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}
          >
            <label style={{ flex: "0 0 auto" }}>
              <span className="muted small">Fee %</span>
              <input
                type="number"
                min={0}
                max={100}
                value={feePercent}
                onChange={(e) => setFeePercent(Number(e.target.value))}
                style={{ width: 80 }}
              />
            </label>
            <label style={{ flex: "0 0 auto" }}>
              <span className="muted small">Fixed fee</span>
              <input
                type="number"
                min={0}
                step="0.01"
                value={feeFixed}
                onChange={(e) => setFeeFixed(e.target.value)}
                placeholder="0.00"
                style={{ width: 100 }}
              />
            </label>
            <label style={{ flex: "0 0 auto" }}>
              <span className="muted small">Fee currency</span>
              <select
                value={feeCcy}
                onChange={(e) => setFeeFixedCurrency(e.target.value)}
              >
                {currencyOptions.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            {(feePercent > 0 || feeFixedMinor > 0) && amountMinor > 0 && (
              <span className="muted small">
                {formatMinor(amountMinor, currency)}
                {feePercent > 0 ? ` − ${feePercent}%` : ""}
                {feeFixedMinor > 0 && !feeForeign
                  ? ` − ${formatMinor(feeFixedMinor, currency)}`
                  : ""}
                {" = "}
                <strong>
                  {formatMinor(
                    netAfterFee(amountMinor, feePercent, feeForeign ? 0 : feeFixedMinor),
                    currency,
                  )}
                </strong>
                {feeForeign
                  ? ` + a ${formatMinor(feeFixedMinor, feeCcy)} fee on its own ${feeCcy} line`
                  : ""}
              </span>
            )}
          </div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <strong>Due {schedule.length > 1 ? "dates" : "date"}</strong>
            <button type="button" className="secondary small" onClick={addRow}>
              + Split
            </button>
          </div>
          {schedule.map((r, i) => (
            <div className="row" key={i} style={{ gap: 8, alignItems: "center" }}>
              <input
                type="date"
                value={r.date}
                onChange={(e) => setRowDate(i, e.target.value)}
                required
              />
              {schedule.length > 1 && (
                <>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={r.percent}
                    onChange={(e) => setRowPercent(i, Number(e.target.value))}
                    style={{ width: 70 }}
                    aria-label="percent"
                  />
                  <span className="muted small">%</span>
                  <button
                    type="button"
                    className="secondary small"
                    onClick={() => removeRow(i)}
                    aria-label="remove due date"
                  >
                    ✕
                  </button>
                </>
              )}
            </div>
          ))}
          {schedule.length > 1 && (
            <p
              className="muted small"
              style={{ color: scheduleValid ? undefined : "var(--debt)" }}
            >
              Total: {percentTotal}%{scheduleValid ? "" : " — must be 100%"}
            </p>
          )}
        </div>
      )}

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
                {currencyOptions
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
        <button
          type="submit"
          disabled={submitting || (txnType === "iou" && !scheduleValid)}
        >
          {submitting ? "Saving..." : isEdit ? "Save edit" : "Add entry"}
        </button>
      </div>

      <p className="muted small">
        Author: {myPrincipal.slice(0, 5)}… · Partner: {partnerPrincipal.slice(0, 5)}…
      </p>
    </form>
  );
}
