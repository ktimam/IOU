// "Save your recovery key" first-sign-in flow.
//
// v1.1.0: on first sign-in (or whenever the user has no recovery
// key saved), show this page. The user must explicitly save the
// mnemonic before they can continue. The mnemonic is required to
// recover access if they lose their II.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  isValidMnemonic,
  loadRecoveryMnemonic,
  newRecoveryMnemonic,
  saveRecoveryMnemonic,
} from "./mnemonic";
import { useToasts } from "../ui/Toasts";

export function RecoveryKeyPage() {
  const nav = useNavigate();
  const toasts = useToasts();
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const existing = await loadRecoveryMnemonic();
      if (existing) {
        setMnemonic(existing);
        // If the user already has one saved, they can skip this page.
        setConfirmed(true);
      } else {
        setMnemonic(newRecoveryMnemonic());
      }
      setLoading(false);
    })();
  }, []);

  async function onContinue() {
    if (!mnemonic || !confirmed) {
      toasts.show({ kind: "error", text: "Confirm you've saved the key" });
      return;
    }
    if (!isValidMnemonic(mnemonic)) {
      toasts.show({ kind: "error", text: "Invalid mnemonic" });
      return;
    }
    await saveRecoveryMnemonic(mnemonic);
    toasts.show({ kind: "success", text: "Recovery key saved" });
    nav("/pairs");
  }

  if (loading) return <p>Loading…</p>;
  if (!mnemonic) return <p>Error generating recovery key.</p>;

  return (
    <div className="recovery-page">
      <h1>Save your recovery key</h1>
      <p className="muted">
        If you lose access to your browser, Internet Identity, or device,
        the only way to recover your IOU data is this 24-word phrase.
        Write it down or store it in a password manager.{" "}
        <strong>Don't share it with anyone.</strong>
      </p>
      <div className="card mnemonic">
        {mnemonic.split(" ").map((w, i) => (
          <span key={i} className="word">
            <span className="idx">{i + 1}</span>
            <span>{w}</span>
          </span>
        ))}
      </div>
      <label className="confirm">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        I've saved this recovery key in a secure place.
      </label>
      <div className="actions">
        <button onClick={onContinue} disabled={!confirmed}>
          Continue →
        </button>
      </div>
    </div>
  );
}
