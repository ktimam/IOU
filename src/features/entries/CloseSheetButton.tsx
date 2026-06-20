// "Close & start new sheet" button + confirm modal. Shown when the sheet
// is Active and the user is a member. On confirm it: records the closing
// balances and closes the sheet, opens a fresh sheet for the same account
// (re-encrypting the account/your names under the new key), and carries
// the outstanding balance forward as opening entries.

import { useState } from "react";
import { computeBalances, formatMinor } from "./balance";
import type { EntryPayload } from "./types";
import { useActor } from "../flows/useActor";
import { useAuth } from "../auth/AuthProvider";
import { useSheetKey } from "../flows/SheetKeyContext";
import { usePreferences } from "../settings/usePreferences";
import { createSheetForPair, publishAccountNames } from "../flows/createSheet";
import { encryptEntryPayload } from "../crypto/devVetkd";
import { useToasts } from "../ui/Toasts";
import { useNavigate } from "react-router-dom";

interface CloseSheetButtonProps {
  sheetId: string;
  pairId: string;
  currencies: string[];
  closingDays: number;
  entries: EntryPayload[];
}

export function CloseSheetButton({
  sheetId,
  pairId,
  currencies,
  closingDays,
  entries,
}: CloseSheetButtonProps) {
  const { actor } = useActor();
  const { state } = useAuth();
  const { cache } = useSheetKey();
  const { prefs } = usePreferences();
  const toasts = useToasts();
  const nav = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const balances = computeBalances(entries);

  async function confirm() {
    if (!actor || state.kind !== "authenticated") return;
    setSubmitting(true);
    try {
      // 1. Record closing balances + close the old sheet.
      const payload = balances.map((b) => ({
        currency: b.currency,
        amount_minor: BigInt(Math.abs(b.amount_minor)),
        direction: b.amount_minor < 0 ? { Debt: null } : { Credit: null },
      }));
      await (actor as any).close_sheet(sheetId, payload);

      // 2. Open a fresh sheet for the same account.
      const { sheet: newSheet, K_sheet } = await createSheetForPair(
        actor,
        state.identity,
        { pairId, currencies, closingDays },
      );
      // 3. Re-publish account + your names under the new sheet's key.
      await publishAccountNames(actor, K_sheet, {
        pairId,
        accountName: prefs.accountNames[pairId],
        profileName: prefs.profileName,
      });
      cache(newSheet.id, K_sheet);

      // 4. Carry the outstanding balance forward as opening entries (one per
      //    currency), due now so they show in every balance bucket.
      const now = Date.now();
      for (const b of balances) {
        const p: EntryPayload = {
          ts: now,
          kind: "expense",
          currency: b.currency,
          amount_minor: Math.abs(b.amount_minor),
          direction: b.amount_minor < 0 ? "debt" : "credit",
          note: `Carried forward from sheet ${sheetId.slice(0, 8)}…`,
          txn_type: "iou",
          schedule: [{ due_ts: now, percent: 100 }],
        };
        const enc = await encryptEntryPayload(
          new TextEncoder().encode(JSON.stringify(p)),
          K_sheet,
        );
        await (actor as any).add_entry({
          sheet_id: newSheet.id,
          entry_key: Array.from(enc.entryKey),
          ciphertext: Array.from(enc.ciphertext),
          iv: Array.from(enc.iv),
        });
      }

      toasts.show({ kind: "success", text: "Sheet closed — new sheet started" });
      nav(`/sheet/${newSheet.id}`, { replace: true });
    } catch (e) {
      toasts.show({ kind: "error", text: (e as Error).message });
    } finally {
      setSubmitting(false);
      setConfirming(false);
    }
  }

  return (
    <>
      <button
        className="secondary"
        onClick={() => setConfirming(true)}
        disabled={entries.length === 0}
      >
        🔒 Close &amp; start new
      </button>

      {confirming && (
        <div className="modal-backdrop" onClick={() => setConfirming(false)}>
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <h3>Close this sheet?</h3>
            <p>
              This sheet will be archived and a fresh one started. Any
              outstanding balance is carried forward to the new sheet.
            </p>
            {balances.length === 0 ? (
              <p className="muted">All settled — nothing to carry forward.</p>
            ) : (
              <ul className="closing-balances">
                {balances.map((b) => {
                  const iOweThem = b.amount_minor < 0;
                  return (
                    <li key={b.currency}>
                      <strong>{iOweThem ? "You owe" : "You're owed"}</strong>{" "}
                      {formatMinor(Math.abs(b.amount_minor), b.currency)}
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="actions">
              <button
                className="secondary"
                onClick={() => setConfirming(false)}
                disabled={submitting}
              >
                Cancel
              </button>
              <button onClick={confirm} disabled={submitting}>
                {submitting ? "Closing…" : "Yes, close & start new"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
