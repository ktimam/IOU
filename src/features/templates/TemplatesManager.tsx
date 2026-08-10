// Create / edit / delete a sheet's transaction types. Rendered in a popup
// from the sheet's "Add type" button.
//
// Types are ACCOUNT-SCOPED: a type belongs to the account (pair) it was
// created in — it's written into MY encrypted slot on THAT Pair via the
// usePairTemplates api (`pair`, passed by the sheet page), visible to both
// members of this account only, and nothing follows you into your other
// accounts. Creating, editing, and "Edit a copy" of a partner-authored
// type are all the SAME operation: upsertMyTemplate — a same-id upsert
// into MY slot at the next rev (copy-on-write: the partner's slot is never
// touched; removing my override resurfaces their original). Removing my
// own type drops the id from my slot — it disappears for both members.
//
// The LEGACY user-level personal store (TemplatesContext) is a read-only
// migration source: pre-rework personal types are listed with "Add to this
// account" (an upsertMyTemplate that KEEPS the personal id, so partners'
// same-id copies merge sanely) and an optional legacy Remove.

import { useState } from "react";
import { orderedCurrencies } from "../settings/currencies";
import {
  useTemplates,
  type TxnTemplate,
  type TemplatePortion,
  type DueAnchor,
} from "./TemplatesContext";
import type { PairTemplatesApi } from "./PairTemplatesContext";
import type { Direction, TxnType } from "../entries/types";

function fmtMajor(minor?: number): string {
  return minor ? (minor / 100).toFixed(2) : "";
}

type SchedRow = { anchor: DueAnchor; days: number; percent: number };

export function TemplatesManager({
  onSaved,
  pair,
}: {
  onSaved?: () => void;
  pair: PairTemplatesApi;
}) {
  // LEGACY personal store — read-only migration source (+ legacy remove).
  const {
    templates: legacyTemplates,
    removeTemplate: removeLegacyTemplate,
    loading: legacyLoading,
    error: legacyError,
  } = useTemplates();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [direction, setDirection] = useState<Direction>("credit");
  const [txnType, setTxnType] = useState<TxnType>("iou");
  const [currency, setCurrency] = useState(""); // "" = use default
  const [feePercent, setFeePercent] = useState(0);
  const [feeFixed, setFeeFixed] = useState("");
  const [feeFixedCurrency, setFeeFixedCurrency] = useState(""); // "" = same as the entry currency
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [keywords, setKeywords] = useState(""); // comma-separated in the form; stored as string[]
  const [sched, setSched] = useState<SchedRow[]>([
    { anchor: "in_days", days: 0, percent: 100 },
  ]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const schedTotal = sched.reduce((t, r) => t + (Number(r.percent) || 0), 0);
  const schedValid = sched.length === 1 || schedTotal === 100;

  const setRowDays = (i: number, d: number) =>
    setSched((s) => s.map((r, j) => (j === i ? { ...r, days: d } : r)));
  const setRowPct = (i: number, p: number) =>
    setSched((s) => s.map((r, j) => (j === i ? { ...r, percent: p } : r)));
  const setRowAnchor = (i: number, a: DueAnchor) =>
    setSched((s) => s.map((r, j) => (j === i ? { ...r, anchor: a } : r)));
  const addSchedRow = () =>
    setSched((s) => [...s, { anchor: "in_days", days: 0, percent: 0 }]);
  const removeSchedRow = (i: number) =>
    setSched((s) => s.filter((_, j) => j !== i));

  function resetForm() {
    setEditingId(null);
    setName("");
    setDirection("credit");
    setTxnType("iou");
    setCurrency("");
    setFeePercent(0);
    setFeeFixed("");
    setFeeFixedCurrency("");
    setAmount("");
    setNote("");
    setKeywords("");
    setSched([{ anchor: "in_days", days: 0, percent: 100 }]);
    setErr(null);
  }

  function startEdit(t: TxnTemplate) {
    setEditingId(t.id);
    setName(t.name);
    setDirection(t.direction);
    setTxnType(t.txn_type);
    setCurrency(t.currency ?? "");
    setFeePercent(t.fee_percent ?? 0);
    setFeeFixed(t.fee_fixed_minor ? (t.fee_fixed_minor / 100).toFixed(2) : "");
    setFeeFixedCurrency(t.fee_fixed_currency ?? "");
    setAmount(t.amount_minor ? (t.amount_minor / 100).toFixed(2) : "");
    setNote(t.note ?? "");
    setKeywords((t.keywords ?? []).join(", "));
    setSched(
      t.schedule && t.schedule.length
        ? t.schedule.map((p) => ({
            anchor: p.anchor ?? "in_days",
            days: p.offset_days,
            percent: p.percent,
          }))
        : [{ anchor: "in_days", days: 0, percent: 100 }],
    );
    setErr(null);
  }

  async function save() {
    if (!name.trim()) {
      setErr("Give the template a name");
      return;
    }
    let schedule: TemplatePortion[] | undefined;
    if (txnType === "iou") {
      if (sched.length > 1 && schedTotal !== 100) {
        setErr("schedule percentages must total 100%");
        return;
      }
      // Only store a schedule if it's non-trivial (a split, a non-zero
      // delay, or a non-default anchor); a single "due in 0 days" is the
      // default already.
      const meaningful =
        sched.length > 1 ||
        sched.some((r) => r.anchor !== "in_days" || r.days > 0);
      if (meaningful) {
        schedule = sched.map((r) => ({
          offset_days: r.anchor === "in_days" ? Math.max(0, Math.round(r.days) || 0) : 0,
          percent: sched.length === 1 ? 100 : Number(r.percent) || 0,
          ...(r.anchor !== "in_days" ? { anchor: r.anchor } : {}),
        }));
      }
    }
    const base = {
      name: name.trim(),
      direction,
      txn_type: txnType,
      currency: currency || undefined,
      amount_minor: amount ? Math.round(parseFloat(amount) * 100) : undefined,
      fee_percent: txnType === "iou" && feePercent > 0 ? feePercent : undefined,
      fee_fixed_minor:
        txnType === "iou" && feeFixed
          ? Math.round(parseFloat(feeFixed) * 100)
          : undefined,
      // Only meaningful with a fixed fee; "" (same as entry currency) stays undefined.
      fee_fixed_currency:
        txnType === "iou" && feeFixed && feeFixedCurrency ? feeFixedCurrency : undefined,
      schedule,
      note: note.trim() || undefined,
      // Split the comma list into private matching words; drop empties and any >64 chars, cap at 50.
      // These remain E2E-encrypted account data. A chat-bound matcher may use them only after IOU
      // proves that chat has a saved sheet link; they never enter OpenChat's public app manifest.
      keywords: keywords.trim()
        ? keywords
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0 && s.length <= 64)
            .slice(0, 50)
        : undefined,
    };
    setBusy(true);
    setErr(null);
    try {
      // ONE code path for create, edit, and "Edit a copy" of a partner's
      // type: upsert into MY slot on THIS account. An existing id (mine →
      // in-place edit; the partner's → copy-on-write override at the next
      // rev, their slot untouched); no id → a fresh type is created.
      await pair.upsertMyTemplate(editingId ? { id: editingId, ...base } : base);
      resetForm();
      onSaved?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function migrateLegacy(t: TxnTemplate) {
    setBusy(true);
    setErr(null);
    try {
      // KEEP the personal id so a partner migrating their same-id copy
      // merges into the same account type instead of duplicating it.
      await pair.upsertMyTemplate(t);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // THIS ACCOUNT's types, split by author: ids live in MY slot are mine to
  // Edit/Remove; the rest of the merged view is partner-authored.
  const myTypes = pair.shared.filter((s) => pair.myIds.has(s.id));
  const partnerTypes = pair.shared.filter((s) => !pair.myIds.has(s.id));

  function summary(t: TxnTemplate): string {
    const parts: string[] = [
      t.direction === "credit" ? "Credit" : "Debit",
      t.txn_type === "settlement" ? "Settlement" : "IOU",
    ];
    if (t.currency) parts.push(t.currency);
    if (t.amount_minor) parts.push(fmtMajor(t.amount_minor));
    const fee: string[] = [];
    if (t.fee_percent) fee.push(`${t.fee_percent}%`);
    if (t.fee_fixed_minor)
      fee.push(
        `${fmtMajor(t.fee_fixed_minor)}${t.fee_fixed_currency ? ` ${t.fee_fixed_currency}` : ""} fixed`,
      );
    if (fee.length) parts.push(`fee ${fee.join(" + ")}`);
    if (t.schedule && t.schedule.length) {
      const sd = t.schedule
        .map((p) => {
          const when =
            p.anchor === "start_of_next_month"
              ? "1st next mo"
              : p.offset_days === 0
                ? "now"
                : `+${p.offset_days}d`;
          return t.schedule!.length > 1 ? `${when} ${p.percent}%` : when;
        })
        .join(", ");
      parts.push(`due ${sd}`);
    }
    return parts.join(" · ");
  }

  return (
    <div>
      <h2>Transaction types</h2>
      <p className="muted small">
        Save presets like “Reservation” (e.g. 20% + a fixed fee, split due
        dates). Pick one from <strong>+ Add ▾</strong> on this sheet to
        pre-fill an entry. Types belong to <strong>this account</strong>:
        both of you see them here, encrypted end-to-end — nothing follows
        you into your other accounts.
      </p>

      {pair.loading && <p className="muted small">Loading…</p>}
      {pair.error && <p className="err">{pair.error}</p>}

      {myTypes.length > 0 && (
        <ul>
          {myTypes.map((t) => (
            <li key={t.id} style={{ marginBottom: 6 }}>
              <strong>{t.name}</strong>{" "}
              <span className="muted small">{summary(t)}</span>{" "}
              <button className="secondary small" onClick={() => startEdit(t)}>
                Edit
              </button>{" "}
              <button
                className="secondary small"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(`Delete the “${t.name}” type? This can't be undone.`)) {
                    // Drops the id from MY slot — if it overrode a partner's
                    // type, theirs resurfaces; if it was mine alone it
                    // disappears for both members.
                    void pair.removeMyTemplate(t.id).catch((e) => setErr((e as Error).message));
                    if (editingId === t.id) resetForm();
                  }
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {partnerTypes.length > 0 && (
        <div className="col" style={{ gap: 4, marginTop: 8 }}>
          <strong className="small">Added by your partner</strong>
          <p className="muted small" style={{ margin: 0 }}>
            Types your partner added to this account. Use “Edit a copy” to
            publish your own version — theirs stays untouched, and removing
            your copy brings theirs back.
          </p>
          <ul>
            {partnerTypes.map((t) => (
              <li key={t.id} style={{ marginBottom: 6 }}>
                <strong>{t.name}</strong>{" "}
                <span className="muted small">{summary(t)}</span>{" "}
                <button
                  className="secondary small"
                  disabled={busy}
                  onClick={() => startEdit(t)}
                >
                  Edit a copy
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {legacyTemplates.length > 0 && (
        <div className="col" style={{ gap: 4, marginTop: 8 }}>
          <strong className="small">Legacy personal types</strong>
          <p className="muted small" style={{ margin: 0 }}>
            Saved before types became account-scoped. They no longer appear
            in pickers — add the ones you still use to this account (repeat
            in any other account that needs them), then remove them here.
          </p>
          {legacyLoading && <p className="muted small">Loading…</p>}
          {legacyError && <p className="err">{legacyError}</p>}
          <ul>
            {legacyTemplates.map((t) => (
              <li key={t.id} style={{ marginBottom: 6 }}>
                <strong>{t.name}</strong>{" "}
                <span className="muted small">{summary(t)}</span>{" "}
                <button
                  className="secondary small"
                  disabled={busy}
                  onClick={() => void migrateLegacy(t)}
                >
                  Add to this account
                </button>{" "}
                <button
                  className="secondary small"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`Remove the legacy “${t.name}” type? Copies already added to accounts are kept.`)) {
                      void removeLegacyTemplate(t.id).catch((e) => setErr((e as Error).message));
                    }
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="col" style={{ gap: 8, marginTop: 12 }}>
        <strong className="small">
          {editingId ? "Edit type" : "New type"}
        </strong>
        <input
          placeholder="Name (e.g. Reservation)"
          maxLength={48}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <label>
            <span className="muted small">Direction</span>
            <select
              value={direction}
              onChange={(e) => setDirection(e.target.value as Direction)}
            >
              <option value="credit">Credit (Incoming)</option>
              <option value="debt">Debit (Outgoing)</option>
            </select>
          </label>
          <label>
            <span className="muted small">Type</span>
            <select
              value={txnType}
              onChange={(e) => setTxnType(e.target.value as TxnType)}
            >
              <option value="iou">IOU</option>
              <option value="settlement">Settlement</option>
            </select>
          </label>
          <label>
            <span className="muted small">Currency</span>
            <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              <option value="">(default)</option>
              {orderedCurrencies().map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        </div>
        {txnType === "iou" && (
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <label>
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
            <label>
              <span className="muted small">Fixed fee</span>
              <input
                type="number"
                min={0}
                step="0.01"
                placeholder="0.00"
                value={feeFixed}
                onChange={(e) => setFeeFixed(e.target.value)}
                style={{ width: 100 }}
              />
            </label>
            <label>
              <span className="muted small">Fee currency</span>
              <select
                value={feeFixedCurrency}
                onChange={(e) => setFeeFixedCurrency(e.target.value)}
                title="Currency of the fixed fee. A different currency becomes its own balance line."
              >
                <option value="">(same as entry)</option>
                {orderedCurrencies().map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        {txnType === "iou" && (
          <div className="col" style={{ gap: 6 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span className="muted small">Default due schedule</span>
              <button type="button" className="secondary small" onClick={addSchedRow}>
                + Split
              </button>
            </div>
            {sched.map((r, i) => (
              <div className="row" key={i} style={{ gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <span className="muted small">Due</span>
                <select
                  value={r.anchor}
                  onChange={(e) => setRowAnchor(i, e.target.value as DueAnchor)}
                >
                  <option value="in_days">in days</option>
                  <option value="start_of_next_month">start of next month</option>
                </select>
                {r.anchor === "in_days" && (
                  <>
                    <input
                      type="number"
                      min={0}
                      value={r.days}
                      onChange={(e) => setRowDays(i, Number(e.target.value))}
                      style={{ width: 70 }}
                    />
                    <span className="muted small">days</span>
                  </>
                )}
                {sched.length > 1 && (
                  <>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={r.percent}
                      onChange={(e) => setRowPct(i, Number(e.target.value))}
                      style={{ width: 70 }}
                      aria-label="percent"
                    />
                    <span className="muted small">%</span>
                    <button
                      type="button"
                      className="secondary small"
                      onClick={() => removeSchedRow(i)}
                      aria-label="remove portion"
                    >
                      ✕
                    </button>
                  </>
                )}
              </div>
            ))}
            {sched.length > 1 && (
              <span
                className="muted small"
                style={{ color: schedValid ? undefined : "var(--debt)" }}
              >
                Total: {schedTotal}%{schedValid ? "" : " — must be 100%"}
              </span>
            )}
          </div>
        )}
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <label>
            <span className="muted small">Default amount (optional)</span>
            <input
              type="number"
              min={0}
              step="0.01"
              placeholder="leave blank"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              style={{ width: 140 }}
            />
          </label>
          <label style={{ flex: 1 }}>
            <span className="muted small">Note (optional)</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <label style={{ flex: 1 }}>
            <span className="muted small">Trigger words (optional)</span>
            <input
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              placeholder="reservation, deposit, booking"
            />
            <span className="muted small">
              Comma-separated and encrypted with this account. The type name is not an automatic
              trigger; add the name here too if you want it to match. In OpenChat, connect IOU for a
              direct chat; for a group or channel, connect IOU and have an admin enable it there. Then
              link that exact chat to this IOU account. New matching messages observed while that
              chat is open then suggest IOU automatically and select this Saved type without
              publishing its name or trigger words. Keep AI action suggestions on and that chat
              unmuted.
            </span>
          </label>
        </div>
        {err && <p className="err">{err}</p>}
        <div className="cta-row">
          <button
            onClick={() => void save()}
            disabled={busy || !name.trim() || (txnType === "iou" && !schedValid)}
          >
            {busy ? "Saving…" : editingId ? "Save changes" : "Add type"}
          </button>
          {editingId && (
            <button className="secondary" onClick={resetForm} disabled={busy}>
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
