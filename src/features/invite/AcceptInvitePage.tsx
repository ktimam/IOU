// /pair/accept#c=<code>&s=<sheetId>&k=<base64url(K_sheet)>
//
// The invitee lands here from an invite link. After signing in they click
// Accept and are IMMEDIATELY a full member — no creator "grant" step. In the
// dev/P-256 build the sheet key K_sheet rides in the URL fragment; the invitee
// self-wraps it under their own key and hands the opaque blob to accept_invite.
// In prod (vetkd) the fragment carries no key — accept_invite just flips
// member_b and the IC re-derives K_sheet for any member.

import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { SignInButtons } from "../auth/SignInButtons";
import { useActor } from "../flows/useActor";
import { useSheetKey } from "../flows/SheetKeyContext";
import { useToasts } from "../ui/Toasts";
import {
  deriveUserKeypair,
  wrapSheetKey,
  isProdVetkd,
} from "../crypto/devVetkd";
import { parseInviteFragment, b64uDecode, type InviteParams } from "../flows/inviteLink";

const STASH = "iou.pendingInvite.v1";

export function AcceptInvitePage() {
  const { state } = useAuth();
  const { actor } = useActor();
  const { cache } = useSheetKey();
  const nav = useNavigate();
  const toasts = useToasts();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Read the invite from the fragment on first load; stash it so it survives a
  // round-trip through sign-in (which drops the hash).
  const invite: InviteParams | null = useMemo(() => {
    const fromHash = parseInviteFragment(
      typeof window !== "undefined" ? window.location.hash : "",
    );
    if (fromHash) {
      try {
        sessionStorage.setItem(STASH, JSON.stringify(fromHash));
      } catch {
        /* private mode — fall back to the in-memory value */
      }
      return fromHash;
    }
    try {
      const raw = sessionStorage.getItem(STASH);
      return raw ? (JSON.parse(raw) as InviteParams) : null;
    } catch {
      return null;
    }
  }, []);

  async function onAccept() {
    if (!actor || state.kind !== "authenticated" || !invite) return;
    setBusy(true);
    setErr(null);
    try {
      const myKp = await deriveUserKeypair(state.principal);
      const pubkey = Array.from(new TextEncoder().encode(myKp.publicKeyB64));
      let rewraps: { sheet_id: string; wrapped_key_for_partner: number[] }[] = [];
      let kSheet: Uint8Array | null = null;
      if (!isProdVetkd()) {
        if (!invite.keyB64u) throw new Error("invite link is missing the sheet key");
        kSheet = b64uDecode(invite.keyB64u);
        // self-wrap under my own key (ECDH(myPriv, myPub)); unwrapFor reads it
        // back the same way — no creator involvement.
        const blob = await wrapSheetKey(kSheet, myKp.publicKey, myKp.privateKey);
        rewraps = [
          { sheet_id: invite.sheetId, wrapped_key_for_partner: Array.from(blob) },
        ];
      }
      await (actor as any).accept_invite(invite.code, rewraps, pubkey);
      if (kSheet) cache(invite.sheetId, kSheet); // warm the key so the sheet opens instantly
      try {
        sessionStorage.removeItem(STASH);
      } catch {
        /* ignore */
      }
      toasts.show({ kind: "success", text: "You're in — welcome to the account" });
      nav(`/sheet/${invite.sheetId}`, { replace: true });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (state.kind === "loading") return null;

  if (!invite) {
    return (
      <div>
        <Link to="/pairs" className="muted">← Accounts</Link>
        <h1>Invite</h1>
        <p className="err">This invite link is missing or malformed.</p>
      </div>
    );
  }

  if (state.kind === "anonymous") {
    return (
      <div>
        <h1>You've been invited</h1>
        <p className="muted">
          Sign in (or create an account) to join this shared ledger. You'll come
          right back here to accept.
        </p>
        {/* Inline sign-in (like SettingsPage/LinkChatPage) so the /pair/accept#… URL — and the
            invite it carries — survives; a redirect to /sign-in would land the invitee on /pairs
            afterwards instead of back here to accept. */}
        <SignInButtons />
      </div>
    );
  }

  return (
    <div>
      <Link to="/pairs" className="muted">← Accounts</Link>
      <h1>You've been invited</h1>
      <p className="muted">
        Accept to join this shared ledger. You'll have full read/write access
        immediately — no extra steps.
      </p>
      <div className="cta">
        <button onClick={onAccept} disabled={busy}>
          {busy ? "Joining…" : "Accept invite"}
        </button>
      </div>
      {err && <p className="err">{err}</p>}
    </div>
  );
}
