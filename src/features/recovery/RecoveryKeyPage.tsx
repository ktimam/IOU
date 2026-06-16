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
//
// V9b fix (v1.3.1): the mnemonic is encrypted at rest with
// AES-256-GCM under a passphrase-derived key (PBKDF2-SHA-256,
// 310k iterations, 16-byte salt). The user has to enter a
// passphrase to save and to unlock.

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
  const [passphrase, setPassphrase] = useState("");
  const [unlockPassphrase, setUnlockPassphrase] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);
  const [hasExisting, setHasExisting] = useState(false);

  useEffect(() => {
    (async () => {
      // We can't decrypt without the passphrase, so we just
      // probe IndexedDB. If an entry exists, we show the
      // "unlock with passphrase" form instead of generating a
      // new mnemonic. For a v1 (plaintext) legacy entry we
      // treat it as "not set" so the user re-saves with a
      // passphrase.
      const existing = await loadRecoveryMnemonic("");
      // The above call throws "wrong passphrase" if an
      // encrypted entry exists; that's our signal. (A
      // null return means either no entry or a v1 entry.)
      void existing;
      const raw = await probeEncryptedMnemonic();
      if (raw) {
        setHasExisting(true);
      } else {
        setMnemonic(newRecoveryMnemonic());
      }
      setLoading(false);
    })();
  }, []);

  async function probeEncryptedMnemonic(): Promise<boolean> {
    // Lazy import to keep the page bundle small. Mirrors
    // `mnemonic.ts` storage key + magic check.
    const { idbGet } = await import("./idb");
    const raw = await idbGet("iou:recovery:v2");
    if (!raw) return false;
    if (typeof raw === "string") return false;
    if (!(raw instanceof Uint8Array) || raw.length < 4) return false;
    return raw[0] === 0xa7 && raw[1] === 0xc1 && raw[2] === 0x4e && raw[3] === 0xd2;
  }

  async function onSave() {
    if (!mnemonic || !confirmed) {
      toasts.show({ kind: "error", text: "Confirm you've saved the key" });
      return;
    }
    if (!isValidMnemonic(mnemonic)) {
      toasts.show({ kind: "error", text: "Invalid mnemonic" });
      return;
    }
    if (passphrase.length < 8) {
      toasts.show({ kind: "error", text: "Passphrase must be at least 8 characters" });
      return;
    }
    try {
      await saveRecoveryMnemonic(mnemonic, passphrase);
      setSaved(true);
      setPassphrase("");  // clear from state after persistence
      toasts.show({ kind: "success", text: "Recovery key saved (encrypted)" });
    } catch (e) {
      toasts.show({ kind: "error", text: `Save failed: ${(e as Error).message}` });
    }
  }

  async function onUnlock() {
    if (!unlockPassphrase) {
      toasts.show({ kind: "error", text: "Enter your passphrase" });
      return;
    }
    try {
      const m = await loadRecoveryMnemonic(unlockPassphrase);
      if (m) {
        setMnemonic(m);
        setConfirmed(true);
        setSaved(true);
        setUnlockPassphrase("");
        toasts.show({ kind: "success", text: "Recovery key unlocked" });
      } else {
        toasts.show({ kind: "error", text: "No saved recovery key" });
      }
    } catch (e) {
      toasts.show({ kind: "error", text: (e as Error).message });
    }
  }

  async function onForget() {
    await forgetRecoveryMnemonic();
    setSaved(false);
    setHasExisting(false);
    setMnemonic(newRecoveryMnemonic());
    setConfirmed(false);
    setPassphrase("");
    toasts.show({ kind: "info", text: "Recovery key cleared" });
  }

  if (loading) return <p>Loading…</p>;

  // Saved: show a "you're set" message and a forget button.
  if (saved) {
    return (
      <div className="recovery-page">
        <h1>Recovery key</h1>
        <p className="muted">
          Your recovery phrase is saved, encrypted on this device.
        </p>
        <p className="muted">
          <strong>Reminder:</strong> the passphrase you chose at
          save time is the only way to unlock this device's copy.
          If you forget it, you can't recover from this device —
          you'll need to re-save the phrase.
        </p>
        <div className="actions">
          <button className="secondary" onClick={onForget}>
            Forget saved key
          </button>
          <button onClick={() => nav("/")}>Done</button>
        </div>
      </div>
    );
  }

  // Existing encrypted entry but not unlocked: show unlock form.
  if (hasExisting && !mnemonic) {
    return (
      <div className="recovery-page">
        <h1>Recovery key</h1>
        <p className="muted">
          A recovery phrase is saved on this device, encrypted
          with your passphrase. Enter it to unlock.
        </p>
        <label className="passphrase">
          Passphrase
          <input
            type="password"
            value={unlockPassphrase}
            onChange={(e) => setUnlockPassphrase(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        <div className="actions">
          <button onClick={onUnlock} disabled={!unlockPassphrase}>
            Unlock
          </button>
        </div>
      </div>
    );
  }

  // No existing entry: show the create form.
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
      <label className="passphrase">
        Passphrase (min 8 chars; encrypts the key on this device)
        <input
          type="password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          autoComplete="new-password"
        />
      </label>
      <div className="actions">
        <button
          onClick={onSave}
          disabled={!confirmed || passphrase.length < 8}
        >
          Save recovery key
        </button>
      </div>
    </div>
  );
}
