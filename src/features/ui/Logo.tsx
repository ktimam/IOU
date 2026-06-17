// IOU brand mark — the "locked O".
//
// The wordmark spells I O U, with the O rendered as a keyhole: a nod to
// the app's promise that the ledger is encrypted and yours alone. Strokes
// use currentColor so the mark recolors with `color` (defaults to the mint
// accent). IOUMark is the square emblem used for the favicon / app tile.

type WordmarkProps = { height?: number; className?: string; title?: string };

export function IOUWordmark({
  height = 40,
  className,
  title = "IOU",
}: WordmarkProps) {
  return (
    <svg
      className={className}
      height={height}
      viewBox="0 0 140 56"
      role="img"
      aria-label={title}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ color: "var(--accent)", display: "block" }}
    >
      <g
        stroke="currentColor"
        strokeWidth="8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <line x1="18" y1="12" x2="18" y2="44" />
        <circle cx="64" cy="28" r="16" />
        <path d="M98 12 V28 a13 13 0 0 0 26 0 V12" />
      </g>
      <g fill="currentColor" stroke="none">
        <circle cx="64" cy="24" r="3.2" />
        <path d="M62 26 L60.6 34 L67.4 34 L66 26 Z" />
      </g>
    </svg>
  );
}

type MarkProps = { size?: number; className?: string; title?: string };

export function IOUMark({ size = 40, className, title = "IOU" }: MarkProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label={title}
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: "block" }}
    >
      <rect
        x="1.5"
        y="1.5"
        width="61"
        height="61"
        rx="15"
        fill="#11261F"
        stroke="#5FE3B3"
        strokeWidth="2"
      />
      <circle cx="32" cy="30" r="14" fill="none" stroke="#5FE3B3" strokeWidth="5" />
      <circle cx="32" cy="26.5" r="3.3" fill="#5FE3B3" />
      <path d="M30 29 L28.5 37 L35.5 37 L34 29 Z" fill="#5FE3B3" />
    </svg>
  );
}
