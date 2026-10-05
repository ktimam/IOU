import { IOU_CARD_STYLE, IOU_CARD_THEME_VARS } from "./cardPresentation";

/**
 * Static app-owned presentation, included in the verified local app catalog.
 * This is inert data matching the host's LocalAppViewV1 contract, not HTML/CSS
 * or a capability. Canonical labels, values, choices, validation, editing,
 * read-only state and every delivery control remain host-owned. The host repeats
 * this one entry tree for its canonical rows and reviews any unrepresented data.
 *
 * The layout/palette mirror OpenChatCardPage without importing its React,
 * window messaging, private-context, crypto or network dependencies. Keep the
 * legacy page behavior unchanged; this module has no authority to activate a host UI.
 */
export type IouLocalCardViewPalette = Readonly<Partial<Record<
  "background" | "surface" | "field" | "text" | "muted" | "border" | "accent", string
>>>;

export type IouLocalCardViewNode = Readonly<{
  kind: "group" | "row";
  children: readonly IouLocalCardViewNode[];
  gap?: "none" | "small" | "medium";
  padding?: "none" | "small" | "medium";
  surface?: "plain" | "card";
  radius?: "none" | "small" | "medium";
}> | Readonly<{
  kind: "field";
  field: string;
  minWidth?: number;
  fullWidth?: boolean;
  control?: "single-line" | "multiline";
}> | Readonly<{
  kind: "text";
  text: string;
  tone?: "normal" | "muted" | "accent";
  size?: "small" | "normal" | "heading";
}>;

export type IouLocalCardViewV1 = Readonly<{
  version: 1;
  nodes: readonly IouLocalCardViewNode[];
  theme?: Readonly<{ light?: IouLocalCardViewPalette; dark?: IouLocalCardViewPalette }>;
}>;

/**
 * The host must preserve this minimum touch target in its generic renderer;
 * arbitrary CSS/height is intentionally not part of the app view protocol.
 * This constant is an acceptance expectation, not a view-tree instruction.
 */
export const IOU_ORIGINAL_CARD_TOUCH_TARGET_PX = IOU_CARD_STYLE.touchTarget;

const SPACING = { 0: "none", 8: "small", 16: "medium" } as const;
function palette(theme: "dark" | "light"): IouLocalCardViewPalette {
  const source = IOU_CARD_THEME_VARS[theme];
  return {
    background: source["--bg"], surface: source["--surface"], field: source["--surface-2"],
    text: source["--text"], muted: source["--text-dim"], border: source["--border"], accent: source["--accent"],
  };
}

/**
 * No payload, private roster, account or read-only argument is accepted. Readonly
 * must be enforced independently by the host, using the same field bindings.
 * In particular, this tree never snapshots values into app-authored text nodes.
 */
export function createIouLocalCardView(): IouLocalCardViewV1 {
  return {
    version: 1,
    theme: {
      dark: palette("dark"),
      light: palette("light"),
    },
    nodes: [{
      kind: "group", gap: "none", padding: SPACING[IOU_CARD_STYLE.outerPadding],
      children: [{
        kind: "group", gap: SPACING[IOU_CARD_STYLE.rowGap], padding: SPACING[IOU_CARD_STYLE.cardPadding], surface: "card", radius: "medium",
        children: [
          { kind: "row", gap: SPACING[IOU_CARD_STYLE.rowGap], children: [
            { kind: "field", field: "amount", minWidth: 96 },
            { kind: "field", field: "currency", minWidth: 96 },
            { kind: "field", field: "direction", minWidth: 124 },
          ] },
          { kind: "row", gap: SPACING[IOU_CARD_STYLE.rowGap], children: [
            { kind: "field", field: "kind", minWidth: 108 },
            { kind: "field", field: "typeId", minWidth: 128 },
            { kind: "field", field: "date", minWidth: 112 },
          ] },
          { kind: "field", field: "note", fullWidth: true, control: "single-line" },
        ],
      }],
    }],
  };
}
