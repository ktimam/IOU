// /openchat/card — IOU's OWN app-rendered confirmable card.
//
// OpenChat embeds this page as an opaque, credentialless sandboxed iframe.
// The page has no IOU browser session or user identity. For an already-linked
// viewer, OpenChat redeems a short-lived capability bound to this viewer, card,
// app revision, and iframe recipient key. Only that linked account's encrypted
// type roster is released and decrypted in iframe memory.
//
// Every bridge message uses protocol v2 and a fresh per-document nonce. A
// selected private type leaves the iframe only as an encrypted template_ref
// bound to the sheet, chat, message, and entry row.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Direction } from "../entries/types";
import { matchTemplateForDraft } from "../entries/resolveTemplateBase";
import { orderedCurrencies } from "../settings/currencies";
import type { TxnTemplate } from "../templates/TemplatesContext";
import { fetchCardCurrency } from "./cardCurrency";
import {
  parseBootstrap,
  cardParentTargetOrigin,
  parseInit,
  parseBusy,
  parseCollectConfirm,
  parsePrivateContextRequest,
  initToFormState,
  initEntries,
  buildConfirmPayload,
  buildMultiConfirmPayload,
  buildReady,
  buildPrivateContextReady,
  buildPrivateContextStatus,
  buildResize,
  buildCollectedConfirm,
  type CardFormState,
  type CardInitContext,
  type CardTheme,
} from "./cardBridge";
import {
  cardContextMatchesInit,
  createCardTransportSession,
  destroyCardTransportSession,
  destroyLoadedCardContext,
  loadCardPrivateContext,
  type AuthoritativeCardContext,
  type CardTransportSession,
  type LoadedCardPrivateContext,
} from "./cardPrivateContext";
import { encryptTemplateRef, type TemplateRefContext } from "./templateRef";
import { IOU_MAX_MAJOR_AMOUNT, IOU_MIN_MAJOR_AMOUNT } from "./actionManifest";

// Plain-language direction labels (same vocabulary the OC-rendered card used, so
// a human catches an inversion before confirming).
const DIRECTION_LABELS: Record<Direction, string> = {
  credit: "Owed to you",
  debt: "You owe",
};

// Same vocabulary as the real entry form's "Type" fieldset (IOU = owed, has a due date; Settlement =
// paid now), short enough for a card row. The classic OC-rendered card printed the raw wire value
// ("iou"), which was never meant to be read by a human.
const KIND_LABELS: Record<"iou" | "settlement", string> = {
  iou: "IOU",
  settlement: "Settlement",
};

export function templateRefContextForCard(
  authoritative: AuthoritativeCardContext,
  entryIndex: number,
): TemplateRefContext {
  return {
    sheetId: authoritative.sheetId,
    contextVersion: authoritative.contextVersion,
    appSubject: authoritative.appSubject,
    chatHandle: authoritative.chatHandle,
    messageHandle: authoritative.messageHandle,
    appId: authoritative.appId,
    appRevision: authoritative.appRevision,
    actionId: authoritative.actionId,
    entryIndex,
  };
}

/**
 * Apply a privately hydrated saved Type to one card row.
 *
 * `templates` must be the roster decrypted for this card's authoritative
 * linked sheet. A selection is retained only while it is still present in
 * that exact roster; a stale/foreign id is cleared before local evidence is
 * matched. Ambiguous keyword matches deliberately remain unselected.
 */
export function hydrateSavedTypeForCard(
  state: CardFormState,
  raw: unknown,
  templates: TxnTemplate[],
  options: { evidence?: "full" | "row-local" } = { evidence: "full" },
): CardFormState {
  if (state.templateId && templates.some((template) => template.id === state.templateId)) {
    return state;
  }
  const containedState = state.templateId === undefined
    ? state
    : { ...state, templateId: undefined };
  const matched = matchTemplateForDraft(templates, raw, {
    evidence: options.evidence ?? "full",
  });
  return matched ? { ...containedState, templateId: matched.id } : containedState;
}

/** Remove an account-scoped selection whenever its authoritative private grant is no longer live. */
export function clearSavedTypeSelection(state: CardFormState): CardFormState {
  if (state.templateId === undefined) return state;
  const { templateId: _discarded, ...publicState } = state;
  return publicState;
}

/**
 * A private-context response may update UI state only for the exact iframe document, transport
 * session, and one-time capability that started it. This keeps a late response from an old grant
 * from repopulating Types after nonce/session/account rotation.
 */
export function privateLoadMatchesCurrent(
  capturedNonce: string,
  capturedSession: CardTransportSession,
  capturedCapability: string,
  currentNonce: string | null,
  currentSession: CardTransportSession | undefined,
  currentCapability: string | undefined,
): boolean {
  return (
    currentNonce === capturedNonce &&
    currentSession === capturedSession &&
    currentCapability === capturedCapability
  );
}

export type CardTypesState =
  | { kind: "waiting" | "loading" | "ready" }
  | { kind: "error"; message: string };

// ResizeObserver can fire once for each React/layout phase in a single logical card transition
// (public init, private-context loading, roster hydration). Reporting every intermediate height makes
// the host iframe visibly bounce. Wait for a short quiet window, then publish only the final changed
// height. This does not delay card data or confirmation readiness; it affects presentation only.
export const CARD_RESIZE_SETTLE_MS = 80;

export function createCoalescedCardResizeReporter(
  measure: () => number,
  report: (height: number) => void,
  settleMs = CARD_RESIZE_SETTLE_MS,
): { schedule: () => void; dispose: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastHeight = -1;
  let disposed = false;

  const schedule = () => {
    if (disposed) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (disposed) return;
      const height = Math.ceil(measure());
      if (!Number.isFinite(height) || height <= 0 || height === lastHeight) return;
      lastHeight = height;
      report(height);
    }, Math.max(0, settleMs));
  };

  return {
    schedule,
    dispose: () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/** Keep the loading-to-ready transition on one reserved line so hydration does not resize the card. */
export function CardTypesStatus({ state }: { state: CardTypesState }) {
  const loading = state.kind === "loading";
  const error = state.kind === "error";
  const idle = !loading && !error;
  return (
    <div
      data-card-types-status
      role={error ? "status" : undefined}
      aria-hidden={idle ? true : undefined}
      style={{
        minHeight: "0.9rem",
        lineHeight: "0.9rem",
        fontSize: "0.75rem",
        color: "var(--text-dim)",
        marginTop: 8,
      }}
    >
      {loading ? (
        <span
          style={{
            display: "block",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          Loading this account's saved types…
        </span>
      ) : error ? state.message : "\u00a0"}
    </div>
  );
}

type DeferredCollectionChallenge = Readonly<{
  frameNonce: string;
  requestNonce: string;
  capability: string;
  session: CardTransportSession;
  context: CardInitContext;
}>;

/**
 * Decide whether the iframe may snapshot its current form for a host-owned Add click.
 *
 * Public-only cards have no private state to wait for. Once the host grants private context, the
 * form must either defer during the exact hydration flight or reject; it may collect only after the
 * authoritative private context and saved-Type roster are both installed.
 */
export function privateCollectionReadiness(input: Readonly<{
  privateContextRequired: boolean;
  typesState: CardTypesState["kind"];
  privateContextLoaded: boolean;
}>): "ready" | "defer" | "reject" {
  if (!input.privateContextRequired) return "ready";
  if (input.typesState === "loading" && !input.privateContextLoaded) return "defer";
  if (input.typesState === "ready" && input.privateContextLoaded) return "ready";
  return "reject";
}

async function encryptedTypeRef(
  state: CardFormState,
  entryIndex: number,
  captured: LoadedCardPrivateContext,
): Promise<string | undefined> {
  const templateId = state.templateId;
  if (!templateId) return undefined;
  if (!captured.templates.some((template) => template.id === templateId)) {
    throw new Error("The selected account type is no longer available.");
  }
  return encryptTemplateRef(
    templateId,
    captured.sheetKey,
    templateRefContextForCard(captured.authoritative, entryIndex),
  );
}



// Theme token sets. IOU is natively dark (mint-on-charcoal, the Vault look); the
// light set keeps the same mint identity but darkens the accent for contrast on
// a white surface. Set as CSS custom properties on the page root so the shared
// input/select/button rules cascade correctly in both themes.
const THEME_VARS: Record<CardTheme, Record<string, string>> = {
  dark: {
    "--bg": "#0f1216",
    "--surface": "#181c22",
    "--surface-2": "#12161b",
    "--text": "#eaf0f0",
    "--text-dim": "#8a95a1",
    "--accent": "#5fe3b3",
    "--accent-hover": "#7fecc4",
    "--accent-soft": "rgba(95, 227, 179, 0.12)",
    "--on-accent": "#04241b",
    "--border": "#262c34",
    "--credit": "#5fe3b3",
    "--debt": "#ff8a75",
  },
  light: {
    "--bg": "#eef3f1",
    "--surface": "#ffffff",
    "--surface-2": "#f3f7f5",
    "--text": "#0f1a17",
    "--text-dim": "#5a6b64",
    "--accent": "#0f9c7c",
    "--accent-hover": "#0c8168",
    "--accent-soft": "rgba(15, 156, 124, 0.12)",
    "--on-accent": "#ffffff",
    "--border": "#d3ded9",
    "--credit": "#0b7a5f",
    "--debt": "#c2410c",
  },
};

export function OpenChatCardPage() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [ctx, setCtx] = useState<CardInitContext | null>(null);
  const [form, setForm] = useState<CardFormState>(() => initToFormState({}));
  // Direct/legacy MULTI init compatibility: current OpenChat multi cards use the host-owned classic
  // stored-payload view and resolve Saved types row-locally during IOU import. null → the normal
  // trusted SINGLE iframe UI from `form`.
  const [multi, setMulti] = useState<CardFormState[] | null>(null);
  // The host owns the only action buttons. Its busy signal freezes the editable values after that
  // click while it collects, grants, and submits the exact snapshot.
  const [submitting, setSubmitting] = useState(false);
  // The DEPLOYMENT's card currency (Config.card_currency), fetched anonymously once on mount. Undefined
  // until it resolves — and it may never (unset, offline, older canister), in which case the card keeps
  // deferring the currency to whoever imports, exactly as before. See cardCurrency.ts for why this is
  // app-level rather than per viewer.
  const [appCurrency, setAppCurrency] = useState<string | undefined>(undefined);
  // Mirror for the message handler, which closes over state from its mount-time render.
  const appCurrencyRef = useRef<string | undefined>(undefined);
  const frameNonceRef = useRef<string | null>(null);
  const parentTargetOriginRef = useRef<string | null>(null);
  const initializedNonceRef = useRef<string | null>(null);
  const collectionRequestRef = useRef<string>();
  const collectionInFlightRef = useRef(false);
  const deferredCollectionRef = useRef<DeferredCollectionChallenge>();
  const transportRef = useRef<CardTransportSession>();
  const privateContextRef = useRef<LoadedCardPrivateContext>();
  const privateCapabilityRef = useRef<string>();
  const privateInitContextRef = useRef<CardInitContext>();
  const [templates, setTemplates] = useState<TxnTemplate[]>([]);
  const [typesState, setTypesState] = useState<CardTypesState>({ kind: "waiting" });
  const typesStateRef = useRef<CardTypesState>(typesState);
  const formRef = useRef(form);
  const multiRef = useRef(multi);
  const ctxRef = useRef(ctx);
  formRef.current = form;
  multiRef.current = multi;
  ctxRef.current = ctx;
  typesStateRef.current = typesState;

  useEffect(() => {
    let cancelled = false;
    void fetchCardCurrency().then((c) => {
      if (cancelled || !c) return;
      appCurrencyRef.current = c;
      setAppCurrency(c);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const post = useCallback((msg: unknown) => {
    // Use the exact parent origin learned from its nonce-bound bootstrap.
    // Opaque/custom-scheme parent origins serialize as "null" and require the
    // wildcard fallback; exact WindowProxy + frame nonce remain mandatory.
    const targetOrigin = parentTargetOriginRef.current;
    if (!targetOrigin) return;
    try {
      window.parent?.postMessage(msg, targetOrigin);
    } catch {
      /* cross-origin post can throw in exotic sandboxes — non-fatal */
    }
  }, []);

  // Bootstrap establishes one opaque iframe document. A transport key is created only after the
  // host's separate, user-approved private-context request. Capability results are discarded if
  // navigation/bootstrap rotates the nonce while an await runs.
  useEffect(() => {
    let disposed = false;

    const setCurrentTypesState = (next: CardTypesState) => {
      typesStateRef.current = next;
      setTypesState(next);
    };

    const clearPrivateSelections = () => {
      const nextForm = clearSavedTypeSelection(formRef.current);
      formRef.current = nextForm;
      setForm(nextForm);
      const currentMulti = multiRef.current;
      if (currentMulti) {
        const nextMulti = currentMulti.map((entry) => clearSavedTypeSelection(entry));
        multiRef.current = nextMulti;
        setMulti(nextMulti);
      }
    };

    const resetPrivateState = () => {
      destroyLoadedCardContext(privateContextRef.current);
      privateContextRef.current = undefined;
      privateCapabilityRef.current = undefined;
      privateInitContextRef.current = undefined;
      deferredCollectionRef.current = undefined;
      setTemplates([]);
      setCurrentTypesState({ kind: "waiting" });
      clearPrivateSelections();
    };

    const collectCurrentCard = (
      frameNonce: string,
      requestNonce: string,
      reservedDeferredChallenge = false,
    ) => {
      if (
        disposed ||
        frameNonceRef.current !== frameNonce ||
        collectionInFlightRef.current ||
        (reservedDeferredChallenge
          ? collectionRequestRef.current !== requestNonce
          : collectionRequestRef.current === requestNonce)
      ) {
        return;
      }
      const capturedContext = ctxRef.current;
      const readiness = privateCollectionReadiness({
        privateContextRequired: capturedContext?.privateContext !== undefined,
        typesState: typesStateRef.current.kind,
        privateContextLoaded: privateContextRef.current !== undefined,
      });
      if (readiness !== "ready") return;

      const capturedForm = { ...formRef.current };
      const capturedMulti = multiRef.current?.map((entry) => ({ ...entry })) ?? null;
      if (
        !capturedContext ||
        capturedContext.readonly ||
        (capturedMulti
          ? capturedMulti.length === 0 || !capturedMulti.every(isCardFormValid)
          : !isCardFormValid(capturedForm))
      ) {
        return;
      }
      const capturedPrivate = privateContextRef.current;
      if (
        (capturedMulti
          ? capturedMulti.some((entry) => entry.templateId)
          : capturedForm.templateId !== undefined) &&
        !capturedPrivate
      ) {
        setCurrentTypesState({ kind: "error", message: "Account types are not ready." });
        return;
      }
      collectionRequestRef.current = requestNonce;
      collectionInFlightRef.current = true;
      setSubmitting(true);
      void (async () => {
        try {
          const refs = capturedPrivate
            ? await Promise.all(
                (capturedMulti ?? [capturedForm]).map((entry, index) =>
                  encryptedTypeRef(entry, index, capturedPrivate),
                ),
              )
            : [];
          const currentContext = ctxRef.current;
          if (
            disposed ||
            frameNonceRef.current !== frameNonce ||
            collectionRequestRef.current !== requestNonce ||
            (capturedPrivate && privateContextRef.current !== capturedPrivate) ||
            !currentContext ||
            currentContext.readonly ||
            currentContext.appId !== capturedContext.appId ||
            currentContext.appRevision !== capturedContext.appRevision ||
            currentContext.actionId !== capturedContext.actionId
          ) {
            return;
          }
          const payload = capturedMulti
            ? buildMultiConfirmPayload(capturedMulti, refs)
            : buildConfirmPayload(capturedForm, refs[0]);
          post(buildCollectedConfirm(frameNonce, requestNonce, payload));
        } catch (error) {
          setCurrentTypesState({
            kind: "error",
            message:
              error instanceof Error
                ? error.message
                : "Could not protect the selected account type.",
          });
        } finally {
          if (collectionRequestRef.current === requestNonce) {
            collectionInFlightRef.current = false;
          }
        }
      })();
    };

    const deferCollectionChallenge = (frameNonce: string, requestNonce: string): boolean => {
      const context = ctxRef.current;
      const capability = privateCapabilityRef.current;
      const session = transportRef.current;
      if (
        collectionInFlightRef.current ||
        collectionRequestRef.current === requestNonce ||
        frameNonceRef.current !== frameNonce ||
        !context ||
        context.readonly ||
        context.privateContext?.capability !== capability ||
        capability === undefined ||
        session === undefined
      ) {
        return false;
      }
      const existing = deferredCollectionRef.current;
      if (existing) {
        if (
          existing.frameNonce !== frameNonce ||
          existing.capability !== capability ||
          existing.session !== session ||
          existing.context.appId !== context.appId ||
          existing.context.appRevision !== context.appRevision ||
          existing.context.actionId !== context.actionId
        ) {
          return false;
        }
      }
      collectionRequestRef.current = requestNonce;
      deferredCollectionRef.current = {
        frameNonce,
        requestNonce,
        capability,
        session,
        context,
      };
      return true;
    };

    const flushDeferredCollection = () => {
      const challenge = deferredCollectionRef.current;
      if (!challenge) return;
      const currentContext = ctxRef.current;
      const loaded = privateContextRef.current;
      if (
        disposed ||
        frameNonceRef.current !== challenge.frameNonce ||
        collectionRequestRef.current !== challenge.requestNonce ||
        privateCapabilityRef.current !== challenge.capability ||
        transportRef.current !== challenge.session ||
        !currentContext ||
        currentContext.readonly ||
        currentContext.appId !== challenge.context.appId ||
        currentContext.appRevision !== challenge.context.appRevision ||
        currentContext.actionId !== challenge.context.actionId ||
        currentContext.privateContext?.capability !== challenge.capability ||
        !loaded ||
        !cardContextMatchesInit(loaded.authoritative, currentContext) ||
        privateCollectionReadiness({
          privateContextRequired: true,
          typesState: typesStateRef.current.kind,
          privateContextLoaded: true,
        }) !== "ready"
      ) {
        deferredCollectionRef.current = undefined;
        return;
      }
      deferredCollectionRef.current = undefined;
      collectCurrentCard(challenge.frameNonce, challenge.requestNonce, true);
    };

    function onMessage(event: MessageEvent) {
      // Only accept messages from our EMBEDDER (the OpenChat host). A co-resident sibling frame in the
      // same tab has its own window as event.source — never window.parent — so this rejects a forged
      // oc:card:init (overwriting the values the user is about to confirm) or oc:card:busy (freezing/
      // unlocking the buttons) injected sideways. Standalone (parent === self) still self-delivers.
      if (event.source !== window.parent) return;
      const bootstrap = parseBootstrap(event.data);
      if (bootstrap) {
        const targetOrigin = cardParentTargetOrigin(event.origin);
        if (
          frameNonceRef.current !== bootstrap.frameNonce ||
          parentTargetOriginRef.current !== targetOrigin
        ) {
          initializedNonceRef.current = null;
          frameNonceRef.current = bootstrap.frameNonce;
          parentTargetOriginRef.current = targetOrigin;
          destroyCardTransportSession(transportRef.current);
          transportRef.current = undefined;
          resetPrivateState();
          ctxRef.current = null;
          setCtx(null);
          setSubmitting(false);
          collectionRequestRef.current = undefined;
          collectionInFlightRef.current = false;
        }
        post(buildReady(bootstrap.frameNonce));
        return;
      }
      const frameNonce = frameNonceRef.current;
      if (!frameNonce) return;
      if (parsePrivateContextRequest(event.data, frameNonce)) {
        try {
          const session = transportRef.current ?? createCardTransportSession();
          transportRef.current = session;
          post(buildPrivateContextReady(frameNonce, session.publicKeyBase64Url));
        } catch {
          setCurrentTypesState({
            kind: "error",
            message: "Could not create a private card session.",
          });
        }
        return;
      }
      const collect = parseCollectConfirm(event.data, frameNonce);
      if (collect) {
        // This page has no action button of its own. Only the exact parent WindowProxy can deliver a
        // fresh host-click challenge. A required private grant in its exact loading state reserves
        // that one request instead of returning a public-only payload; successful hydration resumes
        // the same nonce automatically, so the human never has to click Add twice.
        if (
          collectionInFlightRef.current ||
          collectionRequestRef.current === collect.requestNonce
        ) return;
        const currentContext = ctxRef.current;
        const readiness = privateCollectionReadiness({
          privateContextRequired: currentContext?.privateContext !== undefined,
          typesState: typesStateRef.current.kind,
          privateContextLoaded: privateContextRef.current !== undefined,
        });
        if (readiness === "defer") {
          deferCollectionChallenge(frameNonce, collect.requestNonce);
          return;
        }
        if (readiness === "reject") return;
        collectCurrentCard(frameNonce, collect.requestNonce);
        return;
      }
      // Progress signal from the host freezes/unfreezes the fields while it performs the exact-byte
      // grant and final submission. It carries no data or authority by itself.
      const busyMsg = parseBusy(event.data, frameNonce);
      if (busyMsg) {
        setSubmitting(busyMsg.busy);
        return;
      }
      const parsed = parseInit(event.data, frameNonce);
      if (!parsed) return; // ignore devtools / HMR / foreign messages
      ctxRef.current = parsed.context;
      setCtx(parsed.context);
      if (initializedNonceRef.current !== frameNonce) {
        initializedNonceRef.current = frameNonce;
        // Seed public form data only once. Host re-init updates theme/readonly/private authority and
        // must never overwrite edits the viewer has already made in the isolated frame.
        const seed = appCurrencyRef.current ?? "";
        const entries = initEntries(parsed.data, seed);
        if (entries) {
          multiRef.current = entries;
          setMulti(entries);
        } else {
          multiRef.current = null;
          const initialForm = initToFormState(parsed.data, seed);
          formRef.current = initialForm;
          setMulti(null);
          setForm(initialForm);
        }
      }

      const privateGrant = parsed.context.privateContext;
      const session = transportRef.current;
      if (!privateGrant) {
        if (privateCapabilityRef.current || privateContextRef.current) resetPrivateState();
        return;
      }
      const capability = privateGrant.capability;
      privateInitContextRef.current = parsed.context;
      if (!session) {
        deferredCollectionRef.current = undefined;
        post(buildPrivateContextStatus(frameNonce, capability, "error"));
        setCurrentTypesState({
          kind: "error",
          message: "Private card context was not requested for this frame.",
        });
        return;
      }
      if (privateCapabilityRef.current === capability) {
        const loaded = privateContextRef.current;
        if (loaded) {
          if (!cardContextMatchesInit(loaded.authoritative, parsed.context)) {
            post(buildPrivateContextStatus(frameNonce, capability, "error"));
            resetPrivateState();
            setCurrentTypesState({
              kind: "error",
              message: "Private card context did not match this card.",
            });
          } else {
            // Re-acknowledge an exact idempotent init: the host may have retried after losing the
            // first status message, but no capability/session/card coordinate is allowed to drift.
            post(buildPrivateContextStatus(frameNonce, capability, "ready"));
          }
        }
        return;
      }
      destroyLoadedCardContext(privateContextRef.current);
      privateContextRef.current = undefined;
      deferredCollectionRef.current = undefined;
      privateCapabilityRef.current = capability;
      setTemplates([]);
      clearPrivateSelections();
      setCurrentTypesState({ kind: "loading" });
      const capturedNonce = frameNonce;
      void loadCardPrivateContext(capability, session)
        .then((loaded) => {
          const loadIsCurrent = privateLoadMatchesCurrent(
            capturedNonce,
            session,
            capability,
            frameNonceRef.current,
            transportRef.current,
            privateCapabilityRef.current,
          );
          const contextMatches = cardContextMatchesInit(
            loaded.authoritative,
            privateInitContextRef.current ?? parsed.context,
          );
          if (disposed || !loadIsCurrent || !contextMatches) {
            destroyLoadedCardContext(loaded);
            if (!disposed && loadIsCurrent && !contextMatches) {
              privateCapabilityRef.current = undefined;
              privateInitContextRef.current = undefined;
              deferredCollectionRef.current = undefined;
              clearPrivateSelections();
              setCurrentTypesState({
                kind: "error",
                message: "Private card context did not match this card.",
              });
              post(buildPrivateContextStatus(capturedNonce, capability, "error"));
            }
            return;
          }
          destroyLoadedCardContext(privateContextRef.current);
          privateContextRef.current = loaded;
          setTemplates(loaded.templates);

          const rawEntries = Array.isArray(parsed.data.entries) ? parsed.data.entries : null;
          if (rawEntries && rawEntries.length > 0) {
            // OpenChat may filter a model-produced array down to one surviving
            // row. The shared full message can still name a dropped sibling,
            // so even a one-row array uses only its row-local note evidence.
            const evidence = "row-local" as const;
            const currentMulti = multiRef.current;
            if (currentMulti) {
              const hydratedMulti = currentMulti.map((state, index) =>
                hydrateSavedTypeForCard(
                  state,
                  rawEntries[index] ?? {},
                  loaded.templates,
                  { evidence },
                ),
              );
              multiRef.current = hydratedMulti;
              setMulti(hydratedMulti);
            }
          } else {
            const hydratedForm = hydrateSavedTypeForCard(
              formRef.current,
              parsed.data,
              loaded.templates,
            );
            formRef.current = hydratedForm;
            setForm(hydratedForm);
          }
          setCurrentTypesState({ kind: "ready" });
          post(buildPrivateContextStatus(capturedNonce, capability, "ready"));
          flushDeferredCollection();
        })
        .catch((error) => {
          if (
            disposed ||
            !privateLoadMatchesCurrent(
              capturedNonce,
              session,
              capability,
              frameNonceRef.current,
              transportRef.current,
              privateCapabilityRef.current,
            )
          ) return;
          privateCapabilityRef.current = undefined;
          privateInitContextRef.current = undefined;
          deferredCollectionRef.current = undefined;
          clearPrivateSelections();
          setCurrentTypesState({
            kind: "error",
            message: error instanceof Error ? error.message : "Account types are unavailable.",
          });
          post(buildPrivateContextStatus(capturedNonce, capability, "error"));
        });
    }
    window.addEventListener("message", onMessage);
    return () => {
      disposed = true;
      window.removeEventListener("message", onMessage);
      destroyLoadedCardContext(privateContextRef.current);
      privateContextRef.current = undefined;
      privateCapabilityRef.current = undefined;
      privateInitContextRef.current = undefined;
      destroyCardTransportSession(transportRef.current);
      transportRef.current = undefined;
      frameNonceRef.current = null;
      parentTargetOriginRef.current = null;
      initializedNonceRef.current = null;
      collectionRequestRef.current = undefined;
      collectionInFlightRef.current = false;
      deferredCollectionRef.current = undefined;
    };
  }, [post]);

  // The fetch usually lands AFTER init, so adopt it wherever the card is still deferring
  // (currency ""). Keyed on appCurrency alone, so a user who deliberately picks "Your IOU default"
  // afterwards is never overridden.
  useEffect(() => {
    if (!appCurrency) return;
    setForm((f) => (f.currency === "" ? { ...f, currency: appCurrency } : f));
    setMulti((m) =>
      m ? m.map((e) => (e.currency === "" ? { ...e, currency: appCurrency } : e)) : m,
    );
  }, [appCurrency]);

  // Size the host iframe to settled initialized content. The short quiet window coalesces React's
  // public-init/private-hydration layout burst so the host never animates through transient heights.
  // Before init there are no authoritative values to size or reveal, so do not report the empty
  // read-only placeholder at all.
  const cardInitialized = ctx !== null;
  useEffect(() => {
    if (!cardInitialized) return;
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const reporter = createCoalescedCardResizeReporter(
      () => el.getBoundingClientRect().height,
      (height) => {
        const frameNonce = frameNonceRef.current;
        if (frameNonce) post(buildResize(frameNonce, height));
      },
    );
    const ro = new ResizeObserver(reporter.schedule);
    ro.observe(el);
    reporter.schedule();
    return () => {
      ro.disconnect();
      reporter.dispose();
    };
  }, [post, cardInitialized]);

  const currencyOptions = useMemo(
    // Selected currency first, then USD/EUR/GBP, then the rest; fold the current
    // value in via `extra` so a non-ISO code never drops out of the picker.
    () => orderedCurrencies(form.currency, [form.currency]),
    [form.currency],
  );

  const formValid = isCardFormValid(form);

  const set = <K extends keyof CardFormState>(key: K, value: CardFormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));


  // MULTI-mode edits patch one entry in the list. The host-owned button later requests one exact
  // unwrapped array snapshot (parseDraftBatch), so there is no action control inside this iframe.
  const setEntry = useCallback(
    <K extends keyof CardFormState>(idx: number, key: K, value: CardFormState[K]) =>
      setMulti((m) => (m ? m.map((e, i) => (i === idx ? { ...e, [key]: value } : e)) : m)),
    [],
  );
  const multiAllValid = !!multi && multi.length > 0 && multi.every(isCardFormValid);

  const readonly = ctx?.readonly ?? true;
  const theme = ctx?.theme ?? "dark";
  const themeVars = THEME_VARS[theme] as CSSProperties;

  // NOTE: no `minHeight: "100vh"` here. This element is the one the ResizeObserver measures, and
  // inside the iframe `100vh` IS the height the host most recently applied — so the measurement was
  // always max(content, currentFrameHeight) and `oc:card:resize` became a one-way ratchet: the card
  // could grow but never shrink. That is why an expanded card stayed too tall (a consumed card
  // re-expanded into a fresh iframe still sized to the old editable-form height, and the much shorter
  // read-only view could not pull it back down). The viewport height lives on the html/body element
  // below instead, so the frame is still fully painted without contaminating the measurement.
  const rootStyle: CSSProperties = {
    ...themeVars,
    background: "var(--bg)",
    color: "var(--text)",
    padding: 16,
    fontFamily: "var(--font, 'Manrope', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif)",
    boxSizing: "border-box",
  };

  // Paint the themed background on the document itself. Without the 100vh above, a frame that is
  // taller than the content (the host clamps to MIN_CARD_HEIGHT) would otherwise show the global
  // stylesheet's background in that band — wrong in the light theme.
  useEffect(() => {
    const bg = (themeVars as Record<string, string>)["--bg"];
    if (!bg) return;
    const html = document.documentElement;
    const prevHtml = html.style.background;
    const prevBody = document.body.style.background;
    html.style.background = bg;
    document.body.style.background = bg;
    return () => {
      html.style.background = prevHtml;
      document.body.style.background = prevBody;
    };
  }, [themeVars]);

  return (
    <div
      ref={rootRef}
      style={rootStyle}
      data-theme={theme}
    >
      <div
        className="card"
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 14,
          padding: 16,
          maxWidth: 460,
          margin: "0 auto",
          boxShadow: "0 1px 3px rgba(0,0,0,0.35)",
        }}
      >
        <CardTypesStatus state={typesState} />

        {multi ? (
          readonly ? (
            // Direct/legacy MULTI + readonly: every entry rendered read-only and numbered.
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
              {multi.map((entry, i) => (
                <div key={i} style={entryBlockStyle}>
                  <EntryHeading index={i} total={multi.length} />
                  <ReadonlyView form={entry} templates={templates} />
                </div>
              ))}
            </div>
          ) : (
            // Direct/legacy MULTI + editable: compact entry blocks; host actions remain outside.
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
              {multi.map((entry, i) => (
                <EntryRow
                  key={i}
                  index={i}
                  total={multi.length}
                  entry={entry}
                  onChange={(k, v) => setEntry(i, k, v)}
                  templates={templates}
                  disabled={submitting}
                />
              ))}
              {!multiAllValid && (
                <span style={{ fontSize: "0.75rem", color: "var(--text-dim)", textAlign: "right" }}>
                  Check each entry's amount, Type, direction, and Note before adding.
                </span>
              )}
            </div>
          )
        ) : readonly ? (
          <ReadonlyView form={form} templates={templates} />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
            {/* Three to a wrapping row instead of two-then-one: at card width they sit on one line,
                and each still has a flex basis wide enough to wrap rather than squash on a narrow
                bubble. Two rows of controls where there used to be three. */}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Field label="Amount" style={{ flex: "1 1 96px" }}>
                <input
                  type="number"
                  inputMode="decimal"
                  step="any"
                  min={IOU_MIN_MAJOR_AMOUNT}
                  max={IOU_MAX_MAJOR_AMOUNT}
                  aria-label="Amount"
                  disabled={submitting}
                  value={form.amount}
                  onChange={(e) => set("amount", e.target.value)}
                  placeholder="0.00"
                  style={inputStyle}
                />
              </Field>
              <Field label="Currency" style={{ flex: "1 1 96px" }}>
                <select
                  aria-label="Currency"
                  disabled={submitting}
                  value={form.currency}
                  onChange={(e) => set("currency", e.target.value)}
                  style={inputStyle}
                >
                  {/* "" defers to the user's IOU default (prefs.defaultCurrency), resolved at import
                      — the iframe is storage-partitioned and can't read that setting itself. */}
                  {/* "" → resolved to YOUR IOU default currency at import; the frame cannot read it
                      (see initToFormState), so it names the source instead of guessing a code. */}
                  <option value="">Your IOU default</option>
                  {currencyOptions.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Direction" style={{ flex: "1 1 124px" }}>
                <select
                  aria-label="Direction"
                  disabled={submitting}
                  value={form.direction}
                  onChange={(e) => set("direction", e.target.value as Direction)}
                  style={inputStyle}
                >
                  <option value="credit">{DIRECTION_LABELS.credit}</option>
                  <option value="debt">{DIRECTION_LABELS.debt}</option>
                </select>
              </Field>
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <TypeFields form={form} onChange={set} templates={templates} disabled={submitting} />
              <DateField form={form} onChange={set} disabled={submitting} />
            </div>

            <Field label="Note">
              <input
                type="text"
                aria-label="Note"
                disabled={submitting}
                value={form.note}
                maxLength={4_096}
                onChange={(e) => set("note", e.target.value)}
                placeholder="lunch, taxi, reservation…"
                style={inputStyle}
              />
            </Field>
            {!formValid && (
              <span style={{ fontSize: "0.75rem", color: "var(--text-dim)", textAlign: "right" }}>
                Check the amount, Type, direction, and Note before adding.
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// The card must be COMPACT without becoming un-tappable, so size and touch target are decoupled:
// the type scales down (0.9375rem here, 0.6875rem labels) while `minHeight` holds every interactive
// control at TOUCH_TARGET regardless. Shrinking the padding alone would have dragged the hit area
// down with the text — 8px padding on a 0.875rem font is a ~33px control, well under any touch
// guideline. verify-card-compact asserts both halves: the heights, and that the card got shorter.
//
// 44 is not a round number: it is the WCAG 2.5.5 / Apple HIG target size. The type shrank; the thing
// a finger has to hit did not.
const TOUCH_TARGET = 44;

const inputStyle: CSSProperties = {
  fontFamily: "inherit",
  fontSize: "0.9375rem",
  border: "1px solid var(--border)",
  borderRadius: 10,
  // Vertical padding is a floor, not the height: minHeight does the real work, so a smaller font
  // tightens the look and the control stays tappable.
  padding: "7px 10px",
  minHeight: TOUCH_TARGET,
  width: "100%",
  background: "var(--surface-2)",
  color: "var(--text)",
  boxSizing: "border-box",
};

function Field({
  label,
  children,
  style,
}: {
  label: string;
  children: React.ReactNode;
  style?: CSSProperties;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, ...style }}>
      <span style={{ fontSize: "0.6875rem", color: "var(--text-dim)" }}>{label}</span>
      {children}
    </label>
  );
}

// Match the registered/backend-required public ledger semantics before answering the host's one-click
// collection challenge. The Type selector cannot create an invalid blank value, and stale/malformed
// initialization remains fail closed in both single and multi mode.
export function isCardFormValid(s: CardFormState): boolean {
  const n = Number(s.amount);
  const minorUnits = Math.round(n * 100);
  const currency = s.currency.trim();
  const date = s.date.trim();
  const dateTimestamp = /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? Date.parse(`${date}T00:00:00Z`)
    : Number.NaN;
  const dateIsValid =
    date === "" ||
    (date.slice(0, 4) !== "0000" &&
      Number.isFinite(dateTimestamp) &&
      new Date(dateTimestamp).toISOString().slice(0, 10) === date);
  return (
    s.amount.trim() !== "" &&
    Number.isFinite(n) &&
    n >= IOU_MIN_MAJOR_AMOUNT &&
    n <= IOU_MAX_MAJOR_AMOUNT &&
    Number.isSafeInteger(minorUnits) &&
    minorUnits >= 1 &&
    (currency === "" || /^[A-Za-z]{3}$/.test(currency)) &&
    (s.kind === "iou" || s.kind === "settlement") &&
    (s.direction === "credit" || s.direction === "debt") &&
    dateIsValid &&
    [...s.note].length <= 4_096 &&
    !s.note.includes("\0")
  );
}

// A subtle bordered container that separates one entry from the next in MULTI mode.
const entryBlockStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  padding: 8,
  borderRadius: 10,
  border: "1px solid var(--border)",
  background: "var(--surface-2)",
};

// "Entry i of N" caption above each MULTI block.
function EntryHeading({ index, total }: { index: number; total: number }) {
  return (
    <span
      style={{
        fontSize: "0.6875rem",
        fontWeight: 700,
        letterSpacing: 0.6,
        textTransform: "uppercase",
        color: "var(--accent)",
      }}
    >
      Entry {index + 1} of {total}
    </span>
  );
}

// Transaction kind is a public closed enum. Account type is private: the
// viewer-authorized roster is decrypted only inside this iframe, displayed by
// name, and represented by an account-local id only in memory. Confirmation
// encrypts that id before it crosses the bridge.
export function TypeFields({
  form,
  onChange,
  templates,
  disabled = false,
}: {
  form: CardFormState;
  onChange: <K extends keyof CardFormState>(key: K, value: CardFormState[K]) => void;
  templates: TxnTemplate[];
  disabled?: boolean;
}) {
  return (
    <>
      <Field label="Type" style={{ flex: "1 1 108px" }}>
         <select
           aria-label="Type"
           disabled={disabled}
           value={form.kind}
          onChange={(e) => onChange("kind", e.target.value as CardFormState["kind"])}
          style={inputStyle}
        >
          <option value="iou">{KIND_LABELS.iou}</option>
          <option value="settlement">{KIND_LABELS.settlement}</option>
        </select>
      </Field>
      <Field label="Saved type" style={{ flex: "1 1 128px" }}>
         <select
           aria-label="Saved type"
           disabled={disabled}
           value={form.templateId ?? ""}
          onChange={(e) => onChange("templateId", e.target.value || undefined)}
          style={inputStyle}
        >
          <option value="">None</option>
          {templates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name}
            </option>
          ))}
        </select>
      </Field>
    </>
  );
}

/** Public transaction date, shown in the single iframe and direct/legacy multi compatibility UI. */
export function DateField({
  form,
  onChange,
  disabled = false,
}: {
  form: CardFormState;
  onChange: <K extends keyof CardFormState>(key: K, value: CardFormState[K]) => void;
  disabled?: boolean;
}) {
  return (
    <Field label="Date" style={{ flex: "1 1 112px" }}>
       <input
         type="date"
         aria-label="Date"
         disabled={disabled}
         value={form.date}
        onChange={(event) => onChange("date", event.target.value)}
        style={inputStyle}
      />
    </Field>
  );
}

// One editable entry in MULTI mode: amount / currency / direction on one wrapping line, note below.
// Reuses the single card's Field + inputStyle + DIRECTION_LABELS so styling and theming match
// exactly. Purely presentational — edits flow up through onChange; no session/canister/identity use.
function EntryRow({
  index,
  total,
  entry,
  onChange,
  templates,
  disabled,
}: {
  index: number;
  total: number;
  entry: CardFormState;
  onChange: <K extends keyof CardFormState>(key: K, value: CardFormState[K]) => void;
  // Compatibility-only roster input. Current OpenChat multi never enters this iframe; its Saved
  // types resolve independently from each row's local evidence during IOU import/review.
  templates: TxnTemplate[];
  disabled: boolean;
}) {
  const currencyOptions = useMemo(
    () => orderedCurrencies(entry.currency, [entry.currency]),
    [entry.currency],
  );
  const valid = isCardFormValid(entry);
  return (
    <div style={entryBlockStyle}>
      <EntryHeading index={index} total={total} />
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Field label="Amount" style={{ flex: "1 1 84px" }}>
          <input
            type="number"
            inputMode="decimal"
            step="any"
           min={IOU_MIN_MAJOR_AMOUNT}
           max={IOU_MAX_MAJOR_AMOUNT}
           aria-label="Amount"
           disabled={disabled}
           value={entry.amount}
            onChange={(e) => onChange("amount", e.target.value)}
            placeholder="0.00"
            style={inputStyle}
          />
        </Field>
        <Field label="Currency" style={{ flex: "1 1 84px" }}>
         <select
           aria-label="Currency"
           disabled={disabled}
           value={entry.currency}
            onChange={(e) => onChange("currency", e.target.value)}
            style={inputStyle}
          >
            {/* "" → the user's IOU default currency, filled at import (see single-mode note). */}
            <option value="">Your default</option>
            {currencyOptions.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Direction" style={{ flex: "1 1 118px" }}>
         <select
           aria-label="Direction"
           disabled={disabled}
           value={entry.direction}
            onChange={(e) => onChange("direction", e.target.value as Direction)}
            style={inputStyle}
          >
            <option value="credit">{DIRECTION_LABELS.credit}</option>
            <option value="debt">{DIRECTION_LABELS.debt}</option>
          </select>
        </Field>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <TypeFields form={entry} onChange={onChange} templates={templates} disabled={disabled} />
        <DateField form={entry} onChange={onChange} disabled={disabled} />
      </div>
      <Field label="Note">
         <input
           type="text"
           aria-label="Note"
           disabled={disabled}
           value={entry.note}
          maxLength={4_096}
          onChange={(e) => onChange("note", e.target.value)}
          placeholder="lunch, taxi, reservation…"
          style={inputStyle}
        />
      </Field>
      {!valid && (
        <span style={{ fontSize: "0.6875rem", color: "var(--debt)" }}>
          Enter an amount greater than 0 and choose a Type.
        </span>
      )}
    </div>
  );
}

// Read-only rendering (a consumed card, or the non-acting member): the same
// values, no inputs, no buttons.
export function ReadonlyView({
  form,
  templates,
}: {
  form: CardFormState;
  templates: TxnTemplate[];
}) {
  const rows: { label: string; value: string }[] = [
    { label: "Amount", value: form.amount ? `${form.amount} ${form.currency || "(your IOU default)"}` : "—" },
  ];
  // Between Currency and Direction, which is where the classic OC-rendered table put them — and, like
  // that renderer, only when they carry a value.
  if (form.kind !== "") rows.push({ label: "Type", value: KIND_LABELS[form.kind] });
  const template = templates.find((candidate) => candidate.id === form.templateId);
  if (template) rows.push({ label: "Saved type", value: template.name });
  rows.push({ label: "Direction", value: DIRECTION_LABELS[form.direction] });
  rows.push({ label: "Note", value: form.note || "—" });
  if (form.date) rows.push({ label: "Date", value: form.date });
  return (
    // Nothing here is tappable, so the touch floor does not apply — this view can go as tight as it
    // reads.
    <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 10 }}>
      {rows.map((r) => (
        <div key={r.label} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
          <span style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>{r.label}</span>
          <span style={{ fontSize: "0.875rem", fontWeight: 600, textAlign: "right" }}>{r.value}</span>
        </div>
      ))}
    </div>
  );
}
