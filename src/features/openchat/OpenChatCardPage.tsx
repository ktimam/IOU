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
import {
  parseInit,
  initToFormState,
  buildConfirmPayload,
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

  // Announce readiness once; accept init (and re-inits) from the host.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const parsed = parseInit(event.data);
      if (!parsed) return; // ignore devtools / HMR / foreign messages
      setCtx(parsed.context);
      setForm(initToFormState(parsed.data));
    }
    window.addEventListener("message", onMessage);
    post(buildReady());
    return () => window.removeEventListener("message", onMessage);
  }, [post]);

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
    if (!amountValid) return;
    post(buildConfirm(buildConfirmPayload(form)));
  };
  const onCancel = () => post(buildCancel());

  const { readonly } = ctx;
  const themeVars = THEME_VARS[ctx.theme] as CSSProperties;

  const rootStyle: CSSProperties = {
    ...themeVars,
    background: "var(--bg)",
    color: "var(--text)",
    minHeight: "100vh",
    padding: 16,
    fontFamily: "var(--font, 'Manrope', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif)",
    boxSizing: "border-box",
  };

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
            <span style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>
              {readonly ? "View only" : "Review and edit before adding to your ledger"}
            </span>
          </div>
        </div>

        {readonly ? (
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

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
              <button
                type="button"
                onClick={onCancel}
                style={{ ...btnStyle, background: "transparent", color: "var(--text)", border: "1px solid var(--border)" }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onConfirm}
                disabled={!amountValid}
                style={{
                  ...btnStyle,
                  background: amountValid ? "var(--accent)" : "#2a3038",
                  color: amountValid ? "var(--on-accent)" : "#5b646e",
                  cursor: amountValid ? "pointer" : "not-allowed",
                }}
              >
                Add to IOU
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

// Read-only rendering (a consumed card, or the non-acting member): the same
// values, no inputs, no buttons.
function ReadonlyView({ form }: { form: CardFormState }) {
  const rows: { label: string; value: string }[] = [
    { label: "Amount", value: form.amount ? `${form.amount} ${form.currency}` : "—" },
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
