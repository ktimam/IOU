// Optional recovery-key page (v1.1.1+).
//
// v1.1.1 dropped the recovery-key onboarding blocker: the prod vetkd
// path (VITE_IOU_PROD_VETKD=1) lets the user sign in with II from any
// device and get instant access. The 24-word recovery phrase is now
// an *optional* backup, reachable from Settings.
//
// Why it's still here: in the dev path (VITE_IOU_PROD_VETKD=0), the
// PWA still uses a localStorage P-256 keypair, and the recovery
// phrase is the only way to rebuild that keypair on a new device.
// In the prod path, the recovery phrase is belt-and-suspenders —
// you only need it if you lose your II and need to derive the
// transport key from scratch.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  forgetRecoveryMnemonic,
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
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    (async () => {
      const existing = await loadRecoveryMnemonic();
      if (existing) {
        setMnemonic(existing);
        setConfirmed(true);
        setSaved(true);
      } else {
        setMnemonic(newRecoveryMnemonic());
      }
      setLoading(false);
    })();
  }, []);

  async function onSave() {
    if (!mnemonic || !confirmed) {
      toasts.show({ kind: "error", text: "Confirm you've saved the key" });
      return;
    }
    if (!isValidMnemonic(mnemonic)) {
      toasts.show({ kind: "error", text: "Invalid mnemonic" });
      return;
    }
    await saveRecoveryMnemonic(mnemonic);
    setSaved(true);
    toasts.show({ kind: "success", text: "Recovery key saved" });
  }

  async function onForget() {
    await forgetRecoveryMnemonic();
    setSaved(false);
    setMnemonic(newRecoveryMnemonic());
    setConfirmed(false);
    toasts.show({ kind: "info", text: "Recovery key cleared" });
  }

  if (loading) return <p>Loading…</p>;
  if (!mnemonic) return <p>Error generating recovery key.</p>;

  return (
    <div className="recovery-page">
      <h1>Recovery key</h1>
      <p className="muted">
        Optional. The prod path uses the IC's vetkd to derive your
        sheet keys from your II principal, so you don't need this. The
        dev path (P-256 in localStorage) needs this phrase to recover
        access on a new device.
      </p>
      <p className="muted">
        <strong>Anyone with this phrase has full access to your data.</strong>{" "}
        Write it down or store it in a password manager. Never share it.
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
        {saved ? (
          <>
            <button className="secondary" onClick={onForget}>
              Forget saved key
            </button>
            <button onClick={() => nav("/")}>Done</button>
          </>
        ) : (
          <button onClick={onSave} disabled={!confirmed}>
            Save recovery key
          </button>
        )}
      </div>
    </div>
  );
}
