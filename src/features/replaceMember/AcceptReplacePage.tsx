// /pair/:pairId/accept-replace — the staying member's flow.
//
// Paste the base64 blob the leaving member produced. The PWA
// decodes, verifies the Ed25519 signature, and submits to
// submit_replace_member.

import { useEffect, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { useActor } from "../flows/useActor";
import { decodeFromQr, verifyReplaceRequest } from "./replaceMember";
import { useToasts } from "../ui/Toasts";

export function AcceptReplacePage() {
  const { pairId = "" } = useParams();
  const { state } = useAuth();
  const { actor } = useActor();
  const nav = useNavigate();
  const toasts = useToasts();

  const [blob, setBlob] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [summary, setSummary] = useState<null | {
    leaving: string;
    incoming: string;
  }>(null);

  useEffect(() => {
    if (state.kind !== "authenticated") {
      nav("/sign-in", { replace: true });
    }
  }, [state, nav]);

  function onPreview() {
    setErr(null);
    setSummary(null);
    try {
      const signed = decodeFromQr(blob.trim());
      if (signed.request.pair_id !== pairId) {
        setErr("blob is for a different pair");
        return;
      }
      if (!verifyReplaceRequest(signed)) {
        setErr("signature verification failed (offline check)");
        return;
      }
      setSummary({
        leaving: signed.request.leaving_principal,
        incoming: signed.request.new_principal,
      });
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function onSubmit() {
    if (!actor) return;
    setBusy(true);
    setErr(null);
    try {
      const signed = decodeFromQr(blob.trim());
      if (!verifyReplaceRequest(signed)) {
        setErr("signature verification failed (offline check)");
        setBusy(false);
        return;
      }
      await (actor as any).submit_replace_member({
        request: {
          pair_id: signed.request.pair_id,
          leaving_principal: Principal_fromText(signed.request.leaving_principal),
          new_principal: Principal_fromText(signed.request.new_principal),
          ts_ms: BigInt(signed.request.ts_ms),
          nonce: signed.request.nonce,
        },
        signature: signed.signature,
        signer_pubkey: signed.signer_pubkey,
      });
      toasts.show({ kind: "success", text: "Member replaced" });
      nav(`/pair/${pairId}`);
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
      <h1>Accept replacement</h1>
      <p className="muted">
        Paste the base64 blob the leaving member produced. The PWA
        will verify the offline signature, then submit to the canister.
      </p>
      <textarea
        value={blob}
        onChange={(e) => setBlob(e.target.value)}
        rows={6}
        style={{
          width: "100%",
          fontFamily: "monospace",
          fontSize: "0.75rem",
        }}
        placeholder="paste the blob here"
      />
      <div className="actions">
        <button onClick={onPreview} disabled={!blob}>
          Preview (verify offline)
        </button>
        <button
          onClick={onSubmit}
          disabled={busy || !blob}
        >
          {busy ? "Submitting…" : "Submit to canister"}
        </button>
      </div>
      {err && <p className="err">{err}</p>}
      {summary && (
        <div className="card">
          <p>
            <strong>{short(summary.leaving)}</strong> is leaving.
          </p>
          <p>
            <strong>{short(summary.incoming)}</strong> is joining.
          </p>
          <p className="muted small">
            The active sheet will be closed. The new member inherits
            the read-only history.
          </p>
        </div>
      )}
    </div>
  );
}

function short(p: string): string {
  return p.length > 14 ? p.slice(0, 10) + "…" : p;
}

function Principal_fromText(s: string): any {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const { Principal } = require("@dfinity/principal") as typeof import("@dfinity/principal");
  return Principal.fromText(s);
}