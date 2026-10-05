/** Original PR card presentation shared by its React page and inert local metadata.
 * Values are paint/layout only: no payload, model, transport or delivery authority.
 */
export const IOU_CARD_STYLE = Object.freeze({
  outerPadding: 16,
  cardPadding: 16,
  cardRadius: 14,
  cardMaxWidth: 460,
  cardShadow: "0 1px 3px rgba(0,0,0,0.35)",
  rowGap: 8,
  labelControlGap: 2,
  labelFontSize: "0.6875rem",
  controlFontSize: "0.9375rem",
  controlPadding: "7px 10px",
  controlRadius: 10,
  touchTarget: 44,
} as const);

export const IOU_CARD_THEME_VARS = {
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
} as const;
