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
  buildPrivateMatchSourceReady,
  parsePrivateMatchAuthorize,
  parsePrivateMatchBootstrap,
  parsePrivateMatchSource,
  privateMatchParentTargetOrigin,
  type PrivateMatchBinding,
} from "./privateMatchBridge";
import {
  destroyPrivateMatchContext,
  preparePrivateMatchContext,
  PrivateMatchContextUnavailable,
  uniquePrivateKeywordMatch,
  verifyPrivateMatchSource,
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
    let authorizationStarted = false;
    let sourceStarted = false;

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

      if (parentOrigin === undefined || event.origin !== parentOrigin || session === undefined) return;
      if (!authorizationStarted) {
        const request = parsePrivateMatchAuthorize(event.data, binding);
        if (request === null) return;
        const authorizedBinding = binding;
        const authorizedOrigin = parentOrigin;
        authorizationStarted = true;
        void preparePrivateMatchContext(request.capability, session)
          .then((loaded) => {
            if (!active) {
              destroyPrivateMatchContext(loaded);
              return;
            }
            context = loaded;
            if (loaded.keywordSets.length === 0) {
              finish(false);
              return;
            }
            // A successful context proves this exact chat is durably linked before the host is
            // invited to release its authoritative text. Unlinked chats finish false here without
            // ever receiving a source message.
            parentWindow.postMessage(
              buildPrivateMatchSourceReady(authorizedBinding),
              authorizedOrigin,
            );
          })
          .catch((error: unknown) => {
            if (
              error instanceof PrivateMatchContextUnavailable &&
              error.definitiveNoMatch
            ) {
              finish(false);
              return;
            }
            // Do not turn a redeem/network/decrypt failure into a definitive no-match. Silence keeps
            // the wire boolean-only; the host's bounded timeout classifies it transient and retries
            // with a fresh capability.
            teardown();
          });
        return;
      }

      if (context === undefined || sourceStarted) return;
      const source = parsePrivateMatchSource(event.data, binding);
      if (source === null) return;
      sourceStarted = true;
      // Keep the exact string byte-for-byte. Do not trim, normalize, lowercase or log it.
      let exactMessageText = source.messageText;
      if (!verifyPrivateMatchSource(context, exactMessageText)) {
        exactMessageText = "";
        teardown();
        return;
      }
      // Match only what the card's authoritative `message` field will persist. A keyword after
      // that boundary must not suggest a Saved type the final card cannot deterministically hydrate.
      const persistedEvidence = privateMatchPersistedMessageEvidence(exactMessageText);
      const matched = uniquePrivateKeywordMatch(context.keywordSets, persistedEvidence);
      exactMessageText = "";
      finish(matched);
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
