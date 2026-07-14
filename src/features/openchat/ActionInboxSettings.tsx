// Settings card for the ON-CHAIN action inbox path (the successor to the relay).
//
// Two flows live here:
//   1. ADMIN — "Link to OpenChat" registers the app manifest (with per_user_keys=true) at the
//      user_index's register_ai_app in one tap (registerAiApp.ts). Delivery always uses per-user
//      keys, so registration sends an EMPTY app-level key — no key dependency at all. The SPKI
//      PEM + copy button remain for the user pairing flow below and for debugging/legacy
//      (per_user_keys=false) setups; the CI script (pnpm register:openchat) no longer needs it.
//   2. USER — "Connect to OpenChat": each user pairs their OWN delivery key once by entering the
//      6-digit code OpenChat displays (its consent sheet); we push this account's public key via
//      claim_ai_app_link_code. The keypair itself is canister-backed (consumerKeypair.ts): wrapped
//      via the same vetkd mechanism as sheet keys, so any of the user's devices can decrypt.
// The inbox canister id is NOT entered here: getActionInboxConfig() auto-derives it from this app's
// registered manifest in OpenChat's user_index (the id OpenChat routes deposits to). It's shown
// read-only below, and any legacy hand-entered localStorage override is purged on mount.
//
// The private key exists in plaintext only on the user's devices (the canister stores an opaque
// wrapped blob); decryption happens here on poll. Nothing is written to a sheet until the user
// Accepts, exactly like the relay path.

import { useEffect, useRef, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { canisterId as iouBackendCanisterId } from "../auth/config";
import {
  clearConsumerKeypair,
  consumerPublicKeyPem,
  loadOrCreateConsumerKeypair,
  signRevokeChallenge,
} from "./consumerKeypair";
import { claimAiAppLinkCode, registerAiApp, revokeAiAppUserKey } from "./registerAiApp";
import { getActionInboxConfig, invalidateInboxCache } from "./actionInboxClient";
import { useTemplates } from "../templates/TemplatesContext";
import { OC_ACTION_INBOX_CANISTER_ID, OC_IC_URL, OC_LINKED_KEY, OC_USER_INDEX_CANISTER_ID } from "./ocConfig";

const LS_INBOX = "iou.openchat.actionInbox.v1";

type LinkStatus =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "ok"; message: string }
  | { kind: "err"; message: string };

export function ActionInboxSettings() {
  const { identity } = useAuth();
  const { templates } = useTemplates();
  const [pubKeyPem, setPubKeyPem] = useState<string>("");
  const [fingerprint, setFingerprint] = useState<string>("");
  const [inbox, setInbox] = useState<{ canisterId: string; host: string } | null>(null);
  const [link, setLink] = useState<LinkStatus>({ kind: "idle" });
  const [linkCode, setLinkCode] = useState("");
  const [connect, setConnect] = useState<LinkStatus>({ kind: "idle" });
  const [disconnect, setDisconnect] = useState<LinkStatus>({ kind: "idle" });
  const connectRef = useRef<HTMLHeadingElement | null>(null);
  const codeInputRef = useRef<HTMLInputElement | null>(null);

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

  // The inbox canister id is auto-derived from this app's OpenChat manifest — not entered here.
  // Resolve it read-only for display, and purge any legacy hand-entered override that used to live
  // in localStorage (getActionInboxConfig no longer reads it, but clear it so nothing stale lingers).
  useEffect(() => {
    try {
      globalThis.localStorage?.removeItem(LS_INBOX);
    } catch {
      /* ignore */
    }
    let cancelled = false;
    void getActionInboxConfig().then((cfg) => {
      if (!cancelled) setInbox(cfg);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // OpenChat's consent sheet links here as <origin>/settings#openchat-connect (the manifest's
  // "connect" surface): scroll the Connect section into view and put the caret in the code input
  // so the user can paste immediately.
  useEffect(() => {
    if (globalThis.location?.hash === "#openchat-connect") {
      connectRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      codeInputRef.current?.focus();
    }
  }, []);

  const copy = (t: string) => {
    try {
      void navigator.clipboard?.writeText(t);
    } catch {
      /* ignore */
    }
  };

  // One-tap registration: no key at all. The manifest carries per_user_keys=true, so delivery
  // always uses each user's own paired key and the app-level key is unused — register with "".
  // Prefers the signed-in identity (stable (owner, name) upsert key across taps); falls back to
  // anonymous, which test_mode local deployments accept.
  const linkToOpenChat = async () => {
    setLink({ kind: "busy" });
    try {
      if (!OC_USER_INDEX_CANISTER_ID) {
        setLink({
          kind: "err",
          message:
            "VITE_OC_USER_INDEX_CANISTER_ID is not set — add the OpenChat user_index canister id " +
            "to .env.local and restart the dev server.",
        });
        return;
      }
      const outcome = await registerAiApp({
        host: OC_IC_URL,
        userIndexCanisterId: OC_USER_INDEX_CANISTER_ID,
        consumerPublicKeyPem: "",
        // Our own backend canister so OpenChat can verify us at publish time (c2c_verify_ai_app).
        appCanisterId: iouBackendCanisterId,
        // Route deposits to IOU's own inbox — MUST be sent on every upsert or deposits go NotConfigured.
        inboxCanisterId: OC_ACTION_INBOX_CANISTER_ID,
        identity,
        // Register the user's saved types too, so the manifest can route chat messages to them.
        templates,
      });
      if (outcome.kind === "success") {
        // The manifest (and its routed inbox) just changed — drop the resolver cache so the next poll
        // resolves the fresh inbox instead of a stale one.
        invalidateInboxCache();
        // Remember we're linked (scoped to this principal) so a later template edit auto-re-registers.
        try {
          if (identity) localStorage.setItem(OC_LINKED_KEY, identity.getPrincipal().toText());
        } catch {
          /* best-effort */
        }
        setLink({ kind: "ok", message: "Linked to OpenChat — now enable IOU in a chat's Apps settings." });
      } else if (outcome.kind === "invalid_request") {
        setLink({ kind: "err", message: `OpenChat rejected the manifest: ${outcome.message}` });
      } else {
        setLink({
          kind: "err",
          message: `OpenChat error ${outcome.code}${outcome.message ? ` — ${outcome.message}` : ""}`,
        });
      }
    } catch (e) {
      setLink({ kind: "err", message: (e as Error).message });
    }
  };

  // Per-user pairing: OpenChat shows the user a single-use 6-digit code (its consent sheet);
  // entering it here pushes THIS user's public key to OpenChat via claim_ai_app_link_code. The
  // keypair is ensured first (canister-backed, automatic) so the PEM survives device changes.
  const connectWithCode = async () => {
    setConnect({ kind: "busy" });
    try {
      if (!OC_USER_INDEX_CANISTER_ID) {
        setConnect({
          kind: "err",
          message:
            "VITE_OC_USER_INDEX_CANISTER_ID is not set — add the OpenChat user_index canister id " +
            "to .env.local and restart the dev server.",
        });
        return;
      }
      const code = linkCode.trim();
      if (!/^\d{6}$/.test(code)) {
        setConnect({ kind: "err", message: "Enter the 6-digit code shown in OpenChat." });
        return;
      }
      const pem = await consumerPublicKeyPem(); // ensures the keypair exists (auto-created + wrapped)
      const outcome = await claimAiAppLinkCode({
        host: OC_IC_URL,
        userIndexCanisterId: OC_USER_INDEX_CANISTER_ID,
        code,
        publicKeyPem: pem,
        identity,
      });
      switch (outcome.kind) {
        case "success":
          setLinkCode("");
          setConnect({
            kind: "ok",
            message: "Connected — OpenChat now delivers your confirmed actions encrypted to your own key.",
          });
          break;
        case "code_not_found":
          setConnect({ kind: "err", message: "OpenChat doesn't recognise this code — check the digits and try again." });
          break;
        case "code_expired":
          setConnect({ kind: "err", message: "This code has expired — get a fresh one in OpenChat and try again." });
          break;
        case "invalid_request":
          setConnect({ kind: "err", message: `OpenChat rejected the request: ${outcome.message}` });
          break;
        default:
          setConnect({
            kind: "err",
            message: `OpenChat error ${outcome.code}${outcome.message ? ` — ${outcome.message}` : ""}`,
          });
      }
    } catch (e) {
      setConnect({ kind: "err", message: (e as Error).message });
    }
  };

  // One-sided disconnect from the IOU side: delete this account's wrapped consumer keypair
  // (canister + device cache), and — while we still know the PEM — best-effort revoke the same key
  // on OpenChat (revoke_ai_app_user_key; the PEM is the bearer authorization). With the key gone
  // there too, OpenChat's in-chat propose flow re-detects "not connected" and offers the user the
  // pairing sheet right in the chat. Reconnecting = a fresh keypair + a new 6-digit pairing.
  const disconnectFromOpenChat = async () => {
    setDisconnect({ kind: "busy" });
    try {
      // Revoke FIRST (needs the PEM; after clearConsumerKeypair it is gone for good). Failure is
      // non-fatal — the local delete still stops all importing; OpenChat-side cleanup can then be
      // done via Disconnect in the chat's Apps settings.
      let revoked = false;
      if (pubKeyPem && OC_USER_INDEX_CANISTER_ID) {
        try {
          const outcome = await revokeAiAppUserKey({
            host: OC_IC_URL,
            userIndexCanisterId: OC_USER_INDEX_CANISTER_ID,
            publicKeyPem: pubKeyPem,
            // Signs with the still-present consumer private key (revoke runs before the delete).
            sign: signRevokeChallenge,
            identity,
          });
          revoked = outcome.kind === "success" || outcome.kind === "key_not_found";
        } catch {
          /* unreachable user_index — proceed with the local delete */
        }
      }
      await clearConsumerKeypair();
      setPubKeyPem("");
      setFingerprint("");
      setDisconnect({
        kind: "ok",
        message: revoked
          ? "Disconnected — your delivery key was deleted here AND removed from OpenChat. Next time an " +
            "action is proposed in a chat, OpenChat will offer to reconnect."
          : "Disconnected — your delivery key was deleted, so OpenChat actions can no longer be decrypted " +
            "or imported. OpenChat couldn't be reached to remove its copy — also press Disconnect in the " +
            "chat's Apps settings there.",
      });
    } catch (e) {
      setDisconnect({ kind: "err", message: (e as Error).message });
    }
  };

  return (
    <div className="card">
      <h2>OpenChat action inbox (on-chain)</h2>
      <p className="muted small">
        Receive OpenChat-confirmed actions <em>on-chain</em>, end-to-end encrypted — no relay. Register this
        device's public key with the OpenChat action as its <code>recipient_public_key</code>. Confirmed
        actions appear under “Pending from chat”; the encrypted entry is still written on <em>this device</em>
        when you Accept.
      </p>

      <p className="muted small" style={{ marginTop: 8 }}>
        Your account's consumer public key (canister-backed, cached on this device) —{" "}
        <strong>Link to OpenChat</strong> registers the app manifest in one tap (no key involved:
        delivery uses per-user keys); <em>Copy public key</em> stays for debugging and legacy
        setups:
      </p>
      <textarea
        readOnly
        value={pubKeyPem}
        rows={4}
        style={{ width: "100%", fontFamily: "monospace", fontSize: "0.75rem" }}
        onFocusCapture={(e) => e.currentTarget.select()}
      />
      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button type="button" onClick={() => void linkToOpenChat()} disabled={link.kind === "busy"}>
          {link.kind === "busy" ? "Linking…" : "Link to OpenChat"}
        </button>
        <button type="button" className="secondary small" onClick={() => copy(pubKeyPem)} disabled={!pubKeyPem}>
          Copy public key
        </button>
        {fingerprint && <span className="muted small">fingerprint: {fingerprint.slice(0, 16)}…</span>}
      </div>
      {link.kind === "ok" && (
        <p className="small" style={{ color: "var(--credit)", marginTop: 6 }}>
          {link.message}
        </p>
      )}
      {link.kind === "err" && (
        <p className="small" style={{ color: "var(--debt)", marginTop: 6 }}>
          {link.message}
        </p>
      )}

      <h3 id="openchat-connect" ref={connectRef} style={{ marginTop: 16 }}>
        Connect to OpenChat
      </h3>
      <p className="muted small">
        OpenChat delivers <em>your</em> confirmed actions encrypted to a key only your IOU account holds.
        When OpenChat shows you a 6-digit code, enter it here to connect them — once per account, ever.
      </p>
      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input
          ref={codeInputRef}
          placeholder="6-digit code"
          value={linkCode}
          onChange={(e) => setLinkCode(e.target.value)}
          inputMode="numeric"
          maxLength={6}
          style={{ flex: "0 1 140px", fontFamily: "monospace", letterSpacing: "0.2em" }}
        />
        <button
          type="button"
          onClick={() => void connectWithCode()}
          disabled={connect.kind === "busy" || !linkCode.trim()}
        >
          {connect.kind === "busy" ? "Connecting…" : "Connect"}
        </button>
      </div>
      {connect.kind === "ok" && (
        <p className="small" style={{ color: "var(--credit)", marginTop: 6 }}>
          {connect.message}
        </p>
      )}
      {connect.kind === "err" && (
        <p className="small" style={{ color: "var(--debt)", marginTop: 6 }}>
          {connect.message}
        </p>
      )}

      <div className="row" style={{ gap: 8, alignItems: "center", marginTop: 12 }}>
        <button
          type="button"
          className="secondary"
          onClick={() => void disconnectFromOpenChat()}
          disabled={disconnect.kind === "busy" || !pubKeyPem}
        >
          {disconnect.kind === "busy" ? "Disconnecting…" : "Disconnect from OpenChat"}
        </button>
        <span className="muted small">
          Deletes this account's delivery key — one-sided, no code needed.
        </span>
      </div>
      {disconnect.kind === "ok" && (
        <p className="small" style={{ color: "var(--credit)", marginTop: 6 }}>
          {disconnect.message}
        </p>
      )}
      {disconnect.kind === "err" && (
        <p className="small" style={{ color: "var(--debt)", marginTop: 6 }}>
          {disconnect.message}
        </p>
      )}

      <p className="muted small" style={{ marginTop: 12 }}>
        action_inbox canister (auto-derived from your OpenChat registration — nothing to configure):
      </p>
      <p className="small" style={{ fontFamily: "monospace", wordBreak: "break-all" }}>
        {inbox ? `${inbox.canisterId} @ ${inbox.host}` : "resolving from OpenChat…"}
      </p>

      <span className="lock-cue" style={{ marginTop: 8 }}>
        🔒 your private key is end-to-end encrypted — the canister only ever stores a wrapped blob
      </span>
    </div>
  );
}
