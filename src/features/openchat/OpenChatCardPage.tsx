// /openchat/card — IOU's OWN app-rendered confirmable card.
//
// OpenChat embeds this page as an opaque, credentialless sandboxed iframe.
// The page has no IOU browser session or user identity. After an explicit
// host-side load gesture, it redeems a short-lived capability bound to this
// viewer, card, app revision, and iframe recipient key. Only the linked
// account's encrypted type roster is released and decrypted in iframe memory.
//
// Every bridge message uses protocol v2 and a fresh per-document nonce. A
// selected private type leaves the iframe only as an encrypted template_ref
// bound to the sheet, chat, message, and entry row.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Direction } from "../entries/types";
import { matchTemplateForDraft } from "../entries/resolveTemplateBase";
import { orderedCurrencies } from "../settings/currencies";
import type { TxnTemplate } from "../templates/TemplatesContext";
import { IOU_ICON_DATA_URI } from "./actionManifest";
import { fetchCardCurrency } from "./cardCurrency";
import {
  parseBootstrap,
  cardParentTargetOrigin,
  parseInit,
  parseBusy,
  parsePrivateContextRequest,
  initToFormState,
  initEntries,
  buildConfirmPayload,
  buildMultiConfirmPayload,
  buildReady,
  buildPrivateContextReady,
  buildResize,
  buildConfirm,
  buildCancel,
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

function withAutoType(
  state: CardFormState,
  raw: unknown,
  templates: TxnTemplate[],
): CardFormState {
  if (state.templateId) return state;
  const matched = matchTemplateForDraft(templates, raw);
  return matched ? { ...state, templateId: matched.id } : state;
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
  // MULTI mode: a non-null list of per-entry form states (initEntries detected data.entries).
  // null → SINGLE mode, which renders exactly today's one-entry UI from `form`.
  const [multi, setMulti] = useState<CardFormState[] | null>(null);
  // "confirm"/"cancel" while that action round-trips through the host (deposit + fan-out); "idle"
  // otherwise. Drives the button lock + spinner so a press is acknowledged and can't be double-fired.
  const [phase, setPhase] = useState<"idle" | "confirm" | "cancel">("idle");
  const submitting = phase !== "idle";
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
  const transportRef = useRef<CardTransportSession>();
  const privateContextRef = useRef<LoadedCardPrivateContext>();
  const privateCapabilityRef = useRef<string>();
  const privateInitContextRef = useRef<CardInitContext>();
  const [templates, setTemplates] = useState<TxnTemplate[]>([]);
  const [typesState, setTypesState] = useState<
    { kind: "waiting" | "loading" | "ready" } | { kind: "error"; message: string }
  >({ kind: "waiting" });

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

    const resetPrivateState = () => {
      destroyLoadedCardContext(privateContextRef.current);
      privateContextRef.current = undefined;
      privateCapabilityRef.current = undefined;
      privateInitContextRef.current = undefined;
      setTemplates([]);
      setTypesState({ kind: "waiting" });
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
          setCtx(null);
          setPhase("idle");
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
          setTypesState({ kind: "error", message: "Could not create a private card session." });
        }
        return;
      }
      // Progress signal: the host is (or finished) round-tripping our confirm/cancel. Drives the
      // in-frame button lock + spinner. busy=false clears the phase; busy=true keeps it (the click
      // already set which action), defaulting to "confirm" if somehow unset.
      const busyMsg = parseBusy(event.data, frameNonce);
      if (busyMsg) {
        setPhase((p) => (busyMsg.busy ? (p === "idle" ? "confirm" : p) : "idle"));
        return;
      }
      const parsed = parseInit(event.data, frameNonce);
      if (!parsed) return; // ignore devtools / HMR / foreign messages
      setCtx(parsed.context);
      if (initializedNonceRef.current !== frameNonce) {
        initializedNonceRef.current = frameNonce;
        // Seed public form data only once. Host re-init updates theme/readonly/private authority and
        // must never overwrite edits the viewer has already made in the isolated frame.
        const seed = appCurrencyRef.current ?? "";
        const entries = initEntries(parsed.data, seed);
        if (entries) {
          setMulti(entries);
        } else {
          setMulti(null);
          setForm(initToFormState(parsed.data, seed));
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
        setTypesState({
          kind: "error",
          message: "Private card context was not requested for this frame.",
        });
        return;
      }
      if (privateCapabilityRef.current === capability) {
        const loaded = privateContextRef.current;
        if (loaded && !cardContextMatchesInit(loaded.authoritative, parsed.context)) {
          resetPrivateState();
          setTypesState({ kind: "error", message: "Private card context did not match this card." });
        }
        return;
      }
      destroyLoadedCardContext(privateContextRef.current);
      privateContextRef.current = undefined;
      privateCapabilityRef.current = capability;
      setTemplates([]);
      setTypesState({ kind: "loading" });
      const capturedNonce = frameNonce;
      void loadCardPrivateContext(capability, session)
        .then((loaded) => {
          if (
            disposed ||
            frameNonceRef.current !== capturedNonce ||
            transportRef.current !== session ||
            privateCapabilityRef.current !== capability ||
            !cardContextMatchesInit(
              loaded.authoritative,
              privateInitContextRef.current ?? parsed.context,
            )
          ) {
            destroyLoadedCardContext(loaded);
            if (
              !disposed &&
              frameNonceRef.current === capturedNonce &&
              privateCapabilityRef.current === capability
            ) {
              privateCapabilityRef.current = undefined;
              privateInitContextRef.current = undefined;
              setTypesState({ kind: "error", message: "Private card context did not match this card." });
            }
            return;
          }
          destroyLoadedCardContext(privateContextRef.current);
          privateContextRef.current = loaded;
          setTemplates(loaded.templates);
          setTypesState({ kind: "ready" });

          const rawEntries = Array.isArray(parsed.data.entries) ? parsed.data.entries : null;
          if (rawEntries && rawEntries.length > 0) {
            setMulti((current) =>
              current
                ? current.map((state, index) =>
                    withAutoType(state, rawEntries[index] ?? {}, loaded.templates),
                  )
                : current,
            );
          } else {
            setForm((current) => withAutoType(current, parsed.data, loaded.templates));
          }
        })
        .catch((error) => {
          if (
            disposed ||
            frameNonceRef.current !== capturedNonce ||
            privateCapabilityRef.current !== capability
          ) return;
          privateCapabilityRef.current = undefined;
          privateInitContextRef.current = undefined;
          setTypesState({
            kind: "error",
            message: error instanceof Error ? error.message : "Account types are unavailable.",
          });
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

  // Size the host iframe to content: post the border-box height whenever it
  // changes (ResizeObserver fires once on observe, giving the initial height).
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let last = -1;
    const ro = new ResizeObserver(() => {
      const h = Math.ceil(el.getBoundingClientRect().height);
      if (h !== last && h > 0) {
        last = h;
        const frameNonce = frameNonceRef.current;
        if (frameNonce) post(buildResize(frameNonce, h));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [post]);

  const currencyOptions = useMemo(
    // Selected currency first, then USD/EUR/GBP, then the rest; fold the current
    // value in via `extra` so a non-ISO code never drops out of the picker.
    () => orderedCurrencies(form.currency, [form.currency]),
    [form.currency],
  );

  const amountNum = Number(form.amount);
  const amountValid = form.amount.trim() !== "" && Number.isFinite(amountNum) && amountNum > 0;

  const set = <K extends keyof CardFormState>(key: K, value: CardFormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));


  const encryptedTypeRef = async (
    state: CardFormState,
    entryIndex: number,
    captured: LoadedCardPrivateContext,
  ): Promise<string | undefined> => {
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
  };

  const onConfirm = async () => {
    const frameNonce = frameNonceRef.current;
    if (!amountValid || submitting || !frameNonce || !ctx) return;
    setPhase("confirm"); // instant feedback; the host's busy signal keeps/clears it
    const captured = privateContextRef.current;
    try {
      const typeRef = form.templateId
        ? captured
          ? await encryptedTypeRef(form, 0, captured)
          : (() => { throw new Error("Account types are not ready."); })()
        : undefined;
      if (
        frameNonceRef.current !== frameNonce ||
        (captured && privateContextRef.current !== captured)
      ) {
        setPhase("idle");
        return;
      }
      post(buildConfirm(frameNonce, buildConfirmPayload(form, typeRef)));
    } catch (error) {
      setPhase("idle");
      setTypesState({
        kind: "error",
        message: error instanceof Error ? error.message : "Could not protect the selected account type.",
      });
    }
  };
  const onCancel = () => {
    const frameNonce = frameNonceRef.current;
    if (submitting || !frameNonce) return;
    setPhase("cancel");
    post(buildCancel(frameNonce));
  };

  // MULTI-mode edit + confirm. Edits patch one entry in the list; the single "Add all" button gates
  // on every entry having a valid (>0) amount and hands back the UNWRAPPED array (parseDraftBatch).
  const setEntry = useCallback(
    <K extends keyof CardFormState>(idx: number, key: K, value: CardFormState[K]) =>
      setMulti((m) => (m ? m.map((e, i) => (i === idx ? { ...e, [key]: value } : e)) : m)),
    [],
  );
  const multiAllValid = !!multi && multi.length > 0 && multi.every(isAmountValid);
  const onConfirmAll = async () => {
    const frameNonce = frameNonceRef.current;
    if (!multi || !multiAllValid || submitting || !frameNonce || !ctx) return;
    setPhase("confirm");
    const captured = privateContextRef.current;
    try {
      if (multi.some((entry) => entry.templateId) && !captured) {
        throw new Error("Account types are not ready.");
      }
      const refs = captured
        ? await Promise.all(multi.map((entry, index) => encryptedTypeRef(entry, index, captured)))
        : [];
      if (
        frameNonceRef.current !== frameNonce ||
        (captured && privateContextRef.current !== captured)
      ) {
        setPhase("idle");
        return;
      }
      post(buildConfirm(frameNonce, buildMultiConfirmPayload(multi, refs)));
    } catch (error) {
      setPhase("idle");
      setTypesState({
        kind: "error",
        message: error instanceof Error ? error.message : "Could not protect the selected account types.",
      });
    }
  };

  const readonly = ctx?.readonly ?? true;
  const theme = ctx?.theme ?? "dark";
  const themeVars = THEME_VARS[theme] as CSSProperties;

  // Header subtitle. SINGLE mode keeps today's exact copy; MULTI mode names the entry count.
  const subtitle = readonly
    ? "View only"
    : multi
      ? `Review and edit ${multi.length} ${multi.length === 1 ? "entry" : "entries"} before adding to your ledger`
      : "Review and edit before adding to your ledger";

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
    <div ref={rootRef} style={rootStyle} data-theme={theme}>
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
        {/* IOU brand header — this card is IOU's, not OpenChat's. */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
          <img src={IOU_ICON_DATA_URI} alt="" width={28} height={28} style={{ borderRadius: 7 }} />
          <div style={{ display: "flex", flexDirection: "column" }}>
            <strong style={{ fontSize: "1.05rem", letterSpacing: 0.2 }}>Add to IOU</strong>
            <span style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>{subtitle}</span>
          </div>
        </div>

        {typesState.kind === "loading" && (
          <div style={{ fontSize: "0.75rem", color: "var(--text-dim)", marginTop: 8 }}>
            Loading this account's saved types…
          </div>
        )}
        {typesState.kind === "error" && (
          <div
            role="status"
            style={{ fontSize: "0.75rem", color: "var(--text-dim)", marginTop: 8 }}
          >
            {typesState.message}
          </div>
        )}

        {multi ? (
          readonly ? (
            // MULTI + readonly: every entry rendered read-only, numbered, no buttons.
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
              {multi.map((entry, i) => (
                <div key={i} style={entryBlockStyle}>
                  <EntryHeading index={i} total={multi.length} />
                  <ReadonlyView form={entry} templates={templates} />
                </div>
              ))}
            </div>
          ) : (
            // MULTI + editable: N compact entry blocks + a single "Add all N entries" confirm.
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
              {multi.map((entry, i) => (
                <EntryRow
                  key={i}
                  index={i}
                  total={multi.length}
                  entry={entry}
                  onChange={(k, v) => setEntry(i, k, v)}
                  templates={templates}
                />
              ))}
              {/* WRAP is load-bearing, not cosmetic. The host sizes this frame with `max-width: 100%`, so in a
                  narrow bubble it is far below its 420px preference, while a flex row cannot shrink a
                  button below its text. With justify-content: flex-end the excess overflows the START
                  edge — the buttons slide out of the card to the LEFT, where scrollWidth cannot even
                  see them. Worst while cancelling, because that label GROWS ("Cancel" -> spinner +
                  "Cancelling…") whereas confirm shrinks: measured 69px outside at a 240px frame. */}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4, minWidth: 0 }}>
                <button
                  type="button"
                  onClick={onCancel}
                  disabled={submitting}
                  style={{ ...btnStyle, background: "transparent", color: "var(--text)", border: "1px solid var(--border)", cursor: submitting ? "not-allowed" : "pointer", opacity: submitting && phase !== "cancel" ? 0.5 : 1 }}
                >
                  {phase === "cancel" ? <><Spinner /> Cancelling…</> : "Cancel"}
                </button>
                {/* Hidden once Cancel is pressed: the action is already decided, so still offering
                    "Add" is misleading — and dropping it leaves a single button, which is what keeps
                    the widest state (spinner + "Cancelling…") inside a narrow frame. */}
                {phase !== "cancel" && (
                <button
                  type="button"
                  onClick={onConfirmAll}
                  disabled={!multiAllValid || submitting}
                  style={{
                    ...btnStyle,
                    background: (multiAllValid && !submitting) || phase === "confirm" ? "var(--accent)" : "#2a3038",
                    color: (multiAllValid && !submitting) || phase === "confirm" ? "var(--on-accent)" : "#5b646e",
                    cursor: multiAllValid && !submitting ? "pointer" : "not-allowed",
                  }}
                >
                  {phase === "confirm" ? <><Spinner /> Adding…</> : `Add all ${multi.length} entries`}
                </button>
                )}
              </div>
              {!multiAllValid && (
                <span style={{ fontSize: "0.75rem", color: "var(--text-dim)", textAlign: "right" }}>
                  Each entry needs an amount greater than 0 to add.
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
                  step="0.01"
                  min="0"
                  aria-label="Amount"
                  value={form.amount}
                  onChange={(e) => set("amount", e.target.value)}
                  placeholder="0.00"
                  style={inputStyle}
                />
              </Field>
              <Field label="Currency" style={{ flex: "1 1 96px" }}>
                <select
                  aria-label="Currency"
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
              <TypeFields form={form} onChange={set} templates={templates} />
            </div>

            <Field label="Note">
              <input
                type="text"
                aria-label="Note"
                value={form.note}
                onChange={(e) => set("note", e.target.value)}
                placeholder="lunch, taxi, reservation…"
                style={inputStyle}
              />
            </Field>


            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4, minWidth: 0 }}>
              <button
                type="button"
                onClick={onCancel}
                disabled={submitting}
                style={{ ...btnStyle, background: "transparent", color: "var(--text)", border: "1px solid var(--border)", cursor: submitting ? "not-allowed" : "pointer", opacity: submitting && phase !== "cancel" ? 0.5 : 1 }}
              >
                {phase === "cancel" ? <><Spinner /> Cancelling…</> : "Cancel"}
              </button>
              {/* Hidden once Cancel is pressed — see the multi-entry row. */}
              {phase !== "cancel" && (
              <button
                type="button"
                onClick={onConfirm}
                disabled={!amountValid || submitting}
                style={{
                  ...btnStyle,
                  background: (amountValid && !submitting) || phase === "confirm" ? "var(--accent)" : "#2a3038",
                  color: (amountValid && !submitting) || phase === "confirm" ? "var(--on-accent)" : "#5b646e",
                  cursor: amountValid && !submitting ? "pointer" : "not-allowed",
                }}
              >
                {phase === "confirm" ? <><Spinner /> Adding…</> : "Add to IOU"}
              </button>
              )}
            </div>
            {!amountValid && (
              <span style={{ fontSize: "0.75rem", color: "var(--text-dim)", textAlign: "right" }}>
                Enter an amount greater than 0 to add.
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

const btnStyle: CSSProperties = {
  fontFamily: "inherit",
  fontSize: "0.9375rem",
  fontWeight: 600,
  minHeight: TOUCH_TARGET,
  border: 0,
  // Horizontal padding is the FLOOR a button can shrink to (measured: at a 79px row the pair bottomed
  // out at 37+36+8 = 81px, 2px over, with the labels already ellipsized to nothing). vw inside the
  // frame is the FRAME's width, so this keeps the roomy 18px at normal sizes and tightens to 8px in a
  // narrow bubble — which is what lets Cancel and Add stay SIDE BY SIDE instead of wrapping.
  padding: "7px clamp(8px, 4vw, 16px)",
  borderRadius: 10,
  // A flex item will not shrink below its text, so in a narrow frame a button pushes the row past the
  // card's edge (and with justify-content: flex-end it escapes to the LEFT, where scrollWidth cannot
  // see it). minWidth 0 lets it shrink and the label ellipsize instead — the last line of defence
  // after the row's flex-wrap, for frames too narrow to fit even ONE button.
  minWidth: 0,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  // Cancel carries a 1px border while btnStyle sets none, and under content-box that border is added
  // ON TOP of the shrunk width — measured as exactly 2px outside the card at a 160px frame.
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

// True when a form state's amount parses to a positive number — the same rule the single card uses
// to gate its confirm. Gates each MULTI row and the "Add all" button.
function isAmountValid(s: CardFormState): boolean {
  const n = Number(s.amount);
  return s.amount.trim() !== "" && Number.isFinite(n) && n > 0;
}

// A subtle bordered container that separates one entry from the next in MULTI mode.
const entryBlockStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  padding: 10,
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
}: {
  form: CardFormState;
  onChange: <K extends keyof CardFormState>(key: K, value: CardFormState[K]) => void;
  templates: TxnTemplate[];
}) {
  return (
    <>
      <Field label="Transaction" style={{ flex: "1 1 108px" }}>
        <select
          aria-label="Transaction"
          value={form.kind}
          onChange={(e) => onChange("kind", e.target.value as CardFormState["kind"])}
          style={inputStyle}
        >
          <option value="">Auto</option>
          <option value="iou">{KIND_LABELS.iou}</option>
          <option value="settlement">{KIND_LABELS.settlement}</option>
        </select>
      </Field>
      <Field label="Account type" style={{ flex: "1 1 128px" }}>
        <select
          aria-label="Account type"
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

/** Every saved-type name this card carries, deduped — the only suggestions it can offer (see TypeFields). */
// One editable entry in MULTI mode: amount / currency / direction on one wrapping line, note below.
// Reuses the single card's Field + inputStyle + DIRECTION_LABELS so styling and theming match
// exactly. Purely presentational — edits flow up through onChange; no session/canister/identity use.
function EntryRow({
  index,
  total,
  entry,
  onChange,
  templates,
}: {
  index: number;
  total: number;
  entry: CardFormState;
  onChange: <K extends keyof CardFormState>(key: K, value: CardFormState[K]) => void;
  // Pooled across ALL rows, not just this one: a message that routed one entry to a type usually
  // wants its siblings on the same one, and copying it should not mean retyping it.
  templates: TxnTemplate[];
}) {
  const currencyOptions = useMemo(
    () => orderedCurrencies(entry.currency, [entry.currency]),
    [entry.currency],
  );
  const valid = isAmountValid(entry);
  return (
    <div style={entryBlockStyle}>
      <EntryHeading index={index} total={total} />
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Field label="Amount" style={{ flex: "1 1 84px" }}>
          <input
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            aria-label="Amount"
            value={entry.amount}
            onChange={(e) => onChange("amount", e.target.value)}
            placeholder="0.00"
            style={inputStyle}
          />
        </Field>
        <Field label="Currency" style={{ flex: "1 1 84px" }}>
          <select
            aria-label="Currency"
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
        <TypeFields form={entry} onChange={onChange} templates={templates} />
      </div>
      <Field label="Note">
        <input
          type="text"
          aria-label="Note"
          value={entry.note}
          onChange={(e) => onChange("note", e.target.value)}
          placeholder="lunch, taxi, reservation…"
          style={inputStyle}
        />
      </Field>
      {!valid && (
        <span style={{ fontSize: "0.6875rem", color: "var(--debt)" }}>
          Enter an amount greater than 0.
        </span>
      )}
    </div>
  );
}

// Inline processing spinner shown on the button that is round-tripping (self-contained SMIL
// animation → no CSS keyframes needed). `currentColor` inherits the button's text color.
function Spinner() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" style={{ verticalAlign: "-2px", marginRight: 6 }} aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.3" strokeWidth="3" />
      <path d="M12 3a9 9 0 0 1 9 9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
        <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.7s" repeatCount="indefinite" />
      </path>
    </svg>
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
  if (form.kind !== "") rows.push({ label: "Transaction", value: KIND_LABELS[form.kind] });
  const template = templates.find((candidate) => candidate.id === form.templateId);
  if (template) rows.push({ label: "Account type", value: template.name });
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
