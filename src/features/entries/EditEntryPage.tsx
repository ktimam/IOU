// /sheet/:sheetId/edit/:entryId — load existing entry, decrypt,
// pre-fill the form, on submit re-encrypt and call edit_entry.

import { useEffect, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { unwrap, useActor } from "../flows/useActor";
import { useSheetKey } from "../flows/SheetKeyContext";
import { useAuth } from "../auth/AuthProvider";
import { decryptEntryPayload, encryptEntryPayload } from "../crypto/devVetkd";
import { decodeEntry, type EntryPayload } from "./types";
import { EntryForm } from "./EntryForm";

export function EditEntryPage() {
  const { sheetId = "", entryId = "" } = useParams();
  const navigate = useNavigate();
  const { state } = useAuth();
  const { actor } = useActor();
  const { get, unwrapFor } = useSheetKey();

  const [sheet, setSheet] = useState<any>(null);
  const [initial, setInitial] = useState<EntryPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!actor || !sheetId) return;
    (async () => {
      try {
        const sh = unwrap(await (actor as any).get_sheet(sheetId));
        setSheet(sh);
        const K_sheet = get(sheetId) ?? (await unwrapFor(sheetId));
        const e = unwrap(await (actor as any).get_entry(sheetId, BigInt(entryId)));
        if (!e) {
          setErr("entry not found");
          return;
        }
        const pt = await decryptEntryPayload(
          new Uint8Array(e.entry_key),
          new Uint8Array(e.iv),
          new Uint8Array(e.ciphertext),
          K_sheet,
        );
        setInitial(decodeEntry(pt));
      } catch (e) {
        setErr((e as Error).message);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actor, sheetId, entryId]);

  async function onSubmit(p: EntryPayload) {
    if (!actor) return;
    setSubmitting(true);
    try {
      const K_sheet = get(sheetId) ?? (await unwrapFor(sheetId));
      const enc = await encryptEntryPayload(
        new TextEncoder().encode(JSON.stringify(p)),
        K_sheet,
      );
      await (actor as any).edit_entry({
        sheet_id: sheetId,
        entry_id: BigInt(entryId),
        entry_key: Array.from(enc.entryKey),
        ciphertext: Array.from(enc.ciphertext),
        iv: Array.from(enc.iv),
      });
      navigate(`/sheet/${sheetId}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  if (!state.kind || state.kind !== "authenticated") return <p>Please sign in.</p>;
  if (err) return <p className="err">{err}</p>;
  if (!sheet || !initial) return <p>Loading…</p>;

  const me = state.identity.getPrincipal().toText();
  const partner = sheet.member_a === me ? sheet.member_b : sheet.member_a;

  return (
    <div>
      <Link to={`/sheet/${sheetId}`}>← Sheet</Link>
      <h2>Edit entry</h2>
      <EntryForm
        enabledCurrencies={sheet.enabled_currencies}
        myPrincipal={me}
        partnerPrincipal={partner}
        initial={initial}
        onCancel={() => navigate(`/sheet/${sheetId}`)}
        onSubmit={onSubmit}
      />
    </div>
  );
}
