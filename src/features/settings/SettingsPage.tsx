// /settings — preferences + transaction templates.
//
// Default currency + profile name are browser-local conveniences. The
// profile name publishes per-account (E2E under K_sheet). Transaction
// templates are stored encrypted on the user's account (on-chain) and are
// available in every sheet.

import { useState } from "react";
import { Link } from "react-router-dom";
import { usePreferences } from "./usePreferences";
import { COMMON_CURRENCIES } from "./currencies";
import { useTemplates } from "../templates/TemplatesContext";
import type { Direction, TxnType } from "../entries/types";

export function SettingsPage() {
  const { prefs, setDefaultCurrency, setProfileName } = usePreferences();
  const [name, setName] = useState(prefs.profileName);
  const [saved, setSaved] = useState(false);

  return (
    <div>
      <Link to="/me" className="muted">
        ← Back
      </Link>
      <h1>Settings</h1>

      <div className="card">
        <h2>Profile name</h2>
        <p className="muted small">
          Your partner sees this on shared accounts instead of your
          principal. Stored end-to-end encrypted; it publishes to an account
          the next time you create or open it.
        </p>
        <input
          maxLength={32}
          placeholder="e.g. Alice"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setSaved(false);
          }}
        />
        <span className="lock-cue">🔒 published encrypted, per account</span>
        <div className="cta">
          <button
            onClick={() => {
              setProfileName(name.trim());
              setSaved(true);
            }}
          >
            Save name
          </button>
        </div>
        {saved && (
          <p className="muted small">
            Saved. It’ll publish to your accounts when you next open them.
          </p>
        )}
      </div>

      <div className="card">
        <h2>Default currency</h2>
        <p className="muted small">
          Pre-selected when you add entries or create an account.
        </p>
        <select
          value={prefs.defaultCurrency}
          onChange={(e) => setDefaultCurrency(e.target.value)}
        >
          {COMMON_CURRENCIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      <TemplatesManager />
    </div>
  );
}

function fmtMajor(minor?: number): string {
  return minor ? (minor / 100).toFixed(2) : "";
}

function TemplatesManager() {
  const { templates, addTemplate, removeTemplate, loading, error } = useTemplates();
  const [name, setName] = useState("");
  const [direction, setDirection] = useState<Direction>("credit");
  const [txnType, setTxnType] = useState<TxnType>("iou");
  const [currency, setCurrency] = useState(""); // "" = use default
  const [feePercent, setFeePercent] = useState(0);
  const [feeFixed, setFeeFixed] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function add() {
    if (!name.trim()) {
      setErr("Give the template a name");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await addTemplate({
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
        note: note.trim() || undefined,
      });
      setName("");
      setFeePercent(0);
      setFeeFixed("");
      setAmount("");
      setNote("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function summary(t: (typeof templates)[number]): string {
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
    return parts.join(" · ");
  }

  return (
    <div className="card">
      <h2>Transaction templates</h2>
      <p className="muted small">
        Save presets like “Reservation” (e.g. 20% + a fixed fee). Pick one
        from <strong>+ Add ▾</strong> on any sheet to pre-fill an entry.
        Stored encrypted on your account, usable everywhere.
      </p>

      {loading && <p className="muted small">Loading…</p>}
      {error && <p className="err">{error}</p>}

      {templates.length > 0 && (
        <ul>
          {templates.map((t) => (
            <li key={t.id} style={{ marginBottom: 6 }}>
              <strong>{t.name}</strong>{" "}
              <span className="muted small">{summary(t)}</span>{" "}
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
        <input
          placeholder="Template name (e.g. Reservation)"
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
        <div className="cta">
          <button onClick={() => void add()} disabled={busy || !name.trim()}>
            {busy ? "Saving…" : "Add template"}
          </button>
        </div>
      </div>
    </div>
  );
}
