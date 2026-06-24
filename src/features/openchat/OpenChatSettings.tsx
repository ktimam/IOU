// Settings card: link an OpenChat account to this device's relay token so an
// OpenChat-confirmed transaction draft routes into the "Pending from chat"
// inbox. Pairing is started here (the app holds the link token); the user gives
// the short code to the IOU integration inside OpenChat, which claims it with a
// provenance token. The relay stays key-blind — the encrypted write still
// happens on this device on Accept. See docs/chat-agent.md.

import { useEffect, useState } from "react";
import {
  getRelayConfig,
  startPairing,
  listPairings,
  revokePairing,
  type OpenChatPairing,
} from "../relay/relay";

export function OpenChatSettings() {
  const [pairings, setPairings] = useState<OpenChatPairing[]>([]);
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const cfg = getRelayConfig();

  const reload = async () => {
    if (!cfg) return;
    try {
      setPairings(await listPairings(cfg));
    } catch {
      /* relay unreachable — leave list as-is */
    }
  };
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!cfg) {
    return (
      <div className="card">
        <h2>OpenChat link</h2>
        <p className="muted small">
          Set up “Chat import (relay)” above first — OpenChat forwards drafts through it.
        </p>
      </div>
    );
  }

  const link = async () => {
    setBusy(true);
    setErr(null);
    try {
      setCode((await startPairing(cfg)).code);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (sub: string) => {
    await revokePairing(cfg, sub);
    await reload();
  };
  const copy = (t: string) => {
    try {
      void navigator.clipboard?.writeText(t);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="card">
      <h2>OpenChat link</h2>
      <p className="muted small">
        Link an OpenChat account so a transaction screenshot you confirm in OpenChat lands here as
        “Pending from chat”. The encrypted entry is still written on <em>this device</em> when you
        Accept — OpenChat only ever sees the draft fields (never your encryption key).
      </p>

      <div className="cta">
        <button onClick={link} disabled={busy}>
          {busy ? "…" : "Link an OpenChat account"}
        </button>
      </div>
      {err && <p style={{ color: "var(--debt)" }}>{err}</p>}
      {code && (
        <div className="card" style={{ marginTop: 8 }}>
          <p className="muted small">
            Give this pairing code to the IOU integration in OpenChat (expires in ~10 min):
          </p>
          <div className="row" style={{ gap: 8, alignItems: "center" }}>
            <code style={{ fontSize: "1.2rem", letterSpacing: 1 }}>{code}</code>
            <button type="button" className="secondary small" onClick={() => copy(code)}>
              Copy
            </button>
          </div>
        </div>
      )}

      {pairings.length > 0 && (
        <>
          <p className="muted small" style={{ marginTop: 12 }}>
            Linked OpenChat accounts:
          </p>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {pairings.map((p) => (
              <li
                key={p.openchat_user}
                className="row"
                style={{ justifyContent: "space-between", alignItems: "center", padding: "4px 0" }}
              >
                <code className="small">{p.openchat_user}</code>
                <button
                  type="button"
                  className="secondary small"
                  onClick={() => void revoke(p.openchat_user)}
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <span className="lock-cue">🔒 nothing is written until you Accept on the sheet</span>
    </div>
  );
}
