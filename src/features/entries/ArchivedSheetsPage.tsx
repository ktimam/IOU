// /pair/:pairId/archived — list closed sheets for the pair, with a
// per-sheet read-only view (decrypted).

import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useActor } from "../flows/useActor";
import { useSheetKey } from "../flows/SheetKeyContext";
import { useAuth } from "../auth/AuthProvider";
import { decryptEntryPayload } from "../crypto/devVetkd";
import { decodeEntry, type EntryPayload } from "./types";
import { computeBalances, formatMinor } from "./balance";

type DecryptedEntry = {
  id: number;
  payload: EntryPayload;
  created_by: string;
};

export function ArchivedSheetsPage() {
  const { pairId = "" } = useParams();
  const { state } = useAuth();
  const { actor } = useActor();
  const { get, unwrapFor } = useSheetKey();

  const [sheets, setSheets] = useState<any[]>([]);
  const [entriesBySheet, setEntriesBySheet] = useState<
    Record<string, DecryptedEntry[]>
  >({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!actor || !pairId) return;
    (async () => {
      try {
        setLoading(true);
        const list = await (actor as any).list_archived_sheets(pairId);
        setSheets(list);
        const map: Record<string, DecryptedEntry[]> = {};
        for (const sh of list) {
          try {
            const K_sheet = get(sh.id) ?? (await unwrapFor(sh.id));
            const res = await (actor as any).list_entries(sh.id, [], 200);
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
                payload: decodeEntry(pt),
                created_by: e.created_by.toText(),
              });
            }
            dec.sort((a, b) => b.payload.ts - a.payload.ts);
            map[sh.id] = dec;
          } catch (e) {
            // A sheet we can't decrypt is just shown without entries.
            map[sh.id] = [];
            console.warn("decrypt failed for archived sheet", sh.id, e);
          }
        }
        setEntriesBySheet(map);
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actor, pairId]);

  if (!state.kind || state.kind !== "authenticated") {
    return <p>Please sign in.</p>;
  }
  if (loading) return <p>Loading…</p>;
  if (err) return <p className="err">{err}</p>;

  return (
    <div>
      <Link to={`/pair/${pairId}`}>← Pair</Link>
      <h1>Archived sheets</h1>
      {sheets.length === 0 ? (
        <p className="muted">📦 No archived sheets yet.</p>
      ) : (
        sheets.map((sh) => {
          const entries = entriesBySheet[sh.id] ?? [];
          const balances = computeBalances(entries.map((e) => e.payload));
          const me = state.identity.getPrincipal().toText();
          // member_a/member_b are Principal objects (Candid), not strings —
          // normalize before comparing/slicing or the page crashes blank.
          const principalText = (p: any): string =>
            p && typeof p.toText === "function" ? p.toText() : String(p ?? "");
          const them =
            principalText(sh.member_a) === me
              ? principalText(sh.member_b)
              : principalText(sh.member_a);
          const closedAtNum = Array.isArray(sh.closed_at) && sh.closed_at.length
            ? Number(sh.closed_at[0])
            : Number(sh.closed_at);
          return (
            <div key={sh.id} className="card">
              <p className="muted small">
                Closed{" "}
                {new Date(closedAtNum / 1_000_000).toLocaleString()} ·{" "}
                with {them.slice(0, 8)}… · {sh.enabled_currencies.join(", ")}
              </p>
              <h3>
                Sheet {sh.id.slice(0, 8)}…
                <span className="muted small"> (Closed)</span>
              </h3>
              {balances.length === 0 ? (
                <p className="muted small">All settled.</p>
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
              <details>
                <summary className="muted small">
                  {entries.length} entr{entries.length === 1 ? "y" : "ies"}
                </summary>
                <ul>
                  {entries.map((e) => (
                    <li key={e.id}>
                      <strong>{e.payload.note || "(no note)"}</strong>{" "}
                      <span className="muted small">
                        · {new Date(e.payload.ts).toISOString().slice(0, 10)} ·{" "}
                        {e.payload.direction === "credit" ? "+" : "−"}
                        {formatMinor(
                          e.payload.amount_minor,
                          e.payload.currency,
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          );
        })
      )}
    </div>
  );
}
