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
import type {
  EntryPayload,
  Direction,
  ConvertPayload,
  TxnType,
  DuePortion,
  FeePayload,
} from "./types";
import { fetchRate, type FxRate } from "./fx";
import { netAfterFee, formatMinor } from "./balance";
import { usePreferences } from "../settings/usePreferences";

type SchedRow = { date: string; percent: number };

interface EntryFormProps {
  enabledCurrencies: string[];
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
  enabledCurrencies,
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
  const [currency, setCurrency] = useState(
    initial?.currency ??
      (enabledCurrencies.includes(prefs.defaultCurrency)
        ? prefs.defaultCurrency
        : enabledCurrencies[0]) ??
      "USD",
  );
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
  const feeFixedMinor = Math.round((parseFloat(feeFixed) || 0) * 100);
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
    // IOU: validate the due-date schedule. A single due date is implicitly
    // 100%; multiple portions must total 100%.
    let schedulePayload: DuePortion[] | undefined;
    if (txnType === "iou") {
      if (schedule.length === 0) {
        setErr("add at least one due date");
        return;
      }
      if (schedule.length > 1 && percentTotal !== 100) {
        setErr("due-date percentages must total 100%");
        return;
      }
      schedulePayload = schedule.map((r) => ({
        due_ts: new Date(r.date + "T00:00:00Z").getTime(),
        percent: schedule.length === 1 ? 100 : Number(r.percent) || 0,
      }));
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
    // Apply the IOU fee: amount_minor stores the NET (what counts toward the
    // balance + splits across due dates); the gross is kept on the fee
    // sub-payload so the UI can show before/after.
    const baseMinor = convert ? convertedMinor! : amountMinor;
    const useFee = txnType === "iou" && (feePercent > 0 || feeFixedMinor > 0);
    const fee: FeePayload | undefined = useFee
      ? { percent: feePercent, fixed_minor: feeFixedMinor, gross_amount_minor: baseMinor }
      : undefined;
    setSubmitting(true);
    try {
      const payload: EntryPayload = {
        ts,
        kind: txnType === "settlement" ? "payment" : "expense",
        currency: convert ? convertTo : currency,
        amount_minor: useFee ? netAfterFee(baseMinor, feePercent, feeFixedMinor) : baseMinor,
        direction,
        note,
        txn_type: txnType,
        ...(schedulePayload ? { schedule: schedulePayload } : {}),
        ...(fee ? { fee } : {}),
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
            {(feePercent > 0 || feeFixedMinor > 0) && amountMinor > 0 && (
              <span className="muted small">
                {formatMinor(amountMinor, currency)}
                {feePercent > 0 ? ` − ${feePercent}%` : ""}
                {feeFixedMinor > 0 ? ` − ${formatMinor(feeFixedMinor, currency)}` : ""}
                {" = "}
                <strong>
                  {formatMinor(
                    netAfterFee(amountMinor, feePercent, feeFixedMinor),
                    currency,
                  )}
                </strong>
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
