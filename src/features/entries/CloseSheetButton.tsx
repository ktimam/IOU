// "Close sheet" button + confirm modal. Only shown when the sheet is
// Active and the user is a member. On confirm, computes closing
// balances from the decrypted entries and calls close_sheet.

import { useState } from "react";
import { computeBalances, formatMinor } from "./balance";
import type { EntryPayload } from "./types";
import { useActor } from "../flows/useActor";
import { useToasts } from "../ui/Toasts";
import { useNavigate } from "react-router-dom";

interface CloseSheetButtonProps {
  sheetId: string;
  entries: EntryPayload[];
}

export function CloseSheetButton({ sheetId, entries }: CloseSheetButtonProps) {
  const { actor } = useActor();
  const toasts = useToasts();
  const nav = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const balances = computeBalances(entries);

  async function confirm() {
    if (!actor) return;
    setSubmitting(true);
    try {
      const payload = balances.map((b) => ({
        currency: b.currency,
        amount_minor: BigInt(Math.abs(b.amount_minor)),
        direction: b.amount_minor < 0 ? { Debt: null } : { Credit: null },
      }));
      await (actor as any).close_sheet(sheetId, payload);
      toasts.show({ kind: "success", text: "Sheet closed" });
      nav("/pairs");
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
        🔒 Close sheet
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
              Once closed, no new entries can be added. The closing
              balances below will be recorded.
            </p>
            {balances.length === 0 ? (
              <p className="muted">All settled — closing balances are zero.</p>
            ) : (
              <ul className="closing-balances">
                {balances.map((b) => {
                  const iOweThem = b.amount_minor < 0;
                  return (
                    <li key={b.currency}>
                      <strong>
                        {iOweThem ? "You owe" : "You're owed"}
                      </strong>{" "}
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
                {submitting ? "Closing…" : "Yes, close it"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
