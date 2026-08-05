// Settings card for the ON-CHAIN action inbox path (the successor to the relay).
//
// DEFAULT view — the ONE end-user flow: "Connect to OpenChat". Each user pairs their OWN delivery
// key once by entering the high-entropy claim token OpenChat displays (its consent sheet); the
// signed-in browser sends it to IOU, whose registered app canister performs the authenticated
// c2c_claim_ai_app_link_code call. The keypair itself is canister-backed
// (consumerKeypair.ts): wrapped via the same vetkd mechanism as sheet keys, so any of the user's
// devices can decrypt. Normal disconnect first obtains a clean C2C OpenChat revoke outcome and
// only then deletes the IOU key; remote failure retains the key for a safe retry.
//
// ADVANCED (collapsed disclosure) — admin & debugging surfaces only:
//   - "Link to OpenChat" registers the app manifest (per_user_keys=true) at the user_index's
//     register_ai_app in one tap (registerAiApp.ts). Registration sends an EMPTY app-level key.
//     End users never need it: first-ever bootstrap is CI's `pnpm register:openchat` (deploy:local),
//     and the static manifest re-syncs automatically on Connect and app load.
//   - The SPKI PEM + "Copy public key" + fingerprint remain for debugging/legacy
//     (per_user_keys=false) setups only.
//   - The inbox canister readout: NOT entered here — getActionInboxConfig() auto-derives it from
//     this app's registered manifest in OpenChat's user_index (the id OpenChat routes deposits to);
//     any legacy hand-entered localStorage override is purged on mount.
//   - The legacy off-chain relay cards are passed in as children by SettingsPage and render only
//     while Advanced is open (auto-expanded when a relay config already exists, so nobody strands).
//
// The private key exists in plaintext only on the user's devices (the canister stores an opaque
// wrapped blob); decryption happens here on poll. Nothing is written to a sheet until the user
// Accepts, exactly like the relay path.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { getRelayConfig } from "../relay/relay";
import { useAuth } from "../auth/AuthProvider";
import { canisterId as iouBackendCanisterId } from "../auth/config";
import { useActor } from "../flows/useActor";
import {
  captureConsumerKeypairSession,
  clearConsumerKeypair,
  consumerPublicKeyPem,
  loadOrCreateConsumerKeypair,
  signRevokeChallenge,
} from "./consumerKeypair";
import {
  isValidOpenChatClaimToken,
  normalizeOpenChatClaimToken,
  OPENCHAT_CLAIM_TOKEN_HEX_LENGTH,
  registerAiApp,
} from "./registerAiApp";
import { coordinatedDisconnectOpenChat } from "./disconnectOpenChat";
import { getActionInboxConfig, invalidateInboxCache } from "./actionInboxClient";
import { syncOpenChatManifest } from "./syncManifest";
import { OC_ACTION_INBOX_CANISTER_ID, OC_CONNECTED_KEY, OC_IC_URL, OC_LINKED_KEY, OC_USER_INDEX_CANISTER_ID } from "./ocConfig";

const LS_INBOX = "iou.openchat.actionInbox.v1";

type LinkStatus =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "ok"; message: string }
  | { kind: "err"; message: string };

export function ActionInboxSettings({ children }: { children?: ReactNode }) {
  const { identity } = useAuth();
  const { actor } = useActor();
  const principal = identity?.getPrincipal().toText() ?? null;
  const [pubKeyPem, setPubKeyPem] = useState<string>("");
  const [fingerprint, setFingerprint] = useState<string>("");
  const [inbox, setInbox] = useState<{ canisterId: string; host: string } | null>(null);
  // Admin/debug + legacy relay surfaces are collapsed by default; auto-expand for users who
  // already configured a relay so their URL/token stay reachable after the simplification.
  const [showAdvanced, setShowAdvanced] = useState<boolean>(
    () => getRelayConfig(principal) !== null,
  );
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
    if (!actor) {
      setInbox(null);
      return;
    }
    void getActionInboxConfig(actor).then((cfg) => {
      if (!cancelled) setInbox(cfg);
    });
    return () => {
      cancelled = true;
    };
  }, [actor]);

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
      // The registered manifest is static public app metadata. Private
      // account template names and keywords are never supplied here.
      const outcome = await registerAiApp({
        host: OC_IC_URL,
        userIndexCanisterId: OC_USER_INDEX_CANISTER_ID,
        consumerPublicKeyPem: "",
        // Our own backend canister so OpenChat can verify us at publish time (c2c_verify_ai_app).
        appCanisterId: iouBackendCanisterId,
        // Route deposits to IOU's own inbox — MUST be sent on every upsert or deposits go NotConfigured.
        inboxCanisterId: OC_ACTION_INBOX_CANISTER_ID,
        identity,
      });
      if (outcome.kind === "success") {
        // The manifest (and its routed inbox) just changed — drop the resolver cache so the next poll
        // resolves the fresh inbox instead of a stale one.
        invalidateInboxCache();
        // Remember the principal so a later app load can refresh the static manifest.
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

  // Per-user pairing: OpenChat shows the user a single-use 256-bit claim token (its consent sheet).
  // The signed-in browser gives it to IOU, whose registered canister performs the authenticated
  // c2c claim. The keypair is ensured first so the PEM survives device changes.
  const connectWithCode = async () => {
    setConnect({ kind: "busy" });
    try {
      const consumerSession = captureConsumerKeypairSession(principal);
      if (!OC_USER_INDEX_CANISTER_ID) {
        setConnect({
          kind: "err",
          message:
            "VITE_OC_USER_INDEX_CANISTER_ID is not set — add the OpenChat user_index canister id " +
            "to .env.local and restart the dev server.",
        });
        return;
      }
      const code = normalizeOpenChatClaimToken(linkCode);
      if (!isValidOpenChatClaimToken(code)) {
        setConnect({
          kind: "err",
          message: `Paste the ${OPENCHAT_CLAIM_TOKEN_HEX_LENGTH}-character claim token shown in OpenChat.`,
        });
        return;
      }
      const pem = await consumerPublicKeyPem(consumerSession); // ensures the keypair exists (auto-created + wrapped)
      if (!actor) throw new Error("IOU backend is not ready");
      const outcome = (await actor.connect_openchat(code, pem)) as Record<string, unknown>;
      if ("Success" in outcome) {
          setLinkCode("");
          // Connecting is participating in OpenChat: mark it, then refresh
          // the static manifest without reading private account templates.
          try {
            if (identity) {
              const me = identity.getPrincipal().toText();
              localStorage.setItem(OC_CONNECTED_KEY, me);
            }
          } catch {
            /* best-effort */
          }
          void syncOpenChatManifest(identity);
          setConnect({
            kind: "ok",
            message: "Connected — OpenChat now delivers your confirmed actions encrypted to your own key.",
          });
      } else if ("CodeNotFound" in outcome) {
          setConnect({ kind: "err", message: "OpenChat doesn't recognise this claim token — copy it again and retry." });
      } else if ("CodeExpired" in outcome) {
          setConnect({ kind: "err", message: "This code has expired — get a fresh one in OpenChat and try again." });
      } else if ("InvalidRequest" in outcome) {
          setConnect({ kind: "err", message: `OpenChat rejected the request: ${String(outcome.InvalidRequest)}` });
      } else if ("NotConfigured" in outcome) {
          setConnect({ kind: "err", message: "This IOU deployment has not pinned its OpenChat UserIndex." });
      } else if ("WrongApp" in outcome) {
          setConnect({ kind: "err", message: "The claim token belongs to a different OpenChat app registration." });
      } else {
          setConnect({
            kind: "err",
            message: `OpenChat could not complete the connection${"RemoteError" in outcome ? `: ${String(outcome.RemoteError)}` : ""}`,
          });
      }
    } catch (e) {
      setConnect({ kind: "err", message: (e as Error).message });
    }
  };

  // Coordinated disconnect: while the private key still exists, the browser signs OpenChat's exact
  // V3 proof over the caller-scoped, app-subject binding. The signed-in IOU backend then invokes
  // revoke_ai_app_user_key C2C as the registered app canister. Only Success/KeyNotFound permits the
  // local wrapped key to be deleted. A remote failure keeps the key and binding intact for retry.
  const disconnectFromOpenChat = async () => {
    setDisconnect({ kind: "busy" });
    try {
      const consumerSession = captureConsumerKeypairSession(principal);
      if (!actor) throw new Error("IOU backend is not ready");
      const coordinated = await coordinatedDisconnectOpenChat(
        actor,
        pubKeyPem,
        (challenge) => signRevokeChallenge(challenge, consumerSession),
        () => clearConsumerKeypair(consumerSession),
      );
      const outcome = coordinated.outcome;
      if (!("localDeleteResult" in coordinated)) {
        const message = outcome.kind === "not_linked"
          ? "No authoritative OpenChat link was found. Your delivery key was retained."
          : outcome.kind === "not_configured"
            ? "This IOU deployment has not pinned its OpenChat UserIndex. Your delivery key was retained."
            : outcome.kind === "invalid_binding"
              ? "The saved OpenChat link is not a complete V3 scoped binding. Reconnect it before disconnecting."
              : outcome.kind === "binding_changed"
                ? "The OpenChat link or delivery key changed while disconnecting. Nothing local was deleted; retry."
                : outcome.kind === "invalid_request"
                  ? `IOU rejected the disconnect proof: ${outcome.message}`
                  : outcome.kind === "remote_error"
                    ? `OpenChat could not revoke the delivery key: ${outcome.message}. The key was retained; retry.`
                    : "The coordinated disconnect did not complete. Your delivery key was retained; retry.";
        setDisconnect({ kind: "err", message });
        return;
      }

      // IOU removed the exact binding after a clean OC outcome, then the sequencing helper
      // completed the wrapped-key deletion as the final local half.
      const cleared = coordinated.localDeleteResult;
      // The account which initiated the operation was safely cleared, but a
      // newer session now owns this UI and its local participation markers.
      if (!cleared.sessionStillCurrent) return;
      // No longer connected — clear the participation marker used by app-load refresh.
      try {
        localStorage.removeItem(OC_CONNECTED_KEY);
      } catch {
        /* best-effort */
      }
      setPubKeyPem("");
      setFingerprint("");
      setDisconnect({
        kind: "ok",
        message: "Disconnected — your delivery key was deleted here AND removed from OpenChat. Next time an " +
          "action is proposed in a chat, OpenChat will offer to reconnect.",
      });
    } catch (e) {
      setDisconnect({ kind: "err", message: (e as Error).message });
    }
  };

  return (
    <>
      <div className="card">
        <h2>OpenChat action inbox (on-chain)</h2>
        <p className="muted small">
          Receive OpenChat-confirmed actions <em>on-chain</em>, end-to-end encrypted — no relay. Confirmed
          actions appear under “Pending from chat”; the encrypted entry is still written on <em>this device</em>
          when you Accept.
        </p>

        <h3 id="openchat-connect" ref={connectRef} style={{ marginTop: 16 }}>
          Connect to OpenChat
        </h3>
        <p className="muted small">
          OpenChat delivers <em>your</em> confirmed actions encrypted to a key only your IOU account holds.
          When OpenChat shows you a secure claim token, paste it here to connect them — once per account, ever.
        </p>
        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input
            ref={codeInputRef}
            placeholder="64-character claim token"
            value={linkCode}
            onChange={(e) => setLinkCode(e.target.value)}
            inputMode="text"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            maxLength={OPENCHAT_CLAIM_TOKEN_HEX_LENGTH}
            style={{ flex: "1 1 360px", fontFamily: "monospace", letterSpacing: "0.04em" }}
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

        <span className="lock-cue" style={{ marginTop: 8 }}>
          🔒 your private key is end-to-end encrypted — the canister only ever stores a wrapped blob
        </span>

        <div style={{ marginTop: 14 }}>
          <button
            type="button"
            className="secondary small"
            aria-expanded={showAdvanced}
            onClick={() => setShowAdvanced((v) => !v)}
          >
            {showAdvanced ? "▾ Advanced" : "▸ Advanced"}
          </button>
        </div>

        {showAdvanced && (
          <div style={{ marginTop: 10 }}>
            <h3 style={{ marginTop: 0 }}>Admin &amp; debugging</h3>
            <p className="muted small">
              <strong>Link to OpenChat</strong> registers the app manifest in one tap (admin only — no
              key involved: delivery uses per-user keys, and the manifest re-syncs automatically on
              Connect and on app load). The consumer public key below is
              canister-backed and cached on this device; <em>Copy public key</em> stays for debugging
              and legacy setups:
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

            <p className="muted small" style={{ marginTop: 12 }}>
              action_inbox canister (auto-derived from your OpenChat registration — nothing to configure):
            </p>
            <p className="small" style={{ fontFamily: "monospace", wordBreak: "break-all" }}>
              {inbox ? `${inbox.canisterId} @ ${inbox.host}` : "resolving from OpenChat…"}
            </p>
          </div>
        )}
      </div>

      {/* Legacy off-chain relay cards (SettingsPage passes them in) — advanced-only. */}
      {showAdvanced && children}
    </>
  );
}
