// Settings card for the optional "Chat import" relay (no-paste path).
// Stores a relay URL + a link token locally; the user copies the env vars into
// their chat connector. The relay only ever holds the draft (never K_sheet).

import { useState } from "react";
import { getRelayUrl, getRelayToken, setRelayConfig, generateToken } from "./relay";

const DEFAULT_URL = "http://localhost:8788";

export function RelaySettings() {
  const [url, setUrl] = useState(getRelayUrl() || DEFAULT_URL);
  const [token, setToken] = useState(getRelayToken());
  const [saved, setSaved] = useState(false);
  const copy = (t: string) => {
    try {
      void navigator.clipboard?.writeText(t);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="card">
      <h2>Chat import (relay)</h2>
      <p className="muted small">
        Optional. Lets a draft your own AI assistant prepared show up in “Pending
        from chat” on a sheet — no copy-paste. The relay only ever sees the draft
        fields (never your encryption key); the entry is still encrypted on this
        device when you confirm it.
      </p>

      <label>
        <span className="muted small">Relay URL</span>
        <input
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setSaved(false);
          }}
          placeholder={DEFAULT_URL}
        />
      </label>

      <label>
        <span className="muted small">Link token — a shared secret; keep it private</span>
        <div className="row" style={{ gap: 8, alignItems: "center" }}>
          <input
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              setSaved(false);
            }}
            placeholder="generate one →"
            style={{ flex: 1, fontFamily: "monospace" }}
          />
          <button
            type="button"
            className="secondary small"
            onClick={() => {
              setToken(generateToken());
              setSaved(false);
            }}
          >
            Generate
          </button>
          <button
            type="button"
            className="secondary small"
            onClick={() => copy(token)}
            disabled={!token}
          >
            Copy
          </button>
        </div>
      </label>

      <div className="cta">
        <button
          onClick={() => {
            setRelayConfig(url, token);
            setSaved(true);
          }}
        >
          Save
        </button>
      </div>

      {saved && token && url && (
        <>
          <p className="muted small">
            Saved. Configure your connector with these env vars and restart it:
          </p>
          <pre
            className="muted small"
            style={{ whiteSpace: "pre-wrap", fontFamily: "monospace", margin: 0 }}
          >{`IOU_RELAY_URL=${url}\nIOU_LINK_TOKEN=${token}`}</pre>
        </>
      )}
    </div>
  );
}
