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
import { decryptEntryPayload, encryptEntryPayload } from "../crypto/devVetkd";
import { decodeEntry, type EntryPayload } from "./types";
import { computeBalances, formatMinor } from "./balance";
import { EntryForm } from "./EntryForm";
import { CloseSheetButton } from "./CloseSheetButton";
import { downloadCsv, entriesToCsv } from "./csvExport";
import { useToasts } from "../ui/Toasts";

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

  const [sheet, setSheet] = useState<any>(null);
  const [entries, setEntries] = useState<DecryptedEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [modal, setModal] = useState<null | {
    initial: EntryPayload | null;
    entryId: number | null;
  }>(null);
  const [sortKey, setSortKey] = useState<SortKey>("newest");

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

  const balances = computeBalances(entries.map((e) => e.payload));
  const me = myPrincipal;
  const them = partnerPrincipal;
  // Solo sheet: partner slot is the anonymous principal until a partner
  // joins and is granted access. Show friendly copy instead of "2vxsx…".
  const ANON = "2vxsx-fae";
  const isSolo = them === "" || them === ANON;
  const themShort = isSolo ? "your partner" : `${them.slice(0, 5)}…`;

  return (
    <div className="sheet-page">
      <header>
        <Link to="/pairs">← Pairs</Link>
        <h1>Sheet {sheet.id.slice(0, 8)}…</h1>
        <p className="muted small">
          {isSolo ? (
            "Solo sheet"
          ) : (
            <>
              with <code>{them.slice(0, 8)}…</code>
            </>
          )}{" "}
          · {isActive(sheet.state) ? "Active" : "Closed"} ·{" "}
          {sheet.enabled_currencies.join(", ")}
        </p>
      </header>

      <section className="balances">
        <h2>Balances</h2>
        {balances.length === 0 ? (
          <p className="muted">
            🎉 All settled. Add an entry to get started.
          </p>
        ) : (
          <ul>
            {balances.map((b) => {
              const iOweThem = b.amount_minor < 0;
              return (
                <li key={b.currency}>
                  <strong>
                    {iOweThem
                      ? `You owe ${themShort}`
                      : `${themShort} owes you`}
                  </strong>{" "}
                  <span className={`amt ${iOweThem ? "amt-debt" : "amt-credit"}`}>
                    {formatMinor(Math.abs(b.amount_minor), b.currency)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div className="row">
        {isActive(sheet.state) && !modal && (
          <>
            <button onClick={() => setModal({ initial: null, entryId: null })}>
              + Add entry
            </button>
            <CloseSheetButton
              sheetId={sheet.id}
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
                      {mine ? "you" : "them"}
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
              onCancel={() => setModal(null)}
              onSubmit={onSubmit}
            />
          </div>
        </div>
      )}
    </div>
  );
}
