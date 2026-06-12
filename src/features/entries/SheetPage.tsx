// /sheet/:sheetId — the main IOU page.
//
// Loads the sheet, decrypts all entries with K_sheet, shows balance
// cards and the history list. The "Add entry" button opens the form
// in a modal. Editing an entry navigates to /sheet/:sheetId/edit/:id.

import { useEffect, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { Principal } from "@dfinity/principal";
import { unwrap, isActive, isClosed, useActor } from "../flows/useActor";
import { useSheetKey } from "../flows/SheetKeyContext";
import { useAuth } from "../auth/AuthProvider";
import { decryptEntryPayload } from "../crypto/devVetkd";
import { decodeEntry, type EntryPayload } from "./types";
import { computeBalances, formatMinor } from "./balance";
import { EntryForm } from "./EntryForm";
import { encryptEntryPayload } from "../crypto/devVetkd";

type DecryptedEntry = {
  id: number;
  created_by: string;
  created_at_server: number;
  updated_at_server: number | null;
  payload: EntryPayload;
};

export function SheetPage() {
  const { sheetId = "" } = useParams();
  const navigate = useNavigate();
  const { state } = useAuth();
  const { actor } = useActor();
  const { get, unwrapFor } = useSheetKey();

  const [sheet, setSheet] = useState<any>(null);
  const [entries, setEntries] = useState<DecryptedEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const myPrincipal = state.kind === "authenticated"
    ? state.identity.getPrincipal().toText()
    : "";
  const partnerPrincipal = sheet && sheet.member_a
    ? (sheet.member_a === myPrincipal ? sheet.member_b : sheet.member_a)
    : "";

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
      // Newest first.
      dec.sort((a, b) => b.payload.ts - a.payload.ts);
      setEntries(dec);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actor, sheetId]);

  async function onAdd(p: EntryPayload) {
    if (!actor) return;
    const K_sheet = get(sheetId) ?? (await unwrapFor(sheetId));
    const enc = await encryptEntryPayload(
      new TextEncoder().encode(JSON.stringify(p)),
      K_sheet,
    );
    await (actor as any).add_entry({
      sheet_id: sheetId,
      entry_key: Array.from(enc.entryKey),
      ciphertext: Array.from(enc.ciphertext),
      iv: Array.from(enc.iv),
    });
    setAdding(false);
    await reload();
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

  return (
    <div className="sheet-page">
      <header>
        <Link to="/pairs">← Pairs</Link>
        <h1>Sheet {sheet.id.slice(0, 8)}…</h1>
        <p className="muted small">
          with <code>{them.slice(0, 8)}…</code> ·{" "}
          {isActive(sheet.state) ? "Active" : "Closed"} ·{" "}
          {sheet.enabled_currencies.join(", ")}
        </p>
      </header>

      <section className="balances">
        <h2>Balances</h2>
        {balances.length === 0 ? (
          <p className="muted">All settled. Add an entry to get started.</p>
        ) : (
          <ul>
            {balances.map((b) => {
              const iOweThem = b.amount_minor < 0;
              return (
                <li key={b.currency}>
                  <strong>
                    {iOweThem
                      ? `You owe ${them.slice(0, 5)}…`
                      : `${them.slice(0, 5)}… owes you`}
                  </strong>{" "}
                  {formatMinor(Math.abs(b.amount_minor), b.currency)}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {isActive(sheet.state) && !adding && (
        <div className="row">
          <button onClick={() => setAdding(true)}>+ Add entry</button>
        </div>
      )}

      {adding && (
        <EntryForm
          enabledCurrencies={sheet.enabled_currencies}
          myPrincipal={me}
          partnerPrincipal={them}
          onCancel={() => setAdding(false)}
          onSubmit={onAdd}
        />
      )}

      <section className="history">
        <h2>History</h2>
        {entries.length === 0 ? (
          <p className="muted">No entries yet.</p>
        ) : (
          <ul>
            {entries.map((e) => {
              const mine = e.created_by === me;
              const sign = e.payload.direction === "credit" ? "+" : "−";
              return (
                <li key={e.id}>
                  <div>
                    <strong>{e.payload.note || "(no note)"}</strong>
                    <span className="muted small">
                      {" · "}
                      {new Date(e.payload.ts).toISOString().slice(0, 10)}
                      {" · "}
                      {mine ? "you" : "them"}
                      {e.updated_at_server ? " (edited)" : ""}
                    </span>
                  </div>
                  <div>
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
                      onClick={() => navigate(`/sheet/${sheetId}/edit/${e.id}`)}
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
    </div>
  );
}
