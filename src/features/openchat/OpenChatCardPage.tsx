// /openchat/card — IOU's OWN app-rendered confirmable card.
//
// OpenChat embeds this page as a storage-partitioned iframe inside the chat
// bubble (surface kind "card", display "sheet"). Because the frame is
// partitioned by the OpenChat host origin it sees NO IOU session — so this page
// deliberately renders OUTSIDE every auth/session provider (see App.tsx) and
// never calls the IOU canister or reads the user's identity. It only RENDERS an
// editable card (prefilled from the extraction handed over the postMessage
// bridge) and COLLECTS the edited values, handing them back to the host, which
// deposits them (Phase 2/3). See fork-notes/08-app-rendered-cards.md.
//
// Bridge (all pure-built in cardBridge.ts, all posted to window.parent):
//   on mount        → { type: "oc:card:ready" }
//   height changes  → { type: "oc:card:resize", height }
//   "Add to IOU"    → { type: "oc:card:confirm", payload: <EntryDraft> }
//   "Cancel"        → { type: "oc:card:cancel" }
// It accepts only { type: "oc:card:init", version: 1, data, context } (parseInit
// ignores everything else — devtools/HMR/foreign frames).

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Direction } from "../entries/types";
import { orderedCurrencies } from "../settings/currencies";
import { IOU_ICON_DATA_URI } from "./actionManifest";
import { fetchCardCurrency } from "./cardCurrency";
import {
  parseInit,
  parseBusy,
  initToFormState,
  initEntries,
  buildConfirmPayload,
  buildMultiConfirmPayload,
  buildReady,
  buildResize,
  buildConfirm,
  buildCancel,
  type CardFormState,
  type CardInitContext,
  type CardTheme,
} from "./cardBridge";

// Plain-language direction labels (same vocabulary the OC-rendered card used, so
// a human catches an inversion before confirming).
const DIRECTION_LABELS: Record<Direction, string> = {
  credit: "Owed to you",
  debt: "You owe",
};

// A small, clearly-demonstrative tag vocabulary for the multiselect. parseDraft
// ignores the `tags` field, so this is purely illustrative of an app-owned
// control that OpenChat knows nothing about.
const DEMO_TAGS = ["work", "personal", "reimbursable", "recurring", "shared"];


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
  const [ctx, setCtx] = useState<CardInitContext>({ theme: "dark", readonly: false });
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
    // Post to the embedder. targetOrigin "*" per the contract — the HOST
    // origin-checks inbound messages; this frame carries no secret to leak.
    // When opened standalone (window.parent === window) this is a harmless
    // no-op self-post.
    try {
      window.parent?.postMessage(msg, "*");
    } catch {
      /* cross-origin post can throw in exotic sandboxes — non-fatal */
    }
  }, []);

  // Announce readiness once; accept init (and re-inits) + the busy signal from the host.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      // Only accept messages from our EMBEDDER (the OpenChat host). A co-resident sibling frame in the
      // same tab has its own window as event.source — never window.parent — so this rejects a forged
      // oc:card:init (overwriting the values the user is about to confirm) or oc:card:busy (freezing/
      // unlocking the buttons) injected sideways. Standalone (parent === self) still self-delivers.
      if (event.source !== window.parent) return;
      // Progress signal: the host is (or finished) round-tripping our confirm/cancel. Drives the
      // in-frame button lock + spinner. busy=false clears the phase; busy=true keeps it (the click
      // already set which action), defaulting to "confirm" if somehow unset.
      const busyMsg = parseBusy(event.data);
      if (busyMsg) {
        setPhase((p) => (busyMsg.busy ? (p === "idle" ? "confirm" : p) : "idle"));
        return;
      }
      const parsed = parseInit(event.data);
      if (!parsed) return; // ignore devtools / HMR / foreign messages
      setCtx(parsed.context);
      // Seed with the app card currency when it is already known (init usually arrives first, so the
      // effect below adopts it on arrival instead).
      const seed = appCurrencyRef.current ?? "";
      const entries = initEntries(parsed.data, seed);
      if (entries) {
        setMulti(entries); // MULTI: render N editable entry blocks
      } else {
        setMulti(null); // SINGLE: today's one-entry UI
        setForm(initToFormState(parsed.data, seed));
      }
    }
    window.addEventListener("message", onMessage);
    post(buildReady());
    return () => window.removeEventListener("message", onMessage);
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
        post(buildResize(h));
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

  const toggleTag = (tag: string) =>
    setForm((f) => ({
      ...f,
      tags: f.tags.includes(tag) ? f.tags.filter((t) => t !== tag) : [...f.tags, tag],
    }));

  const onConfirm = () => {
    if (!amountValid || submitting) return;
    setPhase("confirm"); // instant feedback; the host's busy signal keeps/clears it
    post(buildConfirm(buildConfirmPayload(form)));
  };
  const onCancel = () => {
    if (submitting) return;
    setPhase("cancel");
    post(buildCancel());
  };

  // MULTI-mode edit + confirm. Edits patch one entry in the list; the single "Add all" button gates
  // on every entry having a valid (>0) amount and hands back the UNWRAPPED array (parseDraftBatch).
  const setEntry = useCallback(
    <K extends keyof CardFormState>(idx: number, key: K, value: CardFormState[K]) =>
      setMulti((m) => (m ? m.map((e, i) => (i === idx ? { ...e, [key]: value } : e)) : m)),
    [],
  );
  const multiAllValid = !!multi && multi.length > 0 && multi.every(isAmountValid);
  const onConfirmAll = () => {
    if (!multi || !multiAllValid || submitting) return;
    setPhase("confirm");
    post(buildConfirm(buildMultiConfirmPayload(multi)));
  };

  const { readonly } = ctx;
  const themeVars = THEME_VARS[ctx.theme] as CSSProperties;

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
    <div ref={rootRef} style={rootStyle} data-theme={ctx.theme}>
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

        {multi ? (
          readonly ? (
            // MULTI + readonly: every entry rendered read-only, numbered, no buttons.
            <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 12 }}>
              {multi.map((entry, i) => (
                <div key={i} style={entryBlockStyle}>
                  <EntryHeading index={i} total={multi.length} />
                  <ReadonlyView form={entry} />
                </div>
              ))}
            </div>
          ) : (
            // MULTI + editable: N compact entry blocks + a single "Add all N entries" confirm.
            <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 12 }}>
              {multi.map((entry, i) => (
                <EntryRow
                  key={i}
                  index={i}
                  total={multi.length}
                  entry={entry}
                  onChange={(k, v) => setEntry(i, k, v)}
                />
              ))}
              {/* WRAP is load-bearing, not cosmetic. The host sizes this frame with `max-width: 100%`, so in a
                  narrow bubble it is far below its 420px preference, while a flex row cannot shrink a
                  button below its text. With justify-content: flex-end the excess overflows the START
                  edge — the buttons slide out of the card to the LEFT, where scrollWidth cannot even
                  see them. Worst while cancelling, because that label GROWS ("Cancel" -> spinner +
                  "Cancelling…") whereas confirm shrinks: measured 69px outside at a 240px frame. */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
                <button
                  type="button"
                  onClick={onCancel}
                  disabled={submitting}
                  style={{ ...btnStyle, background: "transparent", color: "var(--text)", border: "1px solid var(--border)", cursor: submitting ? "not-allowed" : "pointer", opacity: submitting && phase !== "cancel" ? 0.5 : 1 }}
                >
                  {phase === "cancel" ? <><Spinner /> Cancelling…</> : "Cancel"}
                </button>
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
              </div>
              {!multiAllValid && (
                <span style={{ fontSize: "0.75rem", color: "var(--text-dim)", textAlign: "right" }}>
                  Each entry needs an amount greater than 0 to add.
                </span>
              )}
            </div>
          )
        ) : readonly ? (
          <ReadonlyView form={form} />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 12 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Field label="Amount" style={{ flex: "1 1 120px" }}>
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  value={form.amount}
                  onChange={(e) => set("amount", e.target.value)}
                  placeholder="0.00"
                  style={inputStyle}
                />
              </Field>
              <Field label="Currency" style={{ flex: "1 1 120px" }}>
                <select
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
            </div>

            <Field label="Direction">
              <select
                value={form.direction}
                onChange={(e) => set("direction", e.target.value as Direction)}
                style={inputStyle}
              >
                <option value="credit">{DIRECTION_LABELS.credit}</option>
                <option value="debt">{DIRECTION_LABELS.debt}</option>
              </select>
            </Field>

            <Field label="Note">
              <input
                type="text"
                value={form.note}
                onChange={(e) => set("note", e.target.value)}
                placeholder="lunch, taxi, reservation…"
                style={inputStyle}
              />
            </Field>

            {/* Demonstration multiselect (IOU-owned vocabulary OpenChat knows
                nothing about). Included in the payload as tags[] only when any
                are selected; parseDraft ignores the unknown field. */}
            <Field label="Tags (demo — optional)">
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 2 }}>
                {DEMO_TAGS.map((tag) => {
                  const on = form.tags.includes(tag);
                  return (
                    <button
                      key={tag}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleTag(tag)}
                      style={{
                        padding: "5px 12px",
                        borderRadius: 999,
                        fontSize: "0.8125rem",
                        fontWeight: 600,
                        cursor: "pointer",
                        border: `1px solid ${on ? "transparent" : "var(--border)"}`,
                        background: on ? "var(--accent)" : "transparent",
                        color: on ? "var(--on-accent)" : "var(--text)",
                      }}
                    >
                      {tag}
                    </button>
                  );
                })}
              </div>
            </Field>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
              <button
                type="button"
                onClick={onCancel}
                disabled={submitting}
                style={{ ...btnStyle, background: "transparent", color: "var(--text)", border: "1px solid var(--border)", cursor: submitting ? "not-allowed" : "pointer", opacity: submitting && phase !== "cancel" ? 0.5 : 1 }}
              >
                {phase === "cancel" ? <><Spinner /> Cancelling…</> : "Cancel"}
              </button>
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

const inputStyle: CSSProperties = {
  fontFamily: "inherit",
  fontSize: "1rem",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: "10px 12px",
  width: "100%",
  background: "var(--surface-2)",
  color: "var(--text)",
  boxSizing: "border-box",
};

const btnStyle: CSSProperties = {
  fontFamily: "inherit",
  fontSize: "1rem",
  fontWeight: 600,
  border: 0,
  padding: "10px 18px",
  borderRadius: 12,
  // A flex item will not shrink below its text, so in a narrow frame a button pushes the row past the
  // card's edge (and with justify-content: flex-end it escapes to the LEFT, where scrollWidth cannot
  // see it). minWidth 0 lets it shrink and the label ellipsize instead — the last line of defence
  // after the row's flex-wrap, for frames too narrow to fit even ONE button.
  minWidth: 0,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
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
    <label style={{ display: "flex", flexDirection: "column", gap: 4, ...style }}>
      <span style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>{label}</span>
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
  gap: 10,
  padding: 12,
  borderRadius: 12,
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

// One editable entry in MULTI mode: amount / currency / direction on one wrapping line, note below.
// Reuses the single card's Field + inputStyle + DIRECTION_LABELS so styling and theming match
// exactly. Purely presentational — edits flow up through onChange; no session/canister/identity use.
function EntryRow({
  index,
  total,
  entry,
  onChange,
}: {
  index: number;
  total: number;
  entry: CardFormState;
  onChange: <K extends keyof CardFormState>(key: K, value: CardFormState[K]) => void;
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
        <Field label="Amount" style={{ flex: "1 1 90px" }}>
          <input
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            value={entry.amount}
            onChange={(e) => onChange("amount", e.target.value)}
            placeholder="0.00"
            style={inputStyle}
          />
        </Field>
        <Field label="Currency" style={{ flex: "1 1 90px" }}>
          <select
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
        <Field label="Direction" style={{ flex: "1 1 140px" }}>
          <select
            value={entry.direction}
            onChange={(e) => onChange("direction", e.target.value as Direction)}
            style={inputStyle}
          >
            <option value="credit">{DIRECTION_LABELS.credit}</option>
            <option value="debt">{DIRECTION_LABELS.debt}</option>
          </select>
        </Field>
      </div>
      <Field label="Note">
        <input
          type="text"
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
function ReadonlyView({ form }: { form: CardFormState }) {
  const rows: { label: string; value: string }[] = [
    { label: "Amount", value: form.amount ? `${form.amount} ${form.currency || "(your IOU default)"}` : "—" },
    { label: "Direction", value: DIRECTION_LABELS[form.direction] },
    { label: "Note", value: form.note || "—" },
  ];
  if (form.date) rows.push({ label: "Date", value: form.date });
  if (form.tags.length) rows.push({ label: "Tags", value: form.tags.join(", ") });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
      {rows.map((r) => (
        <div key={r.label} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
          <span style={{ fontSize: "0.8125rem", color: "var(--text-dim)" }}>{r.label}</span>
          <span style={{ fontSize: "0.9375rem", fontWeight: 600, textAlign: "right" }}>{r.value}</span>
        </div>
      ))}
    </div>
  );
}
