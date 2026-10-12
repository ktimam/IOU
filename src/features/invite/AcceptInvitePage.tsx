// Production: /pair/accept#c=<code>&s=<sheetId>&v=1&u=<independent invite secret>
//
// The invitee lands here from an invite link. After signing in they click
// Accept and are IMMEDIATELY a full member — no creator "grant" step. In the
// dev/P-256 build the sheet key K_sheet rides in the URL fragment; the invitee
// self-wraps it under their own key and hands the opaque blob to accept_invite.
// Production decrypts a server-stored envelope using the independent fragment
// secret, then submits a nonempty recipient-bound key copy. No paid derivation.

import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { SignInButtons } from "../auth/SignInButtons";
import { useActor } from "../flows/useActor";
import { useSheetKey } from "../flows/SheetKeyContext";
import { useToasts } from "../ui/Toasts";
import { parseInviteFragment, type InviteParams } from "../flows/inviteLink";
import { acceptInviteForSheet } from "./acceptInvite";

const STASH = "iou.pendingInvite.v1";

export function AcceptInvitePage() {
  const { state } = useAuth();
  const { actor } = useActor();
  const { cache } = useSheetKey();
  const nav = useNavigate();
  const toasts = useToasts();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const principal = state.kind === "authenticated" ? state.principal : null;
  const currentPrincipal = useRef(principal);
  currentPrincipal.current = principal;
  const mounted = useRef(false);
  const attempt = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; attempt.current++; }; }, []);

  // Read the invite from the fragment on first load; stash it so it survives a
  // round-trip through sign-in (which drops the hash).
  const [invite, setInvite] = useState<InviteParams | null>(() => {
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
      if (!raw) return null;
      const value = JSON.parse(raw) as InviteParams & { ownerPrincipal?: string };
      if (typeof value.code !== "string" || typeof value.sheetId !== "string") return null;
      if (value.ownerPrincipal && principal && value.ownerPrincipal !== principal) {
        sessionStorage.removeItem(STASH); return null;
      }
      const fragment = new URLSearchParams({ c: value.code, s: value.sheetId });
      if (value.keyB64u) fragment.set("k", value.keyB64u);
      if (value.inviteSecretB64u) { fragment.set("v", "1"); fragment.set("u", value.inviteSecretB64u); }
      return parseInviteFragment(fragment.toString());
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (!invite || !parseInviteFragment(window.location.hash)) return;
    try {
      sessionStorage.setItem(STASH, JSON.stringify({ ...invite, ownerPrincipal: principal ?? undefined }));
      // Retain across the sign-in round trip, but remove the bearer secret from
      // the visible address and history entry. Never move it into a query string.
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
    } catch { /* Keep the fragment if browser session storage is unavailable. */ }
  }, [invite, principal]);
  useEffect(() => {
    if (state.kind === "loading" || !invite) return;
    try {
      const stored = JSON.parse(sessionStorage.getItem(STASH) ?? "null") as { ownerPrincipal?: string } | null;
      // Gate transitions can unmount this page before its account-change effect
      // runs. Bind the retained capability on first authenticated use as well.
      if (stored?.ownerPrincipal && stored.ownerPrincipal !== principal) {
        attempt.current++; sessionStorage.removeItem(STASH); setInvite(null); setBusy(false); return;
      }
      if (principal) sessionStorage.setItem(STASH, JSON.stringify({ ...invite, ownerPrincipal: principal }));
    } catch { /* An unavailable stash does not authorize a different account. */ }
  }, [invite, principal, state.kind]);
  const previousPrincipal = useRef(principal);
  useEffect(() => {
    if (previousPrincipal.current && previousPrincipal.current !== principal) {
      attempt.current++;
      setInvite(null); setBusy(false);
      try { sessionStorage.removeItem(STASH); } catch { /* best effort */ }
    }
    previousPrincipal.current = principal;
  }, [principal]);

  async function onAccept() {
    if (!actor || state.kind !== "authenticated" || !invite) return;
    setBusy(true);
    setErr(null);
    const started = ++attempt.current;
    const acceptedPrincipal = state.principal;
    const assertCurrent = () => {
      if (!mounted.current || attempt.current !== started || currentPrincipal.current !== acceptedPrincipal) throw new Error("Invitation session changed");
    };
    let key: Uint8Array | null = null;
    try {
      const { K_sheet } = await acceptInviteForSheet(
        actor as any,
        state.principal,
        invite,
        undefined,
        assertCurrent,
      );
      key = K_sheet;
      assertCurrent();
      if (K_sheet) cache(invite.sheetId, K_sheet.slice());
      try {
        sessionStorage.removeItem(STASH);
      } catch {
        /* ignore */
      }
      setInvite(null);
      toasts.show({ kind: "success", text: "You're in — welcome to the account" });
      nav(`/sheet/${invite.sheetId}`, { replace: true });
    } catch (e) {
      if (mounted.current && attempt.current === started && currentPrincipal.current === acceptedPrincipal) setErr((e as Error).message);
    } finally {
      key?.fill(0);
      if (mounted.current && attempt.current === started) setBusy(false);
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
        {/* Inline sign-in (like SettingsPage) so the /pair/accept#… URL — and the
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
        {/* Gate on the ACTOR too — see NewPair: an early click silently no-ops otherwise. */}
        <button onClick={onAccept} disabled={busy || !actor}>
          {busy ? "Joining…" : !actor ? "Connecting…" : "Accept invite"}
        </button>
      </div>
      {err && <p className="err">{err}</p>}
    </div>
  );
}
