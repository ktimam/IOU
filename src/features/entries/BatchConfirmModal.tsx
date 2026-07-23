// Batch confirm-all modal for a multi-entry chat card (Issue 2).
//
// A single confirmable-action card can carry SEVERAL entries (the confirmPayload was a JSON array).
// The whole array rides inside ONE card → ONE human confirm → ONE deposit → ONE messageId consumed.
// This modal lists every parsed entry read-only and offers a single "Add all N entries" button, so
// the human confirms the batch once. Individual field-editing stays the single-entry EntryForm's job
// (a batch is confirm-as-extracted); nothing is written until "Add all" is clicked.

import type { ParsedDraft } from "./draft";

type BatchConfirmModalProps = {
  drafts: ParsedDraft[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  // Optional "remember this chat → this sheet" checkbox (shown only for a chat with no mapping yet).
  showRemember?: boolean;
  remember?: boolean;
  onRememberChange?: (v: boolean) => void;
  rememberLabel?: string;
};

export function BatchConfirmModal({
  drafts,
  busy,
  onCancel,
  onConfirm,
  showRemember = false,
  remember = true,
  onRememberChange,
  rememberLabel = "Remember: always import this chat's drafts into this sheet",
}: BatchConfirmModalProps) {
  const n = drafts.length;
  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onCancel}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        style={{ maxHeight: "85vh", overflowY: "auto" }}
      >
        <h3>Add {n} entries?</h3>
        <p className="muted small" style={{ marginTop: 0 }}>
          Your assistant extracted {n} transactions from one message. Review them below — nothing is
          written until you confirm. Confirming adds all {n} at once.
        </p>
        {showRemember && (
          <label
            className="row muted small"
            style={{ gap: 6, alignItems: "center", marginBottom: 8 }}
          >
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => onRememberChange?.(e.target.checked)}
            />
            <span>{rememberLabel}</span>
          </label>
        )}
        <ul style={{ listStyle: "none", padding: 0, margin: "8px 0" }}>
          {drafts.map((d, i) => (
            <li
              key={d.draftId}
              className="row"
              style={{ gap: 8, padding: "6px 0", borderTop: i === 0 ? undefined : "1px solid var(--border, #333)" }}
            >
              <span className="muted small" style={{ minWidth: 20 }}>
                {i + 1}.
              </span>
              <span className="small">{d.summary}</span>
            </li>
          ))}
        </ul>
        <div className="actions" style={{ marginTop: 8 }}>
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" onClick={onConfirm} disabled={busy}>
            {busy ? "Adding…" : `Add all ${n} entries`}
          </button>
        </div>
      </div>
    </div>
  );
}
