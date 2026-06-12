// /pair/:pairId/replace — the leaving member's flow.
//
// The user enters (or pastes) the new member's principal. The PWA
// builds a ReplaceRequest, signs it with the user's Ed25519
// keypair, and shows the signed payload as a base64 blob to copy
// or hand to the staying member.
//
// In a future v1.1.5 polish, this page will also render a QR.

import { useEffect, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { Principal } from "@dfinity/principal";
import { useAuth } from "../auth/AuthProvider";
import {
  encodeForQr,
  loadOrCreateEd25519Keypair,
  randomNonce,
  signReplaceRequest,
  type ReplaceRequest,
} from "./replaceMember";
import { useToasts } from "../ui/Toasts";

export function ReplaceMemberPage() {
  const { pairId = "" } = useParams();
  const { state } = useAuth();
  const nav = useNavigate();
  const toasts = useToasts();

  const [newPrincipalText, setNewPrincipalText] = useState("");
  const [signedBlob, setSignedBlob] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [myKey, setMyKey] = useState<{ publicKeyB64: string } | null>(null);

  useEffect(() => {
    if (state.kind !== "authenticated") {
      nav("/sign-in", { replace: true });
      return;
    }
    (async () => {
      const kp = await loadOrCreateEd25519Keypair();
      setMyKey({
        publicKeyB64: bytesToB64(kp.publicKey),
      });
    })();
  }, [state, nav]);

  async function onSignAndShare() {
    if (!state.kind || state.kind !== "authenticated") return;
    setBusy(true);
    setErr(null);
    try {
      const newP = Principal.fromText(newPrincipalText.trim());
      const me = state.identity.getPrincipal();
      const req: ReplaceRequest = {
        pair_id: pairId,
        leaving_principal: me.toText(),
        new_principal: newP.toText(),
        ts_ms: BigInt(Date.now()),
        nonce: Array.from(randomNonce()),
      };
      const kp = await loadOrCreateEd25519Keypair();
      const signed = await signReplaceRequest(req, kp);
      const blob = encodeForQr(signed);
      setSignedBlob(blob);
      toasts.show({
        kind: "success",
        text: "Signed. Hand the blob to the staying member.",
      });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (state.kind !== "authenticated") return <p>Please sign in.</p>;

  return (
    <div>
      <Link to={`/pair/${pairId}`}>← Pair</Link>
      <h1>Replace member</h1>
      <p className="muted">
        You're leaving this pair. The staying member will sign in,
        paste the blob you produce, and submit the replacement.
        The active sheet will be closed and the new member inherits
        the read-only history.
      </p>
      <p className="muted small">
        Your Ed25519 pubkey (used to verify the signature offline):{" "}
        <code style={{ wordBreak: "break-all" }}>
          {myKey?.publicKeyB64 ?? "(loading)"}
        </code>
      </p>
      <label>
        <span>New member's principal</span>
        <input
          value={newPrincipalText}
          onChange={(e) => setNewPrincipalText(e.target.value)}
          placeholder="paste the principal here (or scan a QR in v1.1.5)"
        />
      </label>
      <div className="actions">
        <button
          onClick={onSignAndShare}
          disabled={busy || !newPrincipalText}
        >
          {busy ? "Signing…" : "Sign + generate handoff blob"}
        </button>
      </div>
      {err && <p className="err">{err}</p>}
      {signedBlob && (
        <div className="card">
          <p className="muted small">
            Handoff blob (give this to the staying member):
          </p>
          <textarea
            readOnly
            value={signedBlob}
            rows={6}
            style={{
              width: "100%",
              fontFamily: "monospace",
              fontSize: "0.75rem",
            }}
            onClick={(e) => (e.target as HTMLTextAreaElement).select()}
          />
          <button
            onClick={() => {
              navigator.clipboard.writeText(signedBlob);
              toasts.show({ kind: "success", text: "Copied" });
            }}
          >
            Copy to clipboard
          </button>
        </div>
      )}
    </div>
  );
}

function bytesToB64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}
