// Settings card for the ON-CHAIN action inbox path (the successor to the relay).
//
// Two things the consumer must do to receive OpenChat-confirmed actions on-chain:
//   1. Register THIS device's consumer public key with OpenChat as the action's `recipient_public_key`
//      (OpenChat encrypts every confirmed action to it). We show the SPKI PEM + a copy button.
//   2. Point the app at the action_inbox canister (id + host) so SheetPage's poll activates.
//      We persist that to the same localStorage key getActionInboxConfig() reads.
//
// The private key never leaves this device; decryption happens here on poll. Nothing is written to a sheet
// until the user Accepts, exactly like the relay path.

import { useEffect, useState } from "react";
import { loadOrCreateConsumerKeypair } from "./consumerKeypair";

const LS_INBOX = "iou.openchat.actionInbox.v1";

function loadCfg(): { canisterId: string; host: string } {
  try {
    const raw = globalThis.localStorage?.getItem(LS_INBOX);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return { canisterId: "", host: "http://127.0.0.1:4943" };
}

export function ActionInboxSettings() {
  const [pubKeyPem, setPubKeyPem] = useState<string>("");
  const [fingerprint, setFingerprint] = useState<string>("");
  const [canisterId, setCanisterId] = useState(loadCfg().canisterId);
  const [host, setHost] = useState(loadCfg().host);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const kp = await loadOrCreateConsumerKeypair();
        setPubKeyPem(kp.publicKeySpkiPem);
        setFingerprint(Array.from(kp.fingerprint).map((b) => b.toString(16).padStart(2, "0")).join(""));
      } catch {
        /* WebCrypto unavailable */
      }
    })();
  }, []);

  const copy = (t: string) => {
    try {
      void navigator.clipboard?.writeText(t);
    } catch {
      /* ignore */
    }
  };

  const save = () => {
    try {
      globalThis.localStorage?.setItem(LS_INBOX, JSON.stringify({ canisterId: canisterId.trim(), host: host.trim() }));
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="card">
      <h2>OpenChat action inbox (on-chain)</h2>
      <p className="muted small">
        Receive OpenChat-confirmed actions <em>on-chain</em>, end-to-end encrypted — no relay. Register this
        device's public key with the OpenChat action as its <code>recipient_public_key</code>, then point the
        app at the inbox canister. Confirmed actions appear under “Pending from chat”; the encrypted entry is
        still written on <em>this device</em> when you Accept.
      </p>

      <p className="muted small" style={{ marginTop: 8 }}>
        This device's consumer public key (register it with OpenChat):
      </p>
      <textarea
        readOnly
        value={pubKeyPem}
        rows={4}
        style={{ width: "100%", fontFamily: "monospace", fontSize: "0.75rem" }}
        onFocusCapture={(e) => e.currentTarget.select()}
      />
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="secondary small" onClick={() => copy(pubKeyPem)} disabled={!pubKeyPem}>
          Copy public key
        </button>
        {fingerprint && <span className="muted small">fingerprint: {fingerprint.slice(0, 16)}…</span>}
      </div>

      <p className="muted small" style={{ marginTop: 12 }}>
        action_inbox canister:
      </p>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <input
          placeholder="canister id (e.g. uxrrr-…-cai)"
          value={canisterId}
          onChange={(e) => setCanisterId(e.target.value)}
          style={{ flex: "1 1 220px", fontFamily: "monospace" }}
        />
        <input
          placeholder="host"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          style={{ flex: "1 1 160px", fontFamily: "monospace" }}
        />
        <button type="button" onClick={save} disabled={!canisterId.trim()}>
          {saved ? "Saved ✓" : "Save"}
        </button>
      </div>

      <span className="lock-cue" style={{ marginTop: 8 }}>
        🔒 your private key never leaves this device
      </span>
    </div>
  );
}
