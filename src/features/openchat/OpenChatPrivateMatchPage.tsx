// Invisible, credentialless Saved-type matcher surface.
//
// OpenChat embeds this route in a fresh `sandbox="allow-scripts"` iframe. The
// opaque frame has no IOU cookies/storage/session. It redeems a one-use
// exact-message capability, verifies the authoritative source commitment,
// decrypts only the linked sheet's roster in memory, and returns one boolean.

import { useEffect } from "react";
import {
  createCardTransportSession,
  destroyCardTransportSession,
  type CardTransportSession,
} from "./cardPrivateContext";
import {
  buildPrivateMatchReady,
  buildPrivateMatchResult,
  parsePrivateMatchBootstrap,
  parsePrivateMatchRequest,
  privateMatchParentTargetOrigin,
  type PrivateMatchBinding,
} from "./privateMatchBridge";
import {
  destroyPrivateMatchContext,
  loadPrivateMatchContext,
  uniquePrivateKeywordMatch,
  type LoadedPrivateMatchContext,
} from "./privateMatchContext";

// Slightly above the host's 30s attempt bound so the host owns timeout classification/cleanup.
const FRAME_LIFETIME_MS = 31_000;
const OPENCHAT_MESSAGE_SCAN_CHARS = 10_000;
const IOU_PERSISTED_MESSAGE_CHARS = 200;

/**
 * Byte-for-behavior equivalent to OpenChat's IOU `from_message` evidence rule:
 * bound the source view, trim it, then persist at most 200 JS string code units.
 * The full unmodified source is still commitment-verified before this is called.
 */
export function privateMatchPersistedMessageEvidence(exactMessageText: string): string {
  return exactMessageText
    .slice(0, OPENCHAT_MESSAGE_SCAN_CHARS)
    .trim()
    .slice(0, IOU_PERSISTED_MESSAGE_CHARS);
}

export function OpenChatPrivateMatchPage() {
  useEffect(() => {
    const parentWindow = window.parent;
    if (parentWindow === window) return;

    let active = true;
    let binding: PrivateMatchBinding | undefined;
    let parentOrigin: string | undefined;
    let session: CardTransportSession | undefined;
    let context: LoadedPrivateMatchContext | undefined;
    let requestStarted = false;

    const teardown = () => {
      active = false;
      window.removeEventListener("message", onMessage);
      destroyPrivateMatchContext(context);
      context = undefined;
      destroyCardTransportSession(session);
      session = undefined;
    };

    const finish = (matched: boolean) => {
      if (active && binding !== undefined && parentOrigin !== undefined) {
        parentWindow.postMessage(buildPrivateMatchResult(binding, matched), parentOrigin);
      }
      teardown();
    };

    const onMessage = (event: MessageEvent<unknown>) => {
      // WindowProxy identity is the primary boundary. An origin string alone is insufficient.
      if (!active || event.source !== parentWindow) return;

      if (binding === undefined) {
        const bootstrap = parsePrivateMatchBootstrap(event.data);
        const targetOrigin = privateMatchParentTargetOrigin(event.origin);
        if (bootstrap === null || targetOrigin === null) return;
        binding = bootstrap;
        parentOrigin = targetOrigin;
        session = createCardTransportSession();
        parentWindow.postMessage(
          buildPrivateMatchReady(binding, session.publicKeyBase64Url),
          parentOrigin,
        );
        return;
      }

      if (event.origin !== parentOrigin || requestStarted || session === undefined) return;
      const request = parsePrivateMatchRequest(event.data, binding);
      if (request === null) return;
      requestStarted = true;

      // Keep the exact string byte-for-byte. Do not trim, normalize, lowercase or log it.
      let exactMessageText = request.messageText;
      void loadPrivateMatchContext(request.capability, session, exactMessageText)
        .then((loaded) => {
          if (!active) {
            destroyPrivateMatchContext(loaded);
            return;
          }
          context = loaded;
          // Match only what the card's authoritative `message` field will persist. A keyword after
          // that boundary must not suggest a Saved type the final card cannot deterministically
          // hydrate. loadPrivateMatchContext has already verified the FULL exact-source commitment.
          const persistedEvidence = privateMatchPersistedMessageEvidence(exactMessageText);
          const matched = uniquePrivateKeywordMatch(loaded.keywordSets, persistedEvidence);
          exactMessageText = "";
          finish(matched);
        })
        .catch(() => {
          exactMessageText = "";
          // Do not turn a redeem/network/decrypt failure into a definitive no-match. Silence keeps
          // the wire boolean-only; the host's bounded timeout classifies it transient and retries
          // with a fresh capability.
          teardown();
        });
    };

    window.addEventListener("message", onMessage);
    const lifetime = window.setTimeout(teardown, FRAME_LIFETIME_MS);
    return () => {
      window.clearTimeout(lifetime);
      teardown();
    };
  }, []);

  return null;
}
