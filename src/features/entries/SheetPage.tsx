// /sheet/:sheetId — the main IOU page.
//
// Loads the sheet, decrypts all entries with K_sheet, shows balance
// cards and the history list. "Add entry" and "edit" both open the
// same form in a modal.

import { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { unwrap, isActive, useActor } from "../flows/useActor";
import { useSheetKey } from "../flows/SheetKeyContext";
import { useAuth } from "../auth/AuthProvider";
import {
  decryptEntryPayload,
  encryptEntryPayload,
  decryptName,
  encryptName,
} from "../crypto/devVetkd";
import { decodeEntry, type EntryPayload } from "./types";
import {
  computeBalances,
  computeBalancesAsOf,
  endOfPrevMonth,
  formatMinor,
  type Balance,
} from "./balance";
import { EntryForm } from "./EntryForm";
import { CloseSheetButton } from "./CloseSheetButton";
import { downloadCsv, entriesToCsv } from "./csvExport";
import { useToasts } from "../ui/Toasts";
import { usePreferences } from "../settings/usePreferences";
import { useTemplates, type TxnTemplate } from "../templates/TemplatesContext";
import { TemplatesManager } from "../templates/TemplatesManager";

// Build entry-form defaults from a template.
function templateToInitial(t: TxnTemplate): Partial<EntryPayload> {
  const gross = t.amount_minor ?? 0;
  const feePct = t.fee_percent ?? 0;
  const feeFixed = t.fee_fixed_minor ?? 0;
  const hasFee = t.txn_type === "iou" && (feePct > 0 || feeFixed > 0);
  // Convert the template's relative schedule (days from today) to absolute
  // due dates anchored at today (UTC midnight, matching the entry form).
  let schedule: EntryPayload["schedule"];
  if (t.txn_type === "iou" && t.schedule && t.schedule.length) {
    const now = new Date();
    const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    schedule = t.schedule.map((p) => ({
      due_ts: base + p.offset_days * 86_400_000,
      percent: p.percent,
    }));
  }
  return {
    currency: t.currency,
    amount_minor: t.amount_minor,
    direction: t.direction,
    note: t.note ?? "",
    txn_type: t.txn_type,
    fee: hasFee
      ? { percent: feePct, fixed_minor: feeFixed, gross_amount_minor: gross }
      : undefined,
    ...(schedule ? { schedule } : {}),
  };
}

// Unwrap a Candid opt<vec nat8> to a Uint8Array (or null).
function optBytes(o: any): Uint8Array | null {
  const v = Array.isArray(o) ? o[0] : o;
  return v == null ? null : new Uint8Array(v);
}

// Format an IOU's due schedule for the history row.
function formatSchedule(p: EntryPayload): string | null {
  if (p.txn_type === "settlement") return null;
  const sched = p.schedule && p.schedule.length ? p.schedule : null;
  if (!sched) return null;
  const fmt = (ts: number) => new Date(ts).toISOString().slice(0, 10);
  if (sched.length === 1) return `due ${fmt(sched[0].due_ts)}`;
  return "due " + sched.map((s) => `${fmt(s.due_ts)} (${s.percent}%)`).join(", ");
}

type DecryptedEntry = {
  id: number;
  created_by: string;
  created_at_server: number;
  updated_at_server: number | null;
  payload: EntryPayload;
};

type SortKey = "newest" | "oldest" | "amount-desc" | "amount-asc";

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "amount-desc", label: "Largest amount" },
  { value: "amount-asc", label: "Smallest amount" },
];

export function SheetPage() {
  const { sheetId = "" } = useParams();
  const { state } = useAuth();
  const { actor } = useActor();
  const { get, unwrapFor } = useSheetKey();
  const toasts = useToasts();
  const { prefs, cacheSheetName, cacheAccountName, cachePartnerName } = usePreferences();

  const [sheet, setSheet] = useState<any>(null);
  const [entries, setEntries] = useState<DecryptedEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [modal, setModal] = useState<null | {
    initial: Partial<EntryPayload> | null;
    entryId: number | null;
  }>(null);
  const [sortKey, setSortKey] = useState<SortKey>("newest");
  const { templates } = useTemplates();
  const [addOpen, setAddOpen] = useState(false);
  const [typesOpen, setTypesOpen] = useState(false);
  const openAdd = (initial: Partial<EntryPayload> | null) => {
    setModal({ initial, entryId: null });
    setAddOpen(false);
  };

  const myPrincipal = state.kind === "authenticated"
    ? state.identity.getPrincipal().toText()
    : "";
  // member_a/member_b are Principal objects (Candid), not strings. Treating
  // them as strings — comparing with === and calling .slice() — threw
  // "them.slice is not a function" and blanked the whole page (no error
  // boundary). Convert to text before any string use.
  const principalText = (p: any): string =>
    p && typeof p.toText === "function" ? p.toText() : String(p ?? "");
  const memberAText = sheet ? principalText(sheet.member_a) : "";
  const memberBText = sheet ? principalText(sheet.member_b) : "";
  const partnerPrincipal =
    memberAText === myPrincipal ? memberBText : memberAText;

  async function reload() {
    if (!actor || !sheetId) return;
    setLoading(true);
    setErr(null);
    try {
      const sh = unwrap(await (actor as any).get_sheet(sheetId));
      if (!sh) {
        setErr("sheet not found");
        setSheet(null);
        return;
      }
      setSheet(sh);
      const K_sheet = get(sheetId) ?? (await unwrapFor(sheetId));
      // Decrypt names (best-effort) and cache the plaintext locally so the
      // accounts list / headers render instantly. Names are E2E-encrypted
      // under K_sheet; failures are non-fatal (fall back to principals).
      try {
        const senc = optBytes(sh.name_enc);
        const siv = optBytes(sh.name_iv);
        if (senc && siv) {
          const nm = await decryptName(K_sheet, siv, senc);
          if (nm) cacheSheetName(sheetId, nm);
        }
        const pr = unwrap(await (actor as any).get_pair(sh.pair_id));
        if (pr) {
          const aenc = optBytes(pr.name_enc);
          const aiv = optBytes(pr.name_iv);
          if (aenc && aiv) {
            const an = await decryptName(K_sheet, aiv, aenc);
            if (an) cacheAccountName(sh.pair_id, an);
          }
          const meIsA = principalText(pr.members[0]) === myPrincipal;
          const penc = optBytes(meIsA ? pr.member_b_name_enc : pr.member_a_name_enc);
          const piv = optBytes(meIsA ? pr.member_b_name_iv : pr.member_a_name_iv);
          if (penc && piv) {
            const pn = await decryptName(K_sheet, piv, penc);
            if (pn) cachePartnerName(sh.pair_id, pn);
          }
          // Publish my profile name on this account if it isn't set yet, so
          // my partner sees it. One-time per account (skip once present).
          const myEnc = optBytes(meIsA ? pr.member_a_name_enc : pr.member_b_name_enc);
          if (!myEnc && prefs.profileName.trim()) {
            const { enc, iv } = await encryptName(K_sheet, prefs.profileName.trim());
            await (actor as any).set_member_name(sh.pair_id, enc, iv);
          }
        }
      } catch {
        /* names are best-effort */
      }
      const res = await (actor as any).list_entries(sheetId, [], 200);
      const dec: DecryptedEntry[] = [];
      for (const e of res.entries) {
        const pt = await decryptEntryPayload(
          new Uint8Array(e.entry_key),
          new Uint8Array(e.iv),
          new Uint8Array(e.ciphertext),
          K_sheet,
        );
        dec.push({
          id: Number(e.id),
          created_by: e.created_by.toText(),
          created_at_server: Number(e.created_at_server),
          updated_at_server: e.updated_at_server && e.updated_at_server.length
            ? Number(e.updated_at_server[0])
            : null,
          payload: decodeEntry(pt),
        });
      }
      setEntries(dec);
    } catch (e) {
      setErr((e as Error).message);
      toasts.show({ kind: "error", text: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actor, sheetId]);

  const sorted = useMemo(() => {
    const arr = entries.slice();
    switch (sortKey) {
      case "newest":
        return arr.sort((a, b) => b.payload.ts - a.payload.ts);
      case "oldest":
        return arr.sort((a, b) => a.payload.ts - b.payload.ts);
      case "amount-desc":
        return arr.sort(
          (a, b) => b.payload.amount_minor - a.payload.amount_minor,
        );
      case "amount-asc":
        return arr.sort(
          (a, b) => a.payload.amount_minor - b.payload.amount_minor,
        );
    }
  }, [entries, sortKey]);

  async function onSubmit(p: EntryPayload) {
    if (!actor) return;
    const K_sheet = get(sheetId) ?? (await unwrapFor(sheetId));
    const enc = await encryptEntryPayload(
      new TextEncoder().encode(JSON.stringify(p)),
      K_sheet,
    );
    if (modal?.entryId != null) {
      await (actor as any).edit_entry({
        sheet_id: sheetId,
        entry_id: BigInt(modal.entryId),
        entry_key: Array.from(enc.entryKey),
        ciphertext: Array.from(enc.ciphertext),
        iv: Array.from(enc.iv),
      });
      toasts.show({ kind: "success", text: "Entry updated" });
    } else {
      await (actor as any).add_entry({
        sheet_id: sheetId,
        entry_key: Array.from(enc.entryKey),
        ciphertext: Array.from(enc.ciphertext),
        iv: Array.from(enc.iv),
      });
      toasts.show({ kind: "success", text: "Entry added" });
    }
    setModal(null);
    await reload();
  }

  function onExportCsv() {
    if (entries.length === 0) return;
    const me = state.kind === "authenticated"
      ? state.identity.getPrincipal().toText()
      : "";
    const rows = entries.map((e) => ({
      payload: e.payload,
      created_by_me: e.created_by === me,
      edited: e.updated_at_server != null,
    }));
    const csv = entriesToCsv(rows);
    const date = new Date().toISOString().slice(0, 10);
    const filename = `iou-${sheetId.slice(0, 8)}-${date}.csv`;
    try {
      downloadCsv(filename, csv);
      toasts.show({ kind: "success", text: `Exported ${rows.length} entries` });
    } catch (e) {
      toasts.show({ kind: "error", text: (e as Error).message });
    }
  }

  if (!state.kind || state.kind !== "authenticated") {
    return <p>Please sign in.</p>;
  }
  if (loading && !sheet) return <p>Loading…</p>;
  if (err) return <p className="err">{err}</p>;
  if (!sheet) return <p>Not found.</p>;

  const payloads = entries.map((e) => e.payload);
  const overall = computeBalances(payloads);
  const thisMonth = computeBalancesAsOf(payloads, Date.now());
  const prevMonth = computeBalancesAsOf(payloads, endOfPrevMonth(Date.now()));
  const me = myPrincipal;
  const them = partnerPrincipal;
  // Solo sheet: partner slot is the anonymous principal until a partner
  // joins and is granted access. Show friendly copy instead of "2vxsx…".
  const ANON = "2vxsx-fae";
  const isSolo = them === "" || them === ANON;
  const pairId: string = sheet.pair_id;
  const partnerName = prefs.partnerNames[pairId] || "";
  const sheetName = prefs.sheetNames[sheetId] || "";
  // Counterparty label: decrypted name if known, else solo copy, else a
  // shortened principal.
  const themShort = partnerName || (isSolo ? "your partner" : `${them.slice(0, 5)}…`);
  const buckets: { label: string; hint: string; list: Balance[] }[] = [
    { label: "This month", hint: "due so far", list: thisMonth },
    { label: "Previous month", hint: "due by end of last month", list: prevMonth },
    { label: "Overall", hint: "incl. upcoming", list: overall },
  ];

  return (
    <div className="sheet-page">
      <header>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <Link to="/pairs">← Accounts</Link>
          <Link to={`/pair/${pairId}`} className="muted small">
            Details →
          </Link>
        </div>
        <h1>{sheetName || `Sheet ${sheet.id.slice(0, 8)}…`}</h1>
        <p className="muted small">
          {isSolo && !partnerName ? (
            "Solo sheet"
          ) : (
            <>with {partnerName ? partnerName : <code>{them.slice(0, 8)}…</code>}</>
          )}{" "}
          · {isActive(sheet.state) ? "Active" : "Closed"} ·{" "}
          {sheet.enabled_currencies.join(", ")}
        </p>
      </header>

      <section className="balances">
        <h2>Balances</h2>
        {overall.length === 0 ? (
          <p className="muted">
            🎉 All settled. Add an entry to get started.
          </p>
        ) : (
          <div className="balance-buckets">
            {buckets.map((bk) => (
              <div key={bk.label} className="card" style={{ padding: 12 }}>
                <div className="muted small">
                  {bk.label} <span style={{ opacity: 0.6 }}>· {bk.hint}</span>
                </div>
                {bk.list.length === 0 ? (
                  <p className="muted small">All settled.</p>
                ) : (
                  <ul>
                    {bk.list.map((b) => {
                      const iOweThem = b.amount_minor < 0;
                      return (
                        <li key={b.currency}>
                          <strong>
                            {iOweThem
                              ? `You owe ${themShort}`
                              : `${themShort} owes you`}
                          </strong>{" "}
                          <span
                            className={`amt ${iOweThem ? "amt-debt" : "amt-credit"}`}
                          >
                            {formatMinor(Math.abs(b.amount_minor), b.currency)}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="row">
        {isActive(sheet.state) && !modal && (
          <>
            {templates.length > 0 ? (
              <div style={{ position: "relative", display: "inline-block" }}>
                <button onClick={() => setAddOpen((o) => !o)}>+ Add ▾</button>
                {addOpen && (
                  <div
                    className="card"
                    style={{
                      position: "absolute",
                      zIndex: 10,
                      marginTop: 4,
                      padding: 8,
                      minWidth: 200,
                    }}
                  >
                    <button
                      className="secondary"
                      style={{ display: "block", width: "100%", marginBottom: 6 }}
                      onClick={() => openAdd(null)}
                    >
                      Blank entry
                    </button>
                    {templates.map((t) => (
                      <button
                        key={t.id}
                        className="secondary"
                        style={{ display: "block", width: "100%", marginBottom: 6 }}
                        onClick={() => openAdd(templateToInitial(t))}
                      >
                        {t.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <button onClick={() => openAdd(null)}>+ Add entry</button>
            )}
            <CloseSheetButton
              sheetId={sheet.id}
              pairId={pairId}
              currencies={sheet.enabled_currencies}
              closingDays={Number(sheet.closing_window_days)}
              entries={entries.map((e) => e.payload)}
            />
          </>
        )}
        {entries.length > 0 && (
          <button
            className="secondary"
            onClick={() => onExportCsv()}
            title="Download as CSV for Google Sheets"
          >
            ⤓ Export CSV
          </button>
        )}
        {!modal && (
          <button
            className="secondary"
            onClick={() => setTypesOpen(true)}
            title="Create or edit reusable transaction types"
          >
            Add type
          </button>
        )}
      </div>

      <section className="history">
        <div className="history-head">
          <h2>History</h2>
          {entries.length > 1 && (
            <label className="sort">
              <span className="muted small">Sort:</span>
              <select
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value as SortKey)}
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {entries.length === 0 ? (
          <p className="muted">📝 No entries yet. Add one above.</p>
        ) : (
          <ul>
            {sorted.map((e) => {
              const mine = e.created_by === me;
              const sign = e.payload.direction === "credit" ? "+" : "−";
              return (
                <li key={e.id}>
                  <div className="row-1">
                    <strong>{e.payload.note || "(no note)"}</strong>
                    <span className="muted small">
                      {" · "}
                      {new Date(e.payload.ts).toISOString().slice(0, 10)}
                      {" · "}
                      {mine ? "you" : themShort}
                      {" · "}
                      {e.payload.direction === "credit" ? "Credit" : "Debit"}
                      {" · "}
                      {e.payload.txn_type === "settlement" ? "settlement" : "IOU"}
                      {e.updated_at_server ? " (edited)" : ""}
                    </span>
                  </div>
                  <div
                    className={`row-2 ${
                      e.payload.direction === "credit" ? "amt-credit" : "amt-debt"
                    }`}
                  >
                    {sign}
                    {formatMinor(e.payload.amount_minor, e.payload.currency)}
                  </div>
                  {e.payload.fee && (
                    <div className="muted small">
                      {formatMinor(e.payload.fee.gross_amount_minor, e.payload.currency)}
                      {e.payload.fee.percent > 0 ? ` − ${e.payload.fee.percent}%` : ""}
                      {e.payload.fee.fixed_minor
                        ? ` − ${formatMinor(e.payload.fee.fixed_minor, e.payload.currency)}`
                        : ""}
                      {" fee → net "}
                      {formatMinor(e.payload.amount_minor, e.payload.currency)}
                    </div>
                  )}
                  {formatSchedule(e.payload) && (
                    <div className="muted small">{formatSchedule(e.payload)}</div>
                  )}
                  {e.payload.convert && (
                    <div className="muted small">
                      from {e.payload.convert.from_amount_minor / 100}{" "}
                      {e.payload.convert.from_currency} @{" "}
                      {e.payload.convert.rate.toFixed(4)} (
                      {e.payload.convert.rate_source})
                    </div>
                  )}
                  {mine && isActive(sheet.state) && (
                    <button
                      className="small"
                      onClick={() =>
                        setModal({ initial: e.payload, entryId: e.id })
                      }
                    >
                      edit
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {modal && (
        <div className="modal-backdrop" onClick={() => setModal(null)}>
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <h3>{modal.entryId != null ? "Edit entry" : "Add entry"}</h3>
            <EntryForm
              enabledCurrencies={sheet.enabled_currencies}
              myPrincipal={me}
              partnerPrincipal={them}
              initial={modal.initial ?? undefined}
              isEdit={modal.entryId != null}
              onCancel={() => setModal(null)}
              onSubmit={onSubmit}
            />
          </div>
        </div>
      )}

      {typesOpen && (
        <div className="modal-backdrop" onClick={() => setTypesOpen(false)}>
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            style={{ maxHeight: "85vh", overflowY: "auto" }}
          >
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="secondary small" onClick={() => setTypesOpen(false)}>
                Close
              </button>
            </div>
            <TemplatesManager />
          </div>
        </div>
      )}
    </div>
  );
}
