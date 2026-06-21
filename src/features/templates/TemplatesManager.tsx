// Create / edit / delete transaction templates. Rendered in a popup from
// the sheet's "Add type" button (templates are user-level and stored
// encrypted on-chain, so they're available across every sheet).

import { useState } from "react";
import { COMMON_CURRENCIES } from "../settings/currencies";
import {
  useTemplates,
  type TxnTemplate,
  type TemplatePortion,
  type DueAnchor,
} from "./TemplatesContext";
import type { Direction, TxnType } from "../entries/types";

function fmtMajor(minor?: number): string {
  return minor ? (minor / 100).toFixed(2) : "";
}

type SchedRow = { anchor: DueAnchor; days: number; percent: number };

export function TemplatesManager({ onSaved }: { onSaved?: () => void } = {}) {
  const { templates, addTemplate, updateTemplate, removeTemplate, loading, error } =
    useTemplates();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [direction, setDirection] = useState<Direction>("credit");
  const [txnType, setTxnType] = useState<TxnType>("iou");
  const [currency, setCurrency] = useState(""); // "" = use default
  const [feePercent, setFeePercent] = useState(0);
  const [feeFixed, setFeeFixed] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
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
    setAmount("");
    setNote("");
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
    setAmount(t.amount_minor ? (t.amount_minor / 100).toFixed(2) : "");
    setNote(t.note ?? "");
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
      schedule,
      note: note.trim() || undefined,
    };
    setBusy(true);
    setErr(null);
    try {
      if (editingId) await updateTemplate({ id: editingId, ...base });
      else await addTemplate(base);
      resetForm();
      onSaved?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function summary(t: TxnTemplate): string {
    const parts: string[] = [
      t.direction === "credit" ? "Credit" : "Debit",
      t.txn_type === "settlement" ? "Settlement" : "IOU",
    ];
    if (t.currency) parts.push(t.currency);
    if (t.amount_minor) parts.push(fmtMajor(t.amount_minor));
    const fee: string[] = [];
    if (t.fee_percent) fee.push(`${t.fee_percent}%`);
    if (t.fee_fixed_minor) fee.push(`${fmtMajor(t.fee_fixed_minor)} fixed`);
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
        dates). Pick one from <strong>+ Add ▾</strong> on any sheet to
        pre-fill an entry. Stored encrypted on your account, usable
        everywhere.
      </p>

      {loading && <p className="muted small">Loading…</p>}
      {error && <p className="err">{error}</p>}

      {templates.length > 0 && (
        <ul>
          {templates.map((t) => (
            <li key={t.id} style={{ marginBottom: 6 }}>
              <strong>{t.name}</strong>{" "}
              <span className="muted small">{summary(t)}</span>{" "}
              <button className="secondary small" onClick={() => startEdit(t)}>
                Edit
              </button>{" "}
              <button
                className="secondary small"
                onClick={() => void removeTemplate(t.id)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
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
              {COMMON_CURRENCIES.map((c) => (
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
